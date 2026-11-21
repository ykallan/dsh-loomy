/**
 * 讯飞账号服务客户端：登录（密码 / 短信）、用户信息、登出。
 *
 * 与 DevEco 那种「浏览器授权 + 本机回环回调」完全不同，这里是**服务端直接登录**：
 *
 * ```
 * POST /login/account/getPuKey   → {pukey, rcode}   rcode 是服务端 nonce，不是验证码
 * POST /login/account/byPwd      → {session, userid, phone}
 * ```
 *
 * 密码用 `pukey` 做 RSA/PKCS#1 v1.5 加密，请求本身用客户端常量签名（`signer.ts`）。
 * 登录换来的是 **14 天会话**，模型网关把它当 Bearer 用；上游**不发 refresh token**，
 * 所以续期的唯一办法就是拿存着的密码再登一次 —— 这也是为什么账号必须存密码才能无人值守。
 *
 * 短信登录（`sendMsgCode` → `checkCode`）只是为了在「还没设密码」的账号上拿到一次会话；
 * 验证码要人读，所以它不适合当日常续期手段。
 *
 * @module dsh-loomy/login
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  ACCOUNT_PATHS,
  CONTROL_TIMEOUT_MS,
  LOOMY_ACCOUNT_APPID,
  LOOMY_CAMPUS_DEVICE_PREFIX,
  LOOMY_CLIENT_UA,
  LOOMY_DEVICE_ID,
  LOOMY_ENVELOPE_VERSION,
  LOOMY_WEB_MODEL_ID,
  SESSION_EXPIRE_SECONDS,
  SESSION_TTL_MS,
  accessKey,
  accountBase,
} from './config.ts'
import { rsaEncrypt } from './rsa.ts'
import { buildAccountHeaders } from './signer.ts'

/** 登录失败的分类，卡片按它给不同文案。 */
export type LoginFailureKind = 'credentials' | 'sms' | 'network' | 'server'

/** 带分类的登录错误。 */
export class LoginError extends Error {
  readonly kind: LoginFailureKind

  constructor(kind: LoginFailureKind, message: string) {
    super(message)
    this.name = 'LoginError'
    this.kind = kind
  }
}

/** 每条请求信封里「这台设备是谁」的那几个字段。`traceid` 不在这里（每条请求都新生成）。 */
export interface LoomyIdentity {
  /** 设备 id；`per_account` 模式下每个账号一个 `web-<16 hex>`。 */
  devid: string
  ua: string
  modelid: string
  version: string
  /** 促销设备的 id（只出现在 `/points/*` 的 body 里，聊天请求不带）。 */
  campusDeviceId?: string
  /** 生成时间（epoch ms）。 */
  createdAt: number
}

/** 设备标识的生成模式。 */
export type IdentityMode = 'per_account' | 'client'

/** 造一个设备标识。 */
export function newIdentity(mode: IdentityMode = 'per_account', now: number = Date.now()): LoomyIdentity {
  if (mode === 'client') {
    return {
      devid: LOOMY_DEVICE_ID,
      ua: LOOMY_CLIENT_UA,
      modelid: LOOMY_WEB_MODEL_ID,
      version: LOOMY_ENVELOPE_VERSION,
      createdAt: now,
    }
  }
  return {
    devid: `web-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    ua: LOOMY_CLIENT_UA,
    modelid: LOOMY_WEB_MODEL_ID,
    version: LOOMY_ENVELOPE_VERSION,
    campusDeviceId: `${LOOMY_CAMPUS_DEVICE_PREFIX}${randomUUID()}`,
    createdAt: now,
  }
}

/** 32 位十六进制 trace id。 */
export function traceId(): string {
  return randomUUID().replace(/-/g, '')
}

/** 一次登录拿到的东西。 */
export interface LoomyLoginResult {
  session: string
  userid?: string
  phone?: string
  obtainedAt: number
  expireAt: number
}

/** `call()` 的可选项。 */
export interface AccountCallOptions {
  /** 覆盖设备标识（不传就用缺省的客户端值）。 */
  identity?: LoomyIdentity
  signal?: AbortSignal
  timeoutMs?: number
}

/** 一次性可注入的依赖（测试打本地假上游）。 */
export interface AccountServiceOptions {
  baseUrl?: string
  accessKeyId?: string
  accessKeySecret?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** 从上游响应里抠出可读文本。 */
function errorText(payload: Record<string, unknown>, status: number): string {
  for (const key of ['desc', 'message', 'msg', 'error']) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return `HTTP ${status}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 账号服务客户端。
 *
 * `call()` 是所有路径的唯一出口：签名、信封、错误归类都在这里，别在别处再拼一次。
 */
export class AccountService {
  private readonly baseUrl: string
  private readonly akId: string
  private readonly akSecret: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: AccountServiceOptions = {}) {
    const keys = accessKey()
    this.baseUrl = (options.baseUrl ?? accountBase()).replace(/\/$/, '')
    this.akId = options.accessKeyId ?? keys.id
    this.akSecret = options.accessKeySecret ?? keys.secret
    this.timeoutMs = options.timeoutMs ?? CONTROL_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  /** 请求信封的 `base` 字段。 */
  private envelope(identity: LoomyIdentity | undefined): Record<string, string> {
    return {
      appid: LOOMY_ACCOUNT_APPID,
      modelid: identity?.modelid ?? LOOMY_WEB_MODEL_ID,
      version: identity?.version ?? LOOMY_ENVELOPE_VERSION,
      devid: identity?.devid ?? LOOMY_DEVICE_ID,
      ua: identity?.ua ?? LOOMY_CLIENT_UA,
      // 真客户端每条请求都换 traceid，这里照做。
      traceid: traceId(),
    }
  }

  /**
   * 发一个账号服务请求。
   *
   * body 为空时**不带** `Content-Type` 之外的 body，也不带 `Content-MD5`，
   * 但签名里的那一行仍然是空串（见 `signer.ts`）。
   */
  async call(
    path: string,
    body: Record<string, unknown> | undefined,
    options: AccountCallOptions = {},
  ): Promise<Record<string, unknown>> {
    const payload = body === undefined
      ? ''
      : JSON.stringify({ base: this.envelope(options.identity), ...body })
    const headers = buildAccountHeaders({
      accessKeyId: this.akId,
      accessKeySecret: this.akSecret,
      method: 'POST',
      path,
      body: payload,
    })
    headers['User-Agent'] = LOOMY_CLIENT_UA
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs)
    timer.unref?.()
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true })
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        ...payload === '' ? {} : { body: payload },
        signal: controller.signal,
      })
    } catch (error: unknown) {
      throw new LoginError(
        'network',
        `account service unreachable: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      clearTimeout(timer)
    }
    const text = await response.text().catch(() => '')
    let parsed: Record<string, unknown> = {}
    if (text.trim() !== '') {
      try {
        const value = JSON.parse(text) as unknown
        if (isObject(value)) parsed = value
      } catch {
        throw new LoginError(
          'server',
          `account service returned HTTP ${response.status}: ${text.slice(0, 200)}`,
        )
      }
    }
    const code = typeof parsed.code === 'string' ? parsed.code : String(parsed.errorCode ?? '')
    if (code !== '' && code !== '000000') {
      throw new LoginError(
        code.startsWith('1000') ? 'network' : 'server',
        `${path} failed: ${errorText(parsed, response.status)} (code ${code})`,
      )
    }
    if (!response.ok) {
      throw new LoginError(
        response.status >= 500 ? 'network' : 'server',
        `${path} failed with HTTP ${response.status}: ${errorText(parsed, response.status)}`,
      )
    }
    return parsed
  }

  /** `pukey`（base64 DER）与 `rcode`（服务端 nonce）。 */
  async getPublicKey(options: AccountCallOptions = {}): Promise<{ pukey: string; rcode: string }> {
    const payload = await this.call(ACCOUNT_PATHS.publicKey, {}, options)
    const data = isObject(payload.data) ? payload.data : payload
    const pukey = typeof data.pukey === 'string' ? data.pukey : ''
    const rcode = typeof data.rcode === 'string' ? data.rcode : ''
    if (pukey === '') throw new LoginError('server', 'getPuKey returned no public key')
    return { pukey, rcode }
  }

  /** 手机号 + 密码登录。 */
  async loginByPassword(
    loginid: string,
    password: string,
    options: AccountCallOptions = {},
  ): Promise<LoomyLoginResult> {
    const phone = loginid.trim()
    if (phone === '') throw new LoginError('credentials', 'the phone number is required')
    if (password === '') throw new LoginError('credentials', 'the password is required')
    const { pukey, rcode } = await this.getPublicKey(options)
    let encrypted: string
    try {
      encrypted = rsaEncrypt(pukey, password)
    } catch (error: unknown) {
      throw new LoginError('credentials', error instanceof Error ? error.message : String(error))
    }
    const payload = await this.call(ACCOUNT_PATHS.loginByPassword, {
      param: {
        loginid: phone,
        password: encrypted,
        rcode,
        type: 1,
        expire: SESSION_EXPIRE_SECONDS,
      },
    }, options)
    return readLoginResult(payload, phone)
  }

  /** 发短信验证码，返回 `msgid`（下一步要用）。 */
  async sendSmsCode(phone: string, options: AccountCallOptions = {}): Promise<string> {
    const payload = await this.call(ACCOUNT_PATHS.sendSms, {
      param: { ccode: '86', phone: phone.trim(), expire: 300 },
    }, options)
    const data = isObject(payload.data) ? payload.data : payload
    const msgid = typeof data.msgid === 'string' ? data.msgid : ''
    if (msgid === '') throw new LoginError('sms', 'sendMsgCode returned no msgid')
    return msgid
  }

  /** 用验证码换会话。 */
  async loginBySms(
    phone: string,
    code: string,
    msgid: string,
    options: AccountCallOptions = {},
  ): Promise<LoomyLoginResult> {
    const payload = await this.call(ACCOUNT_PATHS.loginBySms, {
      param: {
        ccode: '86',
        phone: phone.trim(),
        mcode: code.trim(),
        msgid,
        expire: SESSION_EXPIRE_SECONDS,
      },
    }, options)
    return readLoginResult(payload, phone)
  }

  /** 用户信息（会话是否还有效的旁证）。 */
  async baseInfo(session: string, options: AccountCallOptions = {}): Promise<Record<string, unknown>> {
    const payload = await this.call(ACCOUNT_PATHS.baseInfo, { param: { session } }, options)
    return isObject(payload.data) ? payload.data : payload
  }

  /** 主动登出（删账号时尽力调用，失败不影响本地删除）。 */
  async logout(session: string, options: AccountCallOptions = {}): Promise<void> {
    await this.call(ACCOUNT_PATHS.logout, { param: { session } }, options)
  }
}

/** 从登录响应里取 `session` / `userid` / `phone`，形状不对就报清楚。 */
export function readLoginResult(payload: Record<string, unknown>, fallbackPhone: string): LoomyLoginResult {
  const node = isObject(payload.data) ? payload.data : payload
  const session = typeof node.session === 'string' ? node.session : ''
  if (session === '') {
    throw new LoginError('credentials', 'the account service accepted the login but returned no session')
  }
  const userid = typeof node.userid === 'string'
    ? node.userid
    : typeof node.userId === 'string' ? node.userId : undefined
  const phone = typeof node.phone === 'string' && node.phone !== '' ? node.phone : fallbackPhone
  const obtainedAt = Date.now()
  return {
    session,
    ...userid === undefined || userid === '' ? {} : { userid },
    ...phone === '' ? {} : { phone },
    obtainedAt,
    expireAt: obtainedAt + SESSION_TTL_MS,
  }
}

/** 账号在文档里的自然键：`userid` → 手机号 → 会话哈希。 */
export function accountKeyOf(account: {
  userid?: string
  loginid?: string
  session?: string
}): string {
  if (account.userid !== undefined && account.userid !== '') return account.userid
  if (account.loginid !== undefined && account.loginid !== '') return account.loginid
  const seed = account.session ?? ''
  return `s${createHash('sha256').update(seed).digest('hex').slice(0, 15)}`
}

/** 手机号打码（`138****0000`），卡片上不印完整号码。 */
export function maskPhone(phone: string | undefined): string | undefined {
  if (phone === undefined) return undefined
  const trimmed = phone.trim()
  if (trimmed.length < 7) return trimmed === '' ? undefined : trimmed
  return `${trimmed.slice(0, 3)}****${trimmed.slice(-4)}`
}
