/**
 * 本机用量台账。
 *
 * 两个口径都要记，因为它们的含义不同：
 *
 * - **tokens**（`usage.prompt_tokens` / `completion_tokens`）—— 上下文消耗；
 * - **points**（`usage.points_consumed`）—— 上游实际扣的点数，按模型倍率算的。
 *
 * 只记**本机经这个插件发出去的**请求：账号级的余额由 `points.ts` 从上游读，两个数字
 * 不能混为一谈（其它设备/客户端也在花同一个号的点数）。
 *
 * `today` 按**本地自然日**归零。上游的 `dailyBalance` 什么时候重置没有公开，所以这里
 * 不去编一个「额度窗口」—— 本机用量就是本机用量。
 *
 * @module dsh-loomy/usage
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 累计计数。 */
export interface UsageTotals {
  requests: number
  failures: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  points: number
}

/** 一条最近请求记录（不含任何内容）。 */
export interface UsageEvent {
  at: number
  account: string
  model: string
  ok: boolean
  ms: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  points?: number
}

/** 台账快照，给卡片/路由用。 */
export interface UsageSnapshot {
  /** 统计口径说明（卡片直接展示，避免误读成账号总额度）。 */
  scope: 'local'
  day: string
  totals: UsageTotals
  today: UsageTotals
  byAccount: Record<string, UsageTotals>
  byModel: Record<string, UsageTotals>
  recent: readonly UsageEvent[]
}

interface UsageDocument extends UsageSnapshot {
  version: 1
  updatedAt: number
}

const EMPTY_TOTALS: UsageTotals = {
  requests: 0,
  failures: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  points: 0,
}

/** 本地**自然日**键 `YYYY-MM-DD`。 */
export function localDayKey(at: number = Date.now()): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function addTotals(target: UsageTotals, event: {
  ok: boolean
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  points?: number
}): UsageTotals {
  return {
    requests: target.requests + 1,
    failures: target.failures + (event.ok ? 0 : 1),
    inputTokens: target.inputTokens + (event.inputTokens ?? 0),
    outputTokens: target.outputTokens + (event.outputTokens ?? 0),
    reasoningTokens: target.reasoningTokens + (event.reasoningTokens ?? 0),
    points: target.points + (event.points ?? 0),
  }
}

/** 保留多少条最近记录。 */
const RECENT_LIMIT = 100

export class LoomyUsageTracker {
  private readonly path: string
  private document: UsageDocument = {
    version: 1,
    scope: 'local',
    day: localDayKey(),
    totals: { ...EMPTY_TOTALS },
    today: { ...EMPTY_TOTALS },
    byAccount: {},
    byModel: {},
    recent: [],
    updatedAt: Date.now(),
  }

  private loaded = false
  private flushTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: { path: string }) {
    this.path = options.path
  }

  /** 读盘。失败/文件缺失都不影响插件启动。 */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<UsageDocument>
      if (typeof parsed !== 'object' || parsed === null) return
      this.document = {
        version: 1,
        scope: 'local',
        day: typeof parsed.day === 'string' ? parsed.day : localDayKey(),
        totals: normalizeTotals(parsed.totals),
        today: normalizeTotals(parsed.today),
        byAccount: normalizeBuckets(parsed.byAccount),
        byModel: normalizeBuckets(parsed.byModel),
        recent: Array.isArray(parsed.recent) ? parsed.recent.slice(-RECENT_LIMIT) : [],
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      }
      this.rollDay()
    } catch {
      // 台账坏了不该拦住使用：从空账本继续。
    }
  }

  /** 记一次请求。 */
  record(event: Omit<UsageEvent, 'at'> & { at?: number }): void {
    const at = event.at ?? Date.now()
    this.rollDay()
    const full: UsageEvent = {
      at,
      account: event.account,
      model: event.model,
      ok: event.ok,
      ms: event.ms,
      ...event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens },
      ...event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens },
      ...event.reasoningTokens === undefined ? {} : { reasoningTokens: event.reasoningTokens },
      ...event.points === undefined ? {} : { points: event.points },
    }
    this.document.totals = addTotals(this.document.totals, full)
    this.document.today = addTotals(this.document.today, full)
    this.document.byAccount[full.account] = addTotals(
      this.document.byAccount[full.account] ?? { ...EMPTY_TOTALS },
      full,
    )
    this.document.byModel[full.model] = addTotals(
      this.document.byModel[full.model] ?? { ...EMPTY_TOTALS },
      full,
    )
    this.document.recent = [...this.document.recent.slice(-(RECENT_LIMIT - 1)), full]
    this.document.updatedAt = at
    this.scheduleFlush()
  }

  /** 立刻落盘（插件停用时调）。 */
  async flush(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const temp = `${this.path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(this.document, undefined, 2)}\n`, 'utf8')
    renameSync(temp, this.path)
  }

  /** 当前快照。 */
  snapshot(): UsageSnapshot {
    this.rollDay()
    return {
      scope: 'local',
      day: this.document.day,
      totals: { ...this.document.totals },
      today: { ...this.document.today },
      byAccount: { ...this.document.byAccount },
      byModel: { ...this.document.byModel },
      recent: [...this.document.recent].reverse(),
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush().catch(() => {})
    }, 2_000)
    this.flushTimer.unref?.()
  }

  /** 跨天把 `today` 归零（`totals` 保留）。 */
  private rollDay(): void {
    const day = localDayKey()
    if (day === this.document.day) return
    this.document.day = day
    this.document.today = { ...EMPTY_TOTALS }
  }
}

function normalizeTotals(value: unknown): UsageTotals {
  if (typeof value !== 'object' || value === null) return { ...EMPTY_TOTALS }
  const raw = value as Partial<UsageTotals>
  return {
    requests: numberOr0(raw.requests),
    failures: numberOr0(raw.failures),
    inputTokens: numberOr0(raw.inputTokens),
    outputTokens: numberOr0(raw.outputTokens),
    reasoningTokens: numberOr0(raw.reasoningTokens),
    points: numberOr0(raw.points),
  }
}

function normalizeBuckets(value: unknown): Record<string, UsageTotals> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, UsageTotals> = {}
  for (const [key, entry] of Object.entries(value)) out[key] = normalizeTotals(entry)
  return out
}

function numberOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
