/**
 * Loomy 账号文档 + 会话生命周期。
 *
 * 上游只发**一种**凭证：登录换来的 14 天会话（`docs/PROTOCOL.md` 第 2 节）。它同时是
 * 账号服务和模型网关的 Bearer；**没有 refresh token**。所以凭证的生命周期只有一条路：
 * 快过期就拿存着的手机号+密码再登一次。
 *
 * | 情况 | 处理 |
 * |---|---|
 * | 有密码、会话有效 | 直接用 |
 * | 有密码、会话快过期（< 3 天） | 静默重登（单飞 + 代际） |
 * | 有密码、会话已失效 | 重登；失败进冷却，不把账号写成死号 |
 * | 没密码（粘贴会话） | 到期或被上游 401 → 标 `needsLogin`，等用户重新粘贴 |
 *
 * 单飞是必须的：同一账号并发重登会互相覆盖会话，后到的那次还可能把刚换好的会话当成
 * 「旧值」写回去。代际计数负责「期间有没有人登录过」。
 *
 * @module dsh-loomy/accounts
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  LOGIN_COOLDOWN_MS,
  SESSION_RENEW_BEFORE_MS,
  SESSION_TTL_MS,
} from './config.ts'
import {
  AccountService,
  LoginError,
  accountKeyOf,
  maskPhone,
  newIdentity,
  type IdentityMode,
  type LoomyIdentity,
  type LoomyLoginResult,
} from './login.ts'

/** 一条账号记录（落盘的那份）。 */
export interface LoomyAccount {
  /** 用户可改的备注名。 */
  label?: string
  /** 登录用的手机号。 */
  loginid?: string
  /** 登录用的密码（明文，`0600` 存的；没有就走「粘贴会话」模式）。 */
  password?: string
  /** 14 天会话，模型网关的 Bearer。 */
  session?: string
  /** 上游给的 userid。 */
  userid?: string
  /** 会话拿到的时间（epoch ms）。 */
  obtainedAt?: number
  /** 会话到期时刻（epoch ms）。上游不告诉我们，按 14 天推。 */
  expireAt?: number
  /** 该账号自己的设备标识。 */
  identity: LoomyIdentity
  /** 用户手动暂停（不参与轮转）。 */
  paused?: boolean
  /** 用户置顶（轮转优先）。 */
  pinned?: boolean
  /** 会话被上游否定、且没有密码可自动重登 —— 等用户重新登录。 */
  needsLogin?: boolean
  /** 首次落库时间。 */
  storedAt?: number
  /** 最近一次成功登录时间。 */
  lastLoginAt?: number
  /** 展示顺序里的人工名字是否由上游推断（诊断用）。 */
  source?: 'password' | 'sms' | 'session'
}

/** 账号文档（`.loomy-accounts.json`）。 */
export interface LoomyAccountDocument {
  version: 1
  order: string[]
  accounts: Record<string, LoomyAccount>
}

/** 卡片上一条账号摘要（**不含任何凭证**）。 */
export interface LoomyAccountSummary {
  id: string
  label?: string
  /** 打码后的手机号。 */
  loginid?: string
  userid?: string
  /** 这个号存了密码吗（存了才能无人值守续期）。 */
  hasPassword: boolean
  /** 会话还能不能用（没被标成 needsLogin，且没到期）。 */
  usable: boolean
  /** 需要重新登录（会话被拒/过期且无密码）。 */
  needsLogin: boolean
  /** 会话到期时刻（epoch ms）与剩余天数。 */
  sessionExpiresAt?: number
  sessionDaysLeft?: number
  /** 设备标识（只看得到 devid，够区分账号就行）。 */
  devid: string
  paused: boolean
  pinned: boolean
  storedAt?: number
  lastLoginAt?: number
  source?: 'password' | 'sms' | 'session'
}

/** 解析出来的、够发一次请求的东西。 */
export interface ResolvedLoomyAccount {
  id: string
  account: LoomyAccount
  session: string
}

/** 数据目录：默认 `~/.dsh`（与宿主一致），可用 `DSH_HOME` 覆盖。 */
export function loomyHome(home?: string): string {
  return home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 多账号文档路径。 */
export function loomyAccountsPath(home?: string): string {
  return join(loomyHome(home), '.loomy-accounts.json')
}

/** 用量台账路径。 */
export function loomyUsagePath(home?: string): string {
  return join(loomyHome(home), '.loomy-usage.json')
}

/** 登录/续期失败日志路径（宿主对插件 debug 日志没有出口，失败原因只能自己留档）。 */
export function loomyRefreshLogPath(home?: string): string {
  return join(loomyHome(home), '.loomy-refresh.log')
}

/** 原子写 JSON（临时文件 + rename），并尽力收紧到 0600。 */
function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows 上 chmod 只影响只读位，失败无所谓。
  }
}

function readJsonFile<T>(path: string): T | undefined {
  try {
    if (!existsSync(path)) return undefined
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** 会话剩余寿命（毫秒）；没有会话或已过期 ≤ 0。 */
export function sessionRemainingMs(account: LoomyAccount, now: number = Date.now()): number {
  if (typeof account.session !== 'string' || account.session === '') return 0
  const expireAt = account.expireAt
  if (typeof expireAt !== 'number' || !Number.isFinite(expireAt) || expireAt <= 0) return SESSION_TTL_MS
  return expireAt - now
}

/** 账号能不能被派活（不暂停、不待登录）。 */
export function accountDispatchable(account: LoomyAccount): boolean {
  if (account.paused === true) return false
  if (account.needsLogin === true) return false
  return true
}

/** 生成一条账号摘要。 */
export function summarizeAccount(id: string, account: LoomyAccount, now: number = Date.now()): LoomyAccountSummary {
  const remaining = sessionRemainingMs(account, now)
  const usable = account.needsLogin !== true && remaining > 0
  return {
    id,
    ...account.label === undefined ? {} : { label: account.label },
    ...account.loginid === undefined ? {} : { loginid: maskPhone(account.loginid) },
    ...account.userid === undefined ? {} : { userid: account.userid },
    hasPassword: typeof account.password === 'string' && account.password !== '',
    usable,
    needsLogin: account.needsLogin === true || remaining <= 0,
    ...account.expireAt === undefined ? {} : { sessionExpiresAt: account.expireAt },
    ...remaining > 0 ? { sessionDaysLeft: Math.round((remaining / 86_400_000) * 10) / 10 } : {},
    devid: account.identity?.devid ?? '',
    paused: account.paused === true,
    pinned: account.pinned === true,
    ...account.storedAt === undefined ? {} : { storedAt: account.storedAt },
    ...account.lastLoginAt === undefined ? {} : { lastLoginAt: account.lastLoginAt },
    ...account.source === undefined ? {} : { source: account.source },
  }
}

/**
 * 一个账号的运行时外壳：会话解析 + 单飞重登。
 *
 * 它不改文档，只把「新的账号记录」通过 `persist` 交回去 —— 谁拥有文档谁落盘。
 */
class AccountSlot {
  private account: LoomyAccount
  private inflight: Promise<string | undefined> | undefined
  private generation = 0
  private blockedUntil = 0
  private readonly service: AccountService
  private readonly persist: (next: LoomyAccount) => void
  private readonly log: ((message: string) => void) | undefined

  constructor(
    account: LoomyAccount,
    service: AccountService,
    persist: (next: LoomyAccount) => void,
    log?: (message: string) => void,
  ) {
    this.account = account
    this.service = service
    this.persist = persist
    this.log = log
  }

  current(): LoomyAccount {
    return this.account
  }

  /** 外部改了文档（重新登录/改备注/暂停）时同步进来。 */
  replace(account: LoomyAccount): void {
    this.account = account
    this.generation += 1
    this.blockedUntil = 0
  }

  /** 能否用密码自动续期。 */
  private canRelogin(): boolean {
    return typeof this.account.loginid === 'string' && this.account.loginid !== ''
      && typeof this.account.password === 'string' && this.account.password !== ''
  }

  /**
   * 要一个可用的会话。
   *
   * @returns 会话；确实需要人工重新登录时 undefined（并已把账号标成 needsLogin）。
   */
  async session(): Promise<string | undefined> {
    const remaining = sessionRemainingMs(this.account)
    const hasSession = typeof this.account.session === 'string' && this.account.session !== ''
    const rejected = this.account.needsLogin === true
    // 还没被上游否掉、而且离到期还远：直接用，不打上游。
    if (!rejected && hasSession && remaining > SESSION_RENEW_BEFORE_MS) return this.account.session
    if (!this.canRelogin()) {
      if (!rejected && hasSession && remaining > 0) return this.account.session
      this.markNeedsLogin('the session expired and this account has no stored password')
      return undefined
    }
    if (Date.now() < this.blockedUntil) {
      // 冷却中：还能用就先用着，别把好好的账号判死。
      return !rejected && remaining > 0 ? this.account.session : undefined
    }
    this.inflight ??= this.relogin().finally(() => {
      this.inflight = undefined
    })
    const outcome = await this.inflight
    if (outcome !== undefined) return outcome
    return sessionRemainingMs(this.account) > 0 ? this.account.session : undefined
  }

  /** 强制重登一次（卡片「重新登录」/ 401 之后）。 */
  async forceRelogin(): Promise<boolean> {
    if (!this.canRelogin()) return false
    this.inflight ??= this.relogin(true).finally(() => {
      this.inflight = undefined
    })
    return (await this.inflight) !== undefined
  }

  private async relogin(force = false): Promise<string | undefined> {
    const generation = this.generation
    const loginid = this.account.loginid ?? ''
    const password = this.account.password ?? ''
    try {
      const result = await this.service.loginByPassword(loginid, password, {
        identity: this.account.identity,
      })
      if (generation !== this.generation) {
        // 期间有人手工登录过：以新的为准，别拿旧结果盖掉。
        return this.account.session
      }
      const next = applyLoginResult(this.account, result)
      this.account = next
      this.generation += 1
      this.blockedUntil = 0
      this.persist(next)
      return result.session
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (generation === this.generation) {
        this.blockedUntil = Date.now() + LOGIN_COOLDOWN_MS
        this.log?.(`renewal failed for ${loginid === '' ? 'account' : maskPhone(loginid) ?? loginid}: ${message}`)
        // 「密码错了」是硬错误：再试也没用。但如果手里还有没过期的会话，就先把最后这段
        // 有效期用完（卡片上的剩余天数是可见的）；确实没会话可用时才标成待登录。
        const hard = error instanceof LoginError && error.kind === 'credentials'
        const stillValid = sessionRemainingMs(this.account) > 0
        if ((hard && !stillValid) || force) this.markNeedsLogin(message)
      }
      return undefined
    }
  }

  private markNeedsLogin(reason: string): void {
    if (this.account.needsLogin === true) return
    this.account = { ...this.account, needsLogin: true }
    this.generation += 1
    this.persist(this.account)
    this.log?.(`account marked needs-login: ${reason}`)
  }

  /** 上游明确否定了这个会话（401/403）。 */
  noteRejected(reason: string): void {
    if (this.canRelogin()) {
      // 有密码就交给下一次 session() 去重登，不在这里判死。
      this.account = { ...this.account, needsLogin: false, expireAt: Date.now() }
      this.generation += 1
      this.persist(this.account)
      this.blockedUntil = 0
      this.log?.(`session rejected (${reason}); will sign in again with the stored password`)
      return
    }
    this.markNeedsLogin(reason)
  }
}

/** 把一次登录结果合进账号记录。 */
export function applyLoginResult(
  account: LoomyAccount,
  result: LoomyLoginResult,
): LoomyAccount {
  return {
    ...account,
    session: result.session,
    obtainedAt: result.obtainedAt,
    expireAt: result.expireAt,
    lastLoginAt: result.obtainedAt,
    needsLogin: false,
    ...result.userid === undefined || result.userid === '' ? {} : { userid: result.userid },
    ...result.phone === undefined || result.phone === '' ? {} : { loginid: account.loginid ?? result.phone },
  }
}

export interface LoomyAccountStoreOptions {
  /** 注入账号服务（测试用假实现）。 */
  service?: AccountService
  /** 设备标识模式。 */
  identityMode?: IdentityMode
  log?: (message: string) => void
  now?: () => number
}

/**
 * 多账号文档。
 *
 * 文档只管「存了什么」，能不能接活由池（`account-pool.ts`）决定；会话解析在这一层，
 * 因为单飞必须按账号做，而池不该碰凭证。
 */
export class LoomyAccountStore {
  private readonly path: string
  private readonly service: AccountService
  private readonly identityMode: IdentityMode
  private readonly log: ((message: string) => void) | undefined
  private readonly now: () => number
  private document: LoomyAccountDocument | undefined
  private loading: Promise<void> | undefined
  private readonly slots = new Map<string, AccountSlot>()

  constructor(path: string, options: LoomyAccountStoreOptions = {}) {
    this.path = path
    this.service = options.service ?? new AccountService()
    this.identityMode = options.identityMode ?? 'per_account'
    this.log = options.log
    this.now = options.now ?? (() => Date.now())
  }

  /** 当前磁盘路径（部署/诊断用）。 */
  get documentPath(): string {
    return this.path
  }

  /** 账号服务客户端（卡片「发送验证码」也要用）。 */
  get accountService(): AccountService {
    return this.service
  }

  private async ensureLoaded(): Promise<void> {
    if (this.document !== undefined) return
    this.loading ??= this.load()
    await this.loading
  }

  private async load(): Promise<void> {
    const raw = readJsonFile<Partial<LoomyAccountDocument>>(this.path)
    const accounts: Record<string, LoomyAccount> = {}
    for (const [id, value] of Object.entries(raw?.accounts ?? {})) {
      if (value === null || typeof value !== 'object') continue
      const account = value as LoomyAccount
      // 既没有会话也没有密码的记录永远无法发请求，留在列表里只会是一条点不动的死行。
      const hasSession = typeof account.session === 'string' && account.session !== ''
      const hasPassword = typeof account.password === 'string' && account.password !== ''
      if (!hasSession && !hasPassword) continue
      accounts[id] = {
        ...account,
        identity: account.identity ?? newIdentity(this.identityMode, this.now()),
      }
    }
    const order = Array.isArray(raw?.order)
      ? raw.order.filter((id): id is string => typeof id === 'string' && accounts[id] !== undefined)
      : []
    for (const id of Object.keys(accounts)) if (!order.includes(id)) order.push(id)
    this.document = { version: 1, order, accounts }
  }

  private get doc(): LoomyAccountDocument {
    this.document ??= { version: 1, order: [], accounts: {} }
    return this.document
  }

  private flush(): void {
    writeJsonAtomic(this.path, this.doc)
  }

  private slot(id: string, account: LoomyAccount): AccountSlot {
    const existing = this.slots.get(id)
    if (existing !== undefined) return existing
    const slot = new AccountSlot(account, this.service, next => {
      this.doc.accounts[id] = next
      this.flush()
    }, this.log)
    this.slots.set(id, slot)
    return slot
  }

  /** 账号摘要列表（按文档顺序）。 */
  async list(): Promise<LoomyAccountSummary[]> {
    await this.ensureLoaded()
    const doc = this.doc
    return doc.order
      .map(id => {
        const account = doc.accounts[id]
        return account === undefined ? undefined : summarizeAccount(id, account, this.now())
      })
      .filter((entry): entry is LoomyAccountSummary => entry !== undefined)
  }

  /** 账号 id 列表（文档顺序）。 */
  async ids(): Promise<string[]> {
    await this.ensureLoaded()
    return [...this.doc.order]
  }

  /** 能参与轮转的账号 id（排除暂停与待登录）。 */
  async dispatchIds(): Promise<string[]> {
    await this.ensureLoaded()
    const doc = this.doc
    return doc.order.filter(id => {
      const account = doc.accounts[id]
      return account !== undefined && accountDispatchable(account)
    })
  }

  /** 某个账号的记录副本。 */
  async account(id: string): Promise<LoomyAccount | undefined> {
    await this.ensureLoaded()
    const account = this.doc.accounts[id]
    return account === undefined ? undefined : { ...account }
  }

  /** 有没有任何账号。 */
  async hasAny(): Promise<boolean> {
    return (await this.ids()).length > 0
  }

  /** 写入/更新一个账号，返回账号 id。 */
  async upsert(account: LoomyAccount, id?: string): Promise<string> {
    await this.ensureLoaded()
    const doc = this.doc
    const key = id ?? accountKeyOf(account)
    const previous = doc.accounts[key]
    const next: LoomyAccount = {
      ...account,
      identity: account.identity ?? newIdentity(this.identityMode, this.now()),
      storedAt: previous?.storedAt ?? account.storedAt ?? this.now(),
      // 重新登录不该把用户自己的偏好清掉。
      ...previous?.label === undefined ? {} : { label: account.label ?? previous.label },
      ...previous?.paused === undefined ? {} : { paused: previous.paused },
      ...previous?.pinned === undefined ? {} : { pinned: previous.pinned },
    }
    doc.accounts[key] = next
    if (!doc.order.includes(key)) doc.order.push(key)
    this.slots.get(key)?.replace(next)
    this.flush()
    return key
  }

  /**
   * 用手机号+密码登录并落库。
   *
   * 手机号就是自然键（同一个号重新登录不该多出一条记录）；但如果这个号已经有一条
   * `userid` 不同的记录，就按 `userid` 合并 —— 换个手机号登录同一个账号也不会重复。
   */
  async signInWithPassword(options: {
    loginid: string
    password: string
    label?: string
    id?: string
  }): Promise<{ id: string; account: LoomyAccount }> {
    await this.ensureLoaded()
    const phone = options.loginid.trim()
    const existingId = options.id ?? await this.findByPhone(phone)
    const identity = existingId === undefined
      ? newIdentity(this.identityMode, this.now())
      : (this.doc.accounts[existingId]?.identity ?? newIdentity(this.identityMode, this.now()))
    const result = await this.service.loginByPassword(phone, options.password, { identity })
    const base: LoomyAccount = {
      loginid: phone,
      password: options.password,
      identity,
      source: 'password',
      ...options.label === undefined || options.label.trim() === '' ? {} : { label: options.label.trim() },
      storedAt: this.now(),
    }
    const merged = applyLoginResult(base, result)
    const id = await this.upsert(merged, existingId)
    return { id, account: { ...(this.doc.accounts[id] as LoomyAccount) } }
  }

  /** 用短信验证码登录并落库（没设密码的账号只能这样拿一次会话）。 */
  async signInWithSms(options: {
    loginid: string
    code: string
    msgid: string
    label?: string
    id?: string
  }): Promise<{ id: string; account: LoomyAccount }> {
    await this.ensureLoaded()
    const phone = options.loginid.trim()
    const existingId = options.id ?? await this.findByPhone(phone)
    const previous = existingId === undefined ? undefined : this.doc.accounts[existingId]
    const identity = previous?.identity ?? newIdentity(this.identityMode, this.now())
    const result = await this.service.loginBySms(phone, options.code, options.msgid, { identity })
    const base: LoomyAccount = {
      loginid: phone,
      // 短信登录不带来密码，但已有密码要留着（不然就丢了无人值守续期能力）。
      ...previous?.password === undefined ? {} : { password: previous.password },
      identity,
      source: previous?.password === undefined ? 'sms' : 'password',
      ...options.label === undefined || options.label.trim() === '' ? {} : { label: options.label.trim() },
      storedAt: this.now(),
    }
    const merged = applyLoginResult(base, result)
    const id = await this.upsert(merged, existingId)
    return { id, account: { ...this.doc.accounts[id] } }
  }

  /** 粘贴一个已有会话（没有密码，到期只能人工再来一次）。 */
  async addSession(options: {
    session: string
    label?: string
    loginid?: string
    userid?: string
    expireAt?: number
    id?: string
  }): Promise<string> {
    await this.ensureLoaded()
    const session = options.session.trim()
    const now = this.now()
    const identity = options.id === undefined
      ? newIdentity(this.identityMode, now)
      : (this.doc.accounts[options.id]?.identity ?? newIdentity(this.identityMode, now))
    const account: LoomyAccount = {
      session,
      identity,
      obtainedAt: now,
      expireAt: options.expireAt ?? now + SESSION_TTL_MS,
      source: 'session',
      storedAt: now,
      ...options.loginid === undefined || options.loginid.trim() === '' ? {} : { loginid: options.loginid.trim() },
      ...options.userid === undefined || options.userid.trim() === '' ? {} : { userid: options.userid.trim() },
      ...options.label === undefined || options.label.trim() === '' ? {} : { label: options.label.trim() },
    }
    const key = options.id ?? accountKeyOf(account)
    return this.upsert(account, key)
  }

  /** 按手机号找账号 id。 */
  async findByPhone(phone: string): Promise<string | undefined> {
    await this.ensureLoaded()
    const trimmed = phone.trim()
    if (trimmed === '') return undefined
    return this.doc.order.find(id => this.doc.accounts[id]?.loginid === trimmed)
  }

  /** 补/改密码（粘贴会话的账号后来补了密码，就能自动续期了）。 */
  async setPassword(id: string, password: string): Promise<boolean> {
    await this.ensureLoaded()
    const account = this.doc.accounts[id]
    if (account === undefined) return false
    const trimmed = password.trim()
    const next: LoomyAccount = trimmed === ''
      ? (() => {
          const { password: _dropped, ...rest } = account
          return { ...rest, source: 'session' as const }
        })()
      : { ...account, password: trimmed, source: 'password' as const, needsLogin: false }
    this.doc.accounts[id] = next
    this.slots.get(id)?.replace(next)
    this.flush()
    return true
  }

  /** 删除一个账号。 */
  async remove(id: string): Promise<void> {
    await this.ensureLoaded()
    const doc = this.doc
    if (doc.accounts[id] === undefined) return
    delete doc.accounts[id]
    doc.order = doc.order.filter(entry => entry !== id)
    this.slots.delete(id)
    this.flush()
  }

  /** 清空所有账号。 */
  async clear(): Promise<void> {
    await this.ensureLoaded()
    this.document = { version: 1, order: [], accounts: {} }
    this.slots.clear()
    this.flush()
  }

  /** 暂停/恢复。 */
  async setPaused(id: string, paused: boolean): Promise<boolean> {
    return this.patch(id, { paused })
  }

  /** 置顶/取消置顶。 */
  async setPinned(id: string, pinned: boolean): Promise<boolean> {
    return this.patch(id, { pinned })
  }

  /** 改备注名。 */
  async setLabel(id: string, label: string): Promise<boolean> {
    const trimmed = label.trim()
    if (trimmed === '') return this.patch(id, { label: undefined })
    return this.patch(id, { label: trimmed })
  }

  private async patch(id: string, changes: Partial<LoomyAccount>): Promise<boolean> {
    await this.ensureLoaded()
    const account = this.doc.accounts[id]
    if (account === undefined) return false
    const next: LoomyAccount = { ...account, ...changes }
    if (changes.label === undefined) delete next.label
    this.doc.accounts[id] = next
    this.slots.get(id)?.replace(next)
    this.flush()
    return true
  }

  /**
   * 解析一个账号，拿到可直接用的会话（必要时静默重登）。
   *
   * @returns 会话；账号不存在、暂停或确实需要人工登录时 undefined。
   */
  async resolve(id: string): Promise<ResolvedLoomyAccount | undefined> {
    await this.ensureLoaded()
    const account = this.doc.accounts[id]
    if (account === undefined) return undefined
    if (account.paused === true) return undefined
    const slot = this.slot(id, account)
    const session = await slot.session()
    if (session === undefined || session === '') return undefined
    return { id, account: slot.current(), session }
  }

  /** 强制重登一个账号（卡片「重新登录」按钮）。 */
  async forceRelogin(id: string): Promise<boolean> {
    await this.ensureLoaded()
    const account = this.doc.accounts[id]
    if (account === undefined) return false
    return this.slot(id, account).forceRelogin()
  }

  /** 上游明确否定了这个会话：有密码就等着自动重登，没密码就标成待登录。 */
  async markRejected(id: string, reason: string): Promise<void> {
    await this.ensureLoaded()
    const account = this.doc.accounts[id]
    if (account === undefined) return
    this.slot(id, account).noteRejected(reason)
  }

  /** 从磁盘重读（另一个进程/用户手工改了文档时）。 */
  async reloadFromDisk(): Promise<boolean> {
    const before = JSON.stringify(this.doc)
    this.document = undefined
    this.loading = undefined
    this.slots.clear()
    await this.ensureLoaded()
    return JSON.stringify(this.doc) !== before
  }

  /**
   * 保活：把「会话快到期」的账号提前续掉。
   *
   * 会话是 14 天，用户可能一周不开 DSH —— 不保活的话下次开就要等一次登录。
   * 这一轮只续有密码的账号；没密码的账号到期只能人工再来，所以这里把它的剩余天数
   * 报出去让卡片提醒。
   */
  async keepAlive(): Promise<{ checked: number; refreshed: number; needsLogin: string[] }> {
    await this.ensureLoaded()
    let refreshed = 0
    const needsLogin: string[] = []
    for (const id of [...this.doc.order]) {
      const account = this.doc.accounts[id]
      if (account === undefined) continue
      if (account.paused === true) continue
      const slot = this.slot(id, account)
      const before = slot.current().session
      const session = await slot.session()
      if (session === undefined) {
        needsLogin.push(id)
        continue
      }
      if (session !== before) refreshed += 1
    }
    return { checked: this.doc.order.length, refreshed, needsLogin }
  }
}
