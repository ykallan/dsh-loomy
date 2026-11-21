import { describe, expect, it } from 'vitest'
import {
  LoomyPointsTracker,
  fetchPoints,
  looksLikeQuotaExhausted,
  parsePoints,
} from '../src/points.ts'

/**
 * 点数（额度）。上游有真账本，所以这里既能显示余额，也能据此选号。
 */

describe('parsePoints', () => {
  it('reads the documented shape', () => {
    expect(parsePoints({
      code: '000000',
      data: { balance: 5000, dailyBalance: 4877, availableBalance: 9877, list: [] },
    })).toEqual({ balance: 5000, dailyBalance: 4877, available: 9877 })
  })

  it('computes available when the upstream omits it', () => {
    expect(parsePoints({ data: { balance: 10, dailyBalance: 5 } })).toEqual({
      balance: 10,
      dailyBalance: 5,
      available: 15,
    })
  })

  it('accepts numbers as strings', () => {
    expect(parsePoints({ data: { balance: '7', availableBalance: '9' } })).toEqual({
      balance: 7,
      available: 9,
    })
  })

  it('returns an empty snapshot for junk (never a fake zero)', () => {
    expect(parsePoints(null)).toEqual({})
    expect(parsePoints({ data: {} })).toEqual({})
  })
})

describe('fetchPoints', () => {
  it('calls /points/records with the session headers and parses the answer', async () => {
    let url = ''
    let headers: Record<string, string> = {}
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      url = String(input)
      headers = (init?.headers ?? {}) as Record<string, string>
      return new Response(JSON.stringify({ data: { balance: 1, dailyBalance: 2, availableBalance: 3 } }))
    }) as unknown as typeof fetch
    const snapshot = await fetchPoints('session-1', { fetchImpl })
    expect(snapshot.available).toBe(3)
    expect(url).toContain('/points/records')
    expect(url).toContain('record_type=all')
    expect(headers.Authorization).toBe('Bearer session-1')
  })

  it('throws on a non-200 answer', async () => {
    const fetchImpl = (async () => new Response('', { status: 402 })) as unknown as typeof fetch
    await expect(fetchPoints('s', { fetchImpl })).rejects.toThrow(/HTTP 402/)
  })
})

describe('LoomyPointsTracker', () => {
  it('records a snapshot and clears a previous exhaustion mark', () => {
    const tracker = new LoomyPointsTracker()
    tracker.noteExhausted('a', 'insufficient points')
    expect(tracker.usable('a')).toBe(false)
    tracker.noteOk('a', { available: 42 })
    expect(tracker.usable('a')).toBe(true)
    expect(tracker.available('a')).toBe(42)
    expect(tracker.state('a')?.exhaustedAt).toBeUndefined()
  })

  it('keeps the last numbers when a lookup fails', () => {
    const tracker = new LoomyPointsTracker()
    tracker.noteOk('a', { available: 10 })
    tracker.noteError('a', 'timeout')
    expect(tracker.available('a')).toBe(10)
    expect(tracker.state('a')?.error).toBe('timeout')
  })

  it('marks an account served again after an exhaustion', () => {
    const tracker = new LoomyPointsTracker()
    tracker.noteExhausted('a', 'insufficient')
    tracker.noteServed('a')
    expect(tracker.usable('a')).toBe(true)
  })

  it('prunes accounts that no longer exist', () => {
    const tracker = new LoomyPointsTracker()
    tracker.noteOk('a', { available: 1 })
    tracker.noteOk('b', { available: 2 })
    tracker.prune(['b'])
    expect(Object.keys(tracker.snapshot())).toEqual(['b'])
  })
})

describe('looksLikeQuotaExhausted', () => {
  it('treats 402 and quota wording as exhaustion', () => {
    expect(looksLikeQuotaExhausted(402, '')).toBe(true)
    expect(looksLikeQuotaExhausted(403, 'insufficient points')).toBe(true)
    expect(looksLikeQuotaExhausted(400, '点数不足')).toBe(true)
  })

  it('does not treat an overload as exhaustion', () => {
    expect(looksLikeQuotaExhausted(503, 'service busy')).toBe(false)
    expect(looksLikeQuotaExhausted(400, 'bad request')).toBe(false)
  })
})
