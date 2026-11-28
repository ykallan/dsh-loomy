/**
 * Loomy（讯飞桌面助手）的协议常量。
 *
 * 这一份是「上游事实」的唯一出处：两个主机名、路径、签名用的客户端常量、必需请求头、
 * 会话寿命、并发与超时默认值。业务代码只引用这里，不自己拼字符串 —— 上游换路径时
 * 只要改这一个文件。
 *
 * 两个上游是**分开**的（`docs/PROTOCOL.md` 第 1 节）：
 *
 * | 主机 | 干什么 | 鉴权 |
 * |---|---|---|
 * | `account.xfinfr.com` | 登录、发会话、用户信息 | HMAC-SHA1 签名（客户端常量） |
 * | `loomyad.xunfei.cn/api/v1` | OpenAI 兼容模型网关 | 登录会话当 Bearer |
 *
 * @module dsh-loomy/config
 */

import { LOOMY_VERSION } from './version.ts'

/** 模型网关（OpenAI 兼容）。 */
export const LOOMY_MODEL_BASE = 'https://loomyad.xunfei.cn/api/v1'

/** 账号服务（登录/用户信息）。 */
export const LOOMY_ACCOUNT_BASE = 'https://account.xfinfr.com'

/** 账号服务要求的 appid（客户端写死）。 */
export const LOOMY_ACCOUNT_APPID = 'GM3LOOMY'

/**
 * 账号服务的签名常量：官方客户端在 `resources/.env.prod` 里随安装包一起分发，
 * 本质是混淆而非保密。换客户端版本时可能失效，可用环境变量覆盖。
 */
export const LOOMY_ACCESS_KEY_ID = '2thryby66wxi53sk'
export const LOOMY_ACCESS_KEY_SECRET = 'zsak6eadrbawz683wf5r3m2snrwj868r'

/** 模型网关只检查 `loomy-version` 是否存在，这里跟客户端同版本。 */
export const LOOMY_CLIENT_VERSION = '0.9.38'

/** 请求信封里的设备字段（客户端缺省值）。 */
export const LOOMY_DEVICE_ID = 'web'
export const LOOMY_WEB_MODEL_ID = 'Web'
export const LOOMY_ENVELOPE_VERSION = '1.0.0'
export const LOOMY_CLIENT_UA = 'Loomy|Desktop|Electron|macOS'

/** 促销设备的 id 前缀（只出现在 `/points/*` 的 body 里，聊天请求不带）。 */
export const LOOMY_CAMPUS_DEVICE_PREFIX = 'loomy-campus-'

/** 客户端登录时显式申请的会话寿命：14 天，且**没有** refresh token。 */
export const SESSION_EXPIRE_SECONDS = 14 * 24 * 3600

/** 会话总寿命（毫秒）。 */
export const SESSION_TTL_MS = SESSION_EXPIRE_SECONDS * 1000

/** 剩余寿命少于这个值就提前用密码重登一次。 */
export const SESSION_RENEW_BEFORE_MS = 3 * 24 * 3600 * 1000

/** 重登失败后的冷却，避免每个请求都去打登录接口。 */
export const LOGIN_COOLDOWN_MS = 60_000

/** 账号服务请求超时。 */
export const CONTROL_TIMEOUT_MS = 20_000

/** 模型目录请求超时。 */
export const CATALOG_TIMEOUT_MS = 15_000

/** 点数（额度）请求超时。 */
export const POINTS_TIMEOUT_MS = 15_000

/** 等上游开流时的空闲上限：沉默这么久才判死（不能用总时长超时）。 */
export const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 120_000

/** 队列/并发默认值：上游限流不透明，本地先自己排队。 */
export const DEFAULT_MAX_CONCURRENCY = 1
export const DEFAULT_MAX_QUEUE = 3
export const DEFAULT_QUEUE_COOLDOWN_MS = 500

/** 上游没声明上限时的兜底。 */
export const DEFAULT_CONTEXT_WINDOW = 32_768
export const DEFAULT_MAX_TOKENS = 8_192

/** 上游不认识模型 id 时会**静默回退**到这条，所以必须自己校验（见 `docs/PROTOCOL.md`）。 */
export const DEFAULT_MODEL = 'deepseek-v4-flash-0731'

/** 一次请求最多换几个账号（每个账号只试一次）。 */
export const MAX_ACCOUNT_ATTEMPTS = 3

/** 账号服务路径。 */
export const ACCOUNT_PATHS = {
  publicKey: '/login/account/getPuKey',
  loginByPassword: '/login/account/byPwd',
  sendSms: '/login/phone/sendMsgCode',
  loginBySms: '/login/phone/checkCode',
  logout: '/login/account/logout',
  baseInfo: '/userinfo/query/baseInfo',
} as const

/** 模型网关路径。 */
export const MODEL_PATHS = {
  models: '/models',
  chat: '/chat/completions',
  points: '/points/records',
  /**
   * 每日签到。名字叫 `first-login`，实际语义是「开始今天的计费周期」：把每日赠送
   * 续满，同一个自然日内重复调用幂等（应答里 `alreadyProcessed: true`）。
   * 官方客户端每次登录都会发这一次请求（`docs/PROTOCOL.md` 第 5 节）。
   */
  firstLogin: '/points/first-login',
} as const

/** 聊天请求的用途标记（上游按它记点数）。 */
export const REQUEST_PURPOSE = 'chat.message'

/** 环境变量读取（空串视作未设置）。 */
export function envText(name: string, fallback: string): string {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  return raw.trim()
}

/** 环境变量读取（数字）。 */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/** 账号服务基地址（可用 `LOOMY_ACCOUNT_BASE` 覆盖，测试打本地假上游）。 */
export function accountBase(): string {
  return envText('LOOMY_ACCOUNT_BASE', LOOMY_ACCOUNT_BASE).replace(/\/$/, '')
}

/** 模型网关基地址（可用 `LOOMY_UPSTREAM` 覆盖）。 */
export function modelBase(): string {
  return envText('LOOMY_UPSTREAM', LOOMY_MODEL_BASE).replace(/\/$/, '')
}

/** 签名常量（客户端缺省值，可用 `LOOMY_AK_ID` / `LOOMY_AK_SECRET` 覆盖）。 */
export function accessKey(): { id: string; secret: string } {
  return {
    id: envText('LOOMY_AK_ID', LOOMY_ACCESS_KEY_ID),
    secret: envText('LOOMY_AK_SECRET', LOOMY_ACCESS_KEY_SECRET),
  }
}

/**
 * 把请求里的模型 id 还原成上游 wire id。
 *
 * 上游用**原样的 id**，我们不建别名表；只剥掉客户端可能带上的 `imodel/` 前缀
 * （客户端 provider 名），这是唯一的改写。
 */
export function upstreamModelId(id: string): string {
  const trimmed = id.trim()
  const slash = trimmed.indexOf('/')
  if (slash > 0) {
    const prefix = trimmed.slice(0, slash)
    if (prefix === 'imodel' || prefix === 'loomy' || prefix === 'loomyad') return trimmed.slice(slash + 1)
  }
  return trimmed
}

/** 对外暴露的模型 id：与 wire id 相同（上游目录就是真名）。 */
export function exposedModelId(id: string): string {
  return upstreamModelId(id)
}
