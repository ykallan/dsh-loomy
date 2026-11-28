/**
 * 每日签到 —— 上游把它叫 `first-login`。
 *
 * 名字很容易误导：它不是「首次登录」，而是**开始今天的计费周期**。官方客户端每次登录
 * 都会发这一次请求，服务端随即把每日赠送（`dailyBalance`）续满；同一个自然日内重复调用
 * 是幂等的，应答里用 `alreadyProcessed: true` 表示「今天已经刷过了」。
 *
 * 因此这里遵守两条边界（`docs/PROTOCOL.md` 第 5、6 节）：
 *
 * - **不编造赠送数额**：应答里怎么算的（`dailyQuota - dailyConsumed`）没被公开承诺，
 *   这里只用调用前后 `GET /points/records` 的 `dailyBalance` 差来判断「这次有没有刷上」；
 *   量不出来就直说结果未知。
 * - **按天幂等，所以启动时随便调**：每次打开 DSH 给每个可用账号发一次，重复调用只会
 *   拿到 `alreadyProcessed`，不会多领也不会扣点数。
 *
 * @module dsh-loomy/checkin
 */

import { POINTS_TIMEOUT_MS } from './config.ts'
import { LoomyPointsTracker, fetchPoints, type PointsSnapshot } from './points.ts'
import { buildModelHeaders, firstLoginUrl, readErrorText } from './upstream.ts'

/** 一个账号这一轮签到发生了什么。 */
export type CheckinOutcome =
  /** 今天的每日赠送是这次刷新的（余额可见地涨了，或应答明确说今天第一次）。 */
  | 'claimed'
  /** 今天已经刷过（`alreadyProcessed`）或余额没有变化。 */
  | 'done'
  /** 请求成功，但没有可用的判据。宁可说不知道，也不谎报签到成功。 */
  | 'unknown'
  /** 没有可用会话（待登录/暂停），压根没发请求。 */
  | 'skipped'
  /** 请求失败（网络、401、业务错误码）。 */
  | 'failed'

/** `POST /points/first-login` 的应答里我们能确认的字段。 */
export interface FirstLoginResult {
  /** `true` = 今天已经刷过（幂等命中）；`false` = 这次就是今天第一次。 */
  alreadyProcessed?: boolean
  /** 业务码；`000000` 才是成功。 */
  code?: string
  /** 业务说明（失败原因）。 */
  message?: string
}

/** 卡片上的签到状态（一个账号一份）。 */
export interface AccountCheckin {
  /** 最近一次尝试的时刻（epoch ms）。 */
  at?: number
  outcome?: CheckinOutcome
  /** 这次刷出来的每日赠送增量（只有量得到、且大于 0 时才有）。 */
  gained?: number
  /** 签到后查到的每日赠送余额。 */
  dailyBalance?: number
  /** 失败原因或补充说明。 */
  message?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 解析签到应答。
 *
 * 成功信封是 `{code, desc, data}`；`alreadyProcessed` 可能挂在 `data` 里也可能在顶层
 * （两个公开实现都这么读），所以两处都认。**认不出就不猜**：缺字段就是 `undefined`。
 */
export function parseFirstLogin(raw: unknown): FirstLoginResult {
  if (!isObject(raw)) return {}
  const data = isObject(raw.data) ? raw.data : raw
  const already = data.alreadyProcessed ?? raw.alreadyProcessed
  const code = textOrUndefined(raw.code) ?? textOrUndefined(data.code)
  const message = textOrUndefined(raw.desc)
    ?? textOrUndefined(raw.message)
    ?? textOrUndefined(raw.msg)
    ?? textOrUndefined(data.desc)
  return {
    ...typeof already === 'boolean' ? { alreadyProcessed: already } : {},
    ...code === undefined ? {} : { code },
    ...message === undefined ? {} : { message },
  }
}

/** `fetchFirstLogin` 的可注入项（测试用假上游）。 */
export interface FirstLoginOptions {
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * 发一次签到请求。
 *
 * 请求头与点数查询完全一致（`Authorization` + `token` + `traceparent` + `loomy-version`），
 * 请求体是 `{}` —— 上游只需要会话，不需要别的参数。
 */
export async function fetchFirstLogin(
  session: string,
  options: FirstLoginOptions = {},
): Promise<FirstLoginResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? POINTS_TIMEOUT_MS)
  timer.unref?.()
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    const response = await fetchImpl(firstLoginUrl(), {
      method: 'POST',
      headers: buildModelHeaders(session),
      body: '{}',
      signal: controller.signal,
    })
    if (!response.ok) {
      // 错误体要读出来：401 与 429 的区别决定了用户该重新登录还是等一会儿。
      const detail = await readErrorText(response).catch(() => '')
      throw new Error(`POST /points/first-login returned HTTP ${String(response.status)}${detail === '' ? '' : `: ${detail}`}`)
    }
    const text = await response.text()
    let payload: unknown = {}
    if (text.trim() !== '') {
      try {
        payload = JSON.parse(text) as unknown
      } catch {
        // 非 JSON 的成功应答：没有可判的字段，交给 unknown。
        payload = {}
      }
    }
    const result = parseFirstLogin(payload)
    if (result.code !== undefined && result.code !== '000000') {
      throw new Error(`first-login rejected: ${result.code}${result.message === undefined ? '' : ` ${result.message}`}`)
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把「应答 + 每日赠送差额」翻译成一个结论。
 *
 * 优先级：应答明说 `alreadyProcessed` > 余额差额 > 应答明说「今天第一次」 > 不知道。
 */
export function classifyCheckin(result: FirstLoginResult, gained: number | undefined): CheckinOutcome {
  if (result.alreadyProcessed === true) return 'done'
  if (gained !== undefined) return gained > 0 ? 'claimed' : 'done'
  if (result.alreadyProcessed === false) return 'claimed'
  return 'unknown'
}

/** 上游说「这个会话不行了」的样子：HTTP 401/403，或业务码 `100002`（登录已失效）。 */
export function isAuthFailure(message: string): boolean {
  if (/\bHTTP\s+(401|403)\b/.test(message)) return true
  if (/\b100002\b/.test(message)) return true
  return message.includes('登录已失效')
}

/** 一个账号的签到状态缓存。 */
export class LoomyCheckinTracker {
  private readonly accounts = new Map<string, AccountCheckin>()

  /** 记一次尝试（同一账号只保留最近一次）。 */
  note(id: string, entry: AccountCheckin): void {
    const previous = this.accounts.get(id)
    this.accounts.set(id, {
      ...previous,
      ...entry,
      // 上一次的失败原因不该粘在这一次成功的结果上。
      ...entry.outcome !== undefined && entry.outcome !== 'failed' && entry.message === undefined
        ? { message: undefined }
        : {},
    })
  }

  state(id: string): AccountCheckin | undefined {
    return this.accounts.get(id)
  }

  snapshot(): Record<string, AccountCheckin> {
    return Object.fromEntries([...this.accounts].map(([id, value]) => [id, { ...value }]))
  }

  /** 清掉已删除账号的状态。 */
  prune(ids: readonly string[]): void {
    const keep = new Set(ids)
    for (const id of [...this.accounts.keys()]) if (!keep.has(id)) this.accounts.delete(id)
  }

  clear(): void {
    this.accounts.clear()
  }
}

/** 两次签到之间留一点间隔：启动时没必要把所有账号在同一毫秒打出去。 */
const CHECKIN_GAP_MS = 800

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** 一整轮签到的依赖（全部显式注入，测试可以完全离线）。 */
export interface CheckinPassOptions {
  /** 要签到的账号 id（调用方决定：通常是不暂停、不待登录的那些）。 */
  ids: readonly string[]
  /** 解析一个账号的可用会话（必要时由账号层静默重登）。 */
  resolveSession: (id: string) => Promise<string | undefined>
  /**
   * 签到被上游判「会话失效」时的一次重登机会（返回新会话）。
   *
   * 上游对死会话也回 HTTP 200 + 业务码 `100002`，`resolve()` 光看本地到期时间是发现不了
   * 的 —— 没有这个钩子，启动签到会在「会话被提前吊销」的账号上静默失败，直到下次聊天请求
   * 才自愈。实现方应走账号层已有的「单飞重登」，不要自己再写一套登录。
   */
  refreshSession?: (id: string, reason: string) => Promise<string | undefined>
  /** 签到前缓存的点数快照（用来算每日赠送差额）；拿不到就不算。 */
  cachedPoints?: (id: string) => PointsSnapshot | undefined
  /** 签到后用点数查询刷新余额（同时给卡片提供最新数字）。 */
  points: LoomyPointsTracker
  tracker: LoomyCheckinTracker
  firstLoginImpl?: (session: string, options?: FirstLoginOptions) => Promise<FirstLoginResult>
  fetchPointsImpl?: (session: string, options?: { signal?: AbortSignal }) => Promise<PointsSnapshot>
  /** 失败原因写插件自己的日志（宿主没有 info/debug 出口，见 `index.ts`）。 */
  log?: (message: string) => void
  signal?: AbortSignal
  now?: () => number
  gapMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** 一轮签到的汇总（给卡片与日志），图形与别处的 `PointsRefreshResult` 保持一致。 */
export interface CheckinSummary {
  attempted: number
  claimed: number
  done: number
  unknown: number
  failed: number
  skipped: number
  accounts: { id: string; outcome: CheckinOutcome; message?: string; gained?: number }[]
  message: string
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 300 ? `${message.slice(0, 300)}…` : message
}

/**
 * 逐个账号签到。
 *
 * 串行 + 小间隔：账号服务与网关对并发登录比较敏感，而且签到本身不着急。单个账号失败
 * **绝不**中断整轮 —— 其余账号的每日额度还是要刷的。
 */
export async function runCheckinPass(options: CheckinPassOptions): Promise<CheckinSummary> {
  const now = options.now ?? ((): number => Date.now())
  const firstLoginImpl = options.firstLoginImpl ?? fetchFirstLogin
  const fetchPointsImpl = options.fetchPointsImpl ?? fetchPoints
  const sleep = options.sleep ?? defaultSleep
  const gapMs = options.gapMs ?? CHECKIN_GAP_MS
  const summary: CheckinSummary = {
    attempted: 0,
    claimed: 0,
    done: 0,
    unknown: 0,
    failed: 0,
    skipped: 0,
    accounts: [],
    message: '',
  }

  for (const [index, id] of options.ids.entries()) {
    if (options.signal?.aborted === true) break
    summary.attempted += 1
    const at = now()

    let session = await options.resolveSession(id)
    if (session === undefined || session === '') {
      options.tracker.note(id, { at, outcome: 'skipped', message: 'no usable session' })
      summary.skipped += 1
      summary.accounts.push({ id, outcome: 'skipped', message: 'no usable session' })
      continue
    }

    const before = options.cachedPoints?.(id)?.dailyBalance
    const attempt = (token: string): Promise<FirstLoginResult> =>
      firstLoginImpl(token, options.signal === undefined ? {} : { signal: options.signal })

    let result: FirstLoginResult | undefined
    let failure: string | undefined
    try {
      result = await attempt(session)
    } catch (error: unknown) {
      failure = safeMessage(error)
    }

    // 会话被提前吊销时（HTTP 200 + 业务码 100002，或 401/403），用存着的密码重登一次再试。
    if (result === undefined && failure !== undefined && options.refreshSession !== undefined && isAuthFailure(failure)) {
      let refreshed: string | undefined
      try {
        refreshed = await options.refreshSession(id, failure)
      } catch (error: unknown) {
        options.log?.(`re-sign-in before check-in failed for ${id}: ${safeMessage(error)}`)
      }
      if (refreshed !== undefined && refreshed !== '' && refreshed !== session) {
        session = refreshed
        failure = undefined
        try {
          result = await attempt(session)
        } catch (error: unknown) {
          failure = safeMessage(error)
        }
      }
    }

    if (result === undefined) {
      const message = failure ?? 'unknown error'
      options.tracker.note(id, { at, outcome: 'failed', message })
      options.log?.(`check-in failed for ${id}: ${message}`)
      summary.failed += 1
      summary.accounts.push({ id, outcome: 'failed', message })
      continue
    }

    let snapshot: PointsSnapshot | undefined
    try {
      snapshot = await fetchPointsImpl(session, options.signal === undefined ? {} : { signal: options.signal })
      options.points.noteOk(id, snapshot)
    } catch (error: unknown) {
      // 签到本身已经成功；余额没查到不该把它翻成失败，保留上一次的数字。
      options.points.noteError(id, safeMessage(error))
    }

    const after = snapshot?.dailyBalance
    const delta = before !== undefined && after !== undefined ? after - before : undefined
    const gained = delta !== undefined && delta > 0 ? delta : undefined
    const outcome = classifyCheckin(result, delta)
    options.tracker.note(id, {
      at,
      outcome,
      ...gained === undefined ? {} : { gained },
      ...after === undefined ? {} : { dailyBalance: after },
      ...result.message === undefined ? {} : { message: result.message },
    })

    if (outcome === 'claimed') summary.claimed += 1
    else if (outcome === 'done') summary.done += 1
    else summary.unknown += 1
    summary.accounts.push({
      id,
      outcome,
      ...gained === undefined ? {} : { gained },
    })

    // 最后一个账号不用等；中途被取消时，下一轮循环开头会立刻退出。
    if (index < options.ids.length - 1) await sleep(gapMs)
  }

  summary.message = summary.attempted === 0
    ? 'no account to check in'
    : `checked in ${String(summary.attempted)} account(s): ${String(summary.claimed)} claimed, `
      + `${String(summary.done)} already done, ${String(summary.unknown)} unknown, `
      + `${String(summary.failed)} failed, ${String(summary.skipped)} skipped`
  return summary
}