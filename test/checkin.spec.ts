import { describe, expect, it, vi } from 'vitest'
import {
  LoomyCheckinTracker,
  classifyCheckin,
  fetchFirstLogin,
  isAuthFailure,
  parseFirstLogin,
  runCheckinPass,
  type FirstLoginResult,
} from '../src/checkin.ts'
import { LoomyPointsTracker, type PointsSnapshot } from '../src/points.ts'

/**
 * 每日签到（上游 `first-login`）。
 *
 * 这里验证三件事：应答怎么读、结论怎么下、以及整轮执行在「某个号失败」时不会带崩其余账号。
 * 全程离线：请求层用假 fetch / 假实现，不打真实上游。
 */

describe('parseFirstLogin', () => {
  it('reads the documented envelope and the idempotency flag', () => {
    expect(parseFirstLogin({
      code: '000000',
      desc: '成功',
      data: { alreadyProcessed: true },
    })).toEqual({ alreadyProcessed: true, code: '000000', message: '成功' })
  })

  it('accepts the flag at the top level and a false value', () => {
    expect(parseFirstLogin({ alreadyProcessed: false })).toEqual({ alreadyProcessed: false })
  })

  it('never invents an outcome for junk', () => {
    expect(parseFirstLogin(null)).toEqual({})
    expect(parseFirstLogin({ data: [] })).toEqual({})
    expect(parseFirstLogin({ data: {} })).toEqual({})
  })
})

describe('classifyCheckin', () => {
  it('trusts alreadyProcessed over anything else', () => {
    expect(classifyCheckin({ alreadyProcessed: true }, 5000)).toBe('done')
    expect(classifyCheckin({ alreadyProcessed: false }, undefined)).toBe('claimed')
  })

  it('falls back to the daily-balance delta', () => {
    expect(classifyCheckin({}, 1)).toBe('claimed')
    expect(classifyCheckin({}, 0)).toBe('done')
  })

  it('says unknown when there is nothing to go on', () => {
    expect(classifyCheckin({}, undefined)).toBe('unknown')
  })
})

describe('fetchFirstLogin', () => {
  it('posts an empty JSON body to /points/first-login with the session headers', async () => {
    let url = ''
    let init: RequestInit | undefined
    const fetchImpl = (async (input: string, options?: RequestInit) => {
      url = String(input)
      init = options
      return new Response(JSON.stringify({ code: '000000', data: { alreadyProcessed: false } }))
    }) as unknown as typeof fetch

    const result = await fetchFirstLogin('session-1', { fetchImpl })

    expect(result.alreadyProcessed).toBe(false)
    expect(url).toContain('/points/first-login')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe('{}')
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer session-1')
    expect(headers.token).toBe('session-1')
    // 缺了它上游会挂到超时（docs/PROTOCOL.md 第 5 节）。
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  })

  it('throws on a non-200 answer, keeping the status and the upstream text', async () => {
    const fetchImpl = (async () => new Response('{"message":"登录已失效"}', { status: 401 })) as unknown as typeof fetch
    await expect(fetchFirstLogin('s', { fetchImpl })).rejects.toThrow(/HTTP 401.*登录已失效/s)
  })

  it('treats a business error code as a failure even on HTTP 200', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ code: '100002', desc: '登录已失效' }))) as unknown as typeof fetch
    await expect(fetchFirstLogin('s', { fetchImpl })).rejects.toThrow(/100002/)
  })
})

describe('LoomyCheckinTracker', () => {
  it('keeps the latest result and clears a stale failure message', () => {
    const tracker = new LoomyCheckinTracker()
    tracker.note('a', { outcome: 'failed', message: 'timeout' })
    expect(tracker.state('a')?.message).toBe('timeout')
    tracker.note('a', { outcome: 'done' })
    expect(tracker.state('a')).toEqual({ outcome: 'done' })
  })

  it('prunes accounts that no longer exist', () => {
    const tracker = new LoomyCheckinTracker()
    tracker.note('a', { outcome: 'done' })
    tracker.note('b', { outcome: 'done' })
    tracker.prune(['b'])
    expect(Object.keys(tracker.snapshot())).toEqual(['b'])
  })
})

interface PassHarness {
  points: LoomyPointsTracker
  checkins: LoomyCheckinTracker
  logs: string[]
  sleeps: number[]
}

function harness(): PassHarness {
  return { points: new LoomyPointsTracker(), checkins: new LoomyCheckinTracker(), logs: [], sleeps: [] }
}

function firstLoginStub(bySession: Record<string, FirstLoginResult>): (session: string) => Promise<FirstLoginResult> {
  return async session => {
    const result = bySession[session]
    if (result === undefined) throw new Error(`no stub for ${session}`)
    return result
  }
}

describe('isAuthFailure', () => {
  it('recognises the shapes the upstream uses for a dead session', () => {
    expect(isAuthFailure('POST /points/first-login returned HTTP 401: nope')).toBe(true)
    expect(isAuthFailure('POST /points/first-login returned HTTP 403')).toBe(true)
    // 上游对死会话回 HTTP 200 + 业务码，实测长这样。
    expect(isAuthFailure('first-login rejected: 100002 登录已失效，请重新登录')).toBe(true)
  })

  it('does not treat throttling or a server hiccup as a dead session', () => {
    expect(isAuthFailure('POST /points/first-login returned HTTP 429: too many')).toBe(false)
    expect(isAuthFailure('POST /points/first-login returned HTTP 500')).toBe(false)
  })
})

describe('runCheckinPass', () => {
  it('classifies claimed vs already-done and refreshes the points cache', async () => {
    const h = harness()
    h.points.noteOk('a', { balance: 0, dailyBalance: 100 })
    h.points.noteOk('b', { balance: 0, dailyBalance: 5000 })
    const after: Record<string, PointsSnapshot> = {
      'session-a': { balance: 0, dailyBalance: 5100, available: 5100 },
      'session-b': { balance: 0, dailyBalance: 5000, available: 5000 },
    }

    const summary = await runCheckinPass({
      ids: ['a', 'b'],
      resolveSession: async id => `session-${id}`,
      cachedPoints: id => h.points.state(id)?.snapshot,
      points: h.points,
      tracker: h.checkins,
      firstLoginImpl: firstLoginStub({
        'session-a': { alreadyProcessed: false },
        'session-b': { alreadyProcessed: true },
      }),
      fetchPointsImpl: async session => after[session] ?? {},
      gapMs: 0,
      sleep: async ms => {
        h.sleeps.push(ms)
      },
    })

    expect(summary.attempted).toBe(2)
    expect(summary.claimed).toBe(1)
    expect(summary.done).toBe(1)
    expect(summary.failed).toBe(0)
    expect(h.checkins.state('a')).toMatchObject({ outcome: 'claimed', gained: 5000, dailyBalance: 5100 })
    expect(h.checkins.state('b')).toMatchObject({ outcome: 'done' })
    // 签到顺带把余额刷新了：卡片不用再等下一轮点数轮询。
    expect(h.points.available('a')).toBe(5100)
    // 只有两个账号，最后一次不该再等。
    expect(h.sleeps).toEqual([0])
  })

  it('keeps going when one account has no session and another fails', async () => {
    const h = harness()
    const summary = await runCheckinPass({
      ids: ['skip', 'boom', 'ok'],
      resolveSession: async id => (id === 'skip' ? undefined : `session-${id}`),
      points: h.points,
      tracker: h.checkins,
      firstLoginImpl: async session => {
        if (session === 'session-boom') throw new Error('HTTP 500')
        return { alreadyProcessed: true }
      },
      fetchPointsImpl: async () => ({ balance: 1, dailyBalance: 2 }),
      gapMs: 0,
      sleep: async () => {},
    })

    expect(summary.attempted).toBe(3)
    expect(summary.skipped).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.done).toBe(1)
    expect(h.checkins.state('skip')?.outcome).toBe('skipped')
    expect(h.checkins.state('boom')?.outcome).toBe('failed')
    expect(h.checkins.state('boom')?.message).toContain('HTTP 500')
    expect(h.logs).toEqual([]) // log 由调用方注入；这里没注入就是没有
    expect(summary.accounts.map(entry => entry.outcome)).toEqual(['skipped', 'failed', 'done'])
  })

  it('does not turn “check-in worked but points lookup failed” into a failure', async () => {
    const h = harness()
    const summary = await runCheckinPass({
      ids: ['a'],
      resolveSession: async () => 'session-a',
      points: h.points,
      tracker: h.checkins,
      firstLoginImpl: async () => ({}),
      fetchPointsImpl: async () => {
        throw new Error('timeout')
      },
      gapMs: 0,
      sleep: async () => {},
    })

    expect(summary.failed).toBe(0)
    expect(summary.unknown).toBe(1)
    expect(h.checkins.state('a')?.outcome).toBe('unknown')
    expect(h.points.state('a')?.error).toBe('timeout')
  })

  it('stops before doing any work when the signal is already aborted', async () => {
    const h = harness()
    const controller = new AbortController()
    controller.abort()
    const firstLoginImpl = vi.fn(async () => ({ alreadyProcessed: true }))
    const summary = await runCheckinPass({
      ids: ['a', 'b'],
      resolveSession: async () => 'session-a',
      points: h.points,
      tracker: h.checkins,
      firstLoginImpl,
      signal: controller.signal,
    })
    expect(summary.attempted).toBe(0)
    expect(summary.message).toMatch(/no account/i)
    expect(firstLoginImpl).not.toHaveBeenCalled()
  })

  it('records failures through the injected log', async () => {
    const h = harness()
    await runCheckinPass({
      ids: ['a'],
      resolveSession: async () => 'session-a',
      points: h.points,
      tracker: h.checkins,
      firstLoginImpl: async () => {
        throw new Error('HTTP 500')
      },
      log: message => h.logs.push(message),
      gapMs: 0,
      sleep: async () => {},
    })
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toContain('check-in failed for a')
  })

  it('re-signs in once and retries when the upstream calls the session dead', async () => {
    const h = harness()
    const calls: string[] = []
    const summary = await runCheckinPass({
      ids: ['a'],
      resolveSession: async () => 'stale-session',
      refreshSession: async () => 'fresh-session',
      points: h.points,
      tracker: h.checkins,
      firstLoginImpl: async session => {
        calls.push(session)
        if (session === 'stale-session') {
          throw new Error('first-login rejected: 100002 登录已失效，请重新登录')
        }
        return { alreadyProcessed: false }
      },
      fetchPointsImpl: async () => ({ balance: 0, dailyBalance: 5000, available: 5000 }),
      gapMs: 0,
      sleep: async () => {},
    })

    expect(calls).toEqual(['stale-session', 'fresh-session'])
    expect(summary.failed).toBe(0)
    expect(summary.claimed).toBe(1)
    expect(h.checkins.state('a')?.outcome).toBe('claimed')
  })

  it('does not re-sign-in for a non-auth failure', async () => {
    const h = harness()
    let refreshed = 0
    const summary = await runCheckinPass({
      ids: ['a'],
      resolveSession: async () => 'session-a',
      refreshSession: async () => {
        refreshed += 1
        return 'another-session'
      },
      points: h.points,
      tracker: h.checkins,
      firstLoginImpl: async () => {
        throw new Error('HTTP 500')
      },
      gapMs: 0,
      sleep: async () => {},
    })

    expect(refreshed).toBe(0)
    expect(summary.failed).toBe(1)
    expect(h.checkins.state('a')?.message).toContain('HTTP 500')
  })
})