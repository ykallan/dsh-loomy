import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoomyUsageTracker, localDayKey } from '../src/usage.ts'

/**
 * 本机用量台账：tokens 与 points 两个口径都要记，跨天只归零 `today`。
 */

const dirs: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-loomy-usage-'))
  dirs.push(dir)
  return join(dir, 'usage.json')
}

describe('LoomyUsageTracker', () => {
  it('counts requests, tokens and points per day, account and model', () => {
    const tracker = new LoomyUsageTracker({ path: tempPath() })
    tracker.record({ account: 'a', model: 'spark-x', ok: true, ms: 10, inputTokens: 3, outputTokens: 5, points: 1 })
    tracker.record({ account: 'a', model: 'spark-x', ok: false, ms: 20 })
    const snapshot = tracker.snapshot()
    expect(snapshot.today.requests).toBe(2)
    expect(snapshot.today.failures).toBe(1)
    expect(snapshot.today.inputTokens).toBe(3)
    expect(snapshot.today.outputTokens).toBe(5)
    expect(snapshot.today.points).toBe(1)
    expect(snapshot.byAccount.a?.requests).toBe(2)
    expect(snapshot.byModel['spark-x']?.requests).toBe(2)
    expect(snapshot.scope).toBe('local')
  })

  it('keeps the newest events first and caps the list', () => {
    const tracker = new LoomyUsageTracker({ path: tempPath() })
    for (let index = 0; index < 105; index += 1) {
      tracker.record({ account: 'a', model: 'm', ok: true, ms: index })
    }
    const snapshot = tracker.snapshot()
    expect(snapshot.recent).toHaveLength(100)
    expect(snapshot.recent[0]?.ms).toBe(104)
  })

  it('persists across instances', async () => {
    const path = tempPath()
    const tracker = new LoomyUsageTracker({ path })
    tracker.record({ account: 'a', model: 'm', ok: true, ms: 1, points: 2 })
    await tracker.flush()
    const reopened = new LoomyUsageTracker({ path })
    await reopened.load()
    expect(reopened.snapshot().totals.points).toBe(2)
  })

  it('starts from an empty ledger when the file is corrupt', async () => {
    const path = tempPath()
    const tracker = new LoomyUsageTracker({ path })
    await tracker.load()
    const details = await import('node:fs')
    details.writeFileSync(path, '{not json')
    const broken = new LoomyUsageTracker({ path })
    await broken.load()
    expect(broken.snapshot().totals.requests).toBe(0)
  })

  it('rolls today over at midnight but keeps the totals', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T23:00:00'))
    const tracker = new LoomyUsageTracker({ path: tempPath() })
    tracker.record({ account: 'a', model: 'm', ok: true, ms: 1, inputTokens: 10 })
    expect(tracker.snapshot().day).toBe('2026-11-20')

    vi.setSystemTime(new Date('2026-11-21T01:00:00'))
    const snapshot = tracker.snapshot()
    expect(snapshot.day).toBe('2026-11-21')
    expect(snapshot.today.requests).toBe(0)
    expect(snapshot.totals.requests).toBe(1)
    expect(snapshot.totals.inputTokens).toBe(10)
  })

  it('formats the local day key with zero padding', () => {
    expect(localDayKey(new Date(2026, 0, 5).getTime())).toBe('2026-01-05')
  })
})
