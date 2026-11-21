/**
 * 点数（额度）：上游**真的**有账本，所以这里不编数字。
 *
 * `GET /points/records` 返回（`docs/PROTOCOL.md` 第 5 节）：
 *
 * ```jsonc
 * { "code": "000000",
 *   "data": { "balance": 5000,        // 永久点数
 *             "dailyBalance": 4877,   // 每日赠送（先扣，按天重置）
 *             "availableBalance": 9877,
 *             "list": [ … ] } }
 * ```
 *
 * 与 DevEco 那个插件不同：那边上游没有余额接口，只能算本机用量；这里可以诚实地显示
 * 「这个号现在还剩多少点」，并且用 `availableBalance` 做**额度感知选号**
 * （策略 `balance`，见 `account-pool.ts`）。
 *
 * 语义边界（必须写进卡片，别让用户误读）：
 *
 * - `dailyBalance` 是**每日赠送**，官方没有公开重置时刻，所以只展示数值，不编倒计时；
 * - 余额是**账号级**的（多设备共用），不是本机用量；
 * - 一个请求实际扣多少点由模型倍率决定（`x0.1` … `x12.0`），上游在响应的
 *   `usage.points_consumed` 里给准确值，本机账本记的是那个数。
 *
 * @module dsh-loomy/points
 */

import { POINTS_TIMEOUT_MS } from './config.ts'
import { buildModelHeaders, pointsUrl } from './upstream.ts'

/** 一次点数查询的结果。 */
export interface PointsSnapshot {
  /** 永久点数。 */
  balance?: number
  /** 每日赠送余额。 */
  dailyBalance?: number
  /** 可用总额（`balance + dailyBalance`）。 */
  available?: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed)
  }
  return undefined
}

/** 解析 `/points/records` 响应：`data.*` 或顶层同名字段都接受。 */
export function parsePoints(raw: unknown): PointsSnapshot {
  if (!isObject(raw)) return {}
  const data = isObject(raw.data) ? raw.data : raw
  const balance = numberOrUndefined(data.balance)
  const dailyBalance = numberOrUndefined(data.dailyBalance)
  const available = numberOrUndefined(data.availableBalance)
    ?? (balance === undefined && dailyBalance === undefined
      ? undefined
      : (balance ?? 0) + (dailyBalance ?? 0))
  return {
    ...balance === undefined ? {} : { balance },
    ...dailyBalance === undefined ? {} : { dailyBalance },
    ...available === undefined ? {} : { available },
  }
}

/** 拉一个账号的点数。 */
export async function fetchPoints(
  session: string,
  options: { signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<PointsSnapshot> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? POINTS_TIMEOUT_MS)
  timer.unref?.()
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    const response = await fetchImpl(pointsUrl(), {
      method: 'GET',
      headers: buildModelHeaders(session),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`GET /points/records returned HTTP ${response.status}`)
    return parsePoints(await response.json() as unknown)
  } finally {
    clearTimeout(timer)
  }
}

/** 一个账号的额度状态。 */
export interface AccountPoints {
  /** 最近一次成功查到的点数。 */
  snapshot?: PointsSnapshot
  /** 何时查到的（epoch ms）。 */
  checkedAt?: number
  /** 查询失败的原因（保留上一次数值，不清空）。 */
  error?: string
  /** 被上游判过「点数不足」；窗口/时间过了自动作废（不编造重置时刻）。 */
  exhaustedAt?: number
  /** 被判额度用尽时的原文。 */
  exhaustedReason?: string
}

/** 点数缓存 + 「额度用尽」标记。 */
export class LoomyPointsTracker {
  private readonly accounts = new Map<string, AccountPoints>()

  /** 记一次成功的查询。 */
  noteOk(id: string, snapshot: PointsSnapshot, at: number = Date.now()): void {
    const previous = this.accounts.get(id)
    this.accounts.set(id, {
      ...previous,
      snapshot: { ...previous?.snapshot, ...snapshot },
      checkedAt: at,
      error: undefined,
      // 明确查到余额就说明额度判定该翻篇了。
      exhaustedAt: undefined,
      exhaustedReason: undefined,
    })
  }

  /** 记一次查询失败（保留上一次数值）。 */
  noteError(id: string, message: string): void {
    const previous = this.accounts.get(id) ?? {}
    this.accounts.set(id, { ...previous, error: message })
  }

  /** 记一次「上游说点数不足」。 */
  noteExhausted(id: string, reason: string, at: number = Date.now()): void {
    const previous = this.accounts.get(id) ?? {}
    this.accounts.set(id, { ...previous, exhaustedAt: at, exhaustedReason: reason })
  }

  /** 上游接受了一次请求：说明这个号现在有额度。 */
  noteServed(id: string): void {
    const previous = this.accounts.get(id)
    if (previous === undefined) return
    if (previous.exhaustedAt === undefined) return
    this.accounts.set(id, { ...previous, exhaustedAt: undefined, exhaustedReason: undefined })
  }

  state(id: string): AccountPoints | undefined {
    return this.accounts.get(id)
  }

  /** 这个号现在还能接活吗（没被标额度用尽）。 */
  usable(id: string): boolean {
    return this.accounts.get(id)?.exhaustedAt === undefined
  }

  /**
   * 额度感知选号用的权值。
   *
   * 没查到过余额的账号给 `undefined`（让池用「最久未用」兜底）；查到 0 的账号也参与
   * 轮转（余额为 0 不等于请求一定失败：每日赠送可能还没刷新进来）。
   */
  available(id: string): number | undefined {
    return this.accounts.get(id)?.snapshot?.available
  }

  /** 快照（给状态文档/诊断）。 */
  snapshot(): Record<string, AccountPoints> {
    return Object.fromEntries([...this.accounts].map(([id, value]) => [id, { ...value }]))
  }

  /** 清掉已删除账号的缓存。 */
  prune(ids: readonly string[]): void {
    const keep = new Set(ids)
    for (const id of [...this.accounts.keys()]) if (!keep.has(id)) this.accounts.delete(id)
  }

  clear(): void {
    this.accounts.clear()
  }
}

/** 上游的「没点数了」长什么样（402 之外，也可能是 403 + 文案）。 */
export function looksLikeQuotaExhausted(status: number, message: string): boolean {
  if (status === 402) return true
  const text = message.toLowerCase()
  return text.includes('insufficient')
    || text.includes('no enough')
    || text.includes('not enough')
    || text.includes('quota')
    || text.includes('余额不足')
    || text.includes('点数不足')
    || text.includes('积分不足')
}
