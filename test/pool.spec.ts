import { describe, expect, it } from 'vitest'
import { LoomyAccountPool, type PoolStrategy } from '../src/account-pool.ts'
import { LoomyQueueGate, QUEUE_FULL_MESSAGE } from '../src/queue.ts'

/**
 * 账号池与并发闸门。
 *
 * 池只回答一个问题：**现在该让谁接活**。策略、冷却、暂停、置顶都在这里定死，
 * 上游的额度读数通过 `available` 钩子注入（池自己不查点数）。
 */

function poolWith(
  ids: readonly string[],
  options: { strategy?: PoolStrategy; balances?: Record<string, number>; now?: () => number } = {},
): LoomyAccountPool {
  return new LoomyAccountPool(ids, {
    ...options.strategy === undefined ? {} : { strategy: options.strategy },
    available: id => options.balances?.[id],
    ...options.now === undefined ? {} : { now: options.now },
  })
}

describe('LoomyAccountPool', () => {
  it('picks every account once before repeating (lru)', () => {
    const pool = poolWith(['a', 'b'], { strategy: 'lru' })
    const first = pool.pick()
    pool.acquire(first ?? '')
    pool.release(first ?? '')
    const second = pool.pick()
    expect(new Set([first, second])).toEqual(new Set(['a', 'b']))
  })

  it('prefers the account with the most points under the balance strategy', () => {
    const pool = poolWith(['a', 'b', 'c'], { strategy: 'balance', balances: { a: 10, b: 900, c: 5 } })
    expect(pool.pick()).toBe('b')
  })

  it('puts accounts with unknown points after ones with a number', () => {
    const pool = poolWith(['known', 'unknown'], { strategy: 'balance', balances: { known: 0 } })
    expect(pool.pick()).toBe('known')
  })

  it('rotates in order under round_robin', () => {
    const pool = poolWith(['a', 'b', 'c'], { strategy: 'round_robin' })
    const seen: (string | undefined)[] = []
    for (let index = 0; index < 3; index += 1) {
      const id = pool.pick()
      seen.push(id)
      if (id !== undefined) {
        pool.acquire(id)
        pool.release(id)
      }
    }
    expect(new Set(seen)).toEqual(new Set(['a', 'b', 'c']))
  })

  it('honours pinning before the strategy ordering', () => {
    const pool = poolWith(['rich', 'pinned'], { strategy: 'balance', balances: { rich: 999, pinned: 1 } })
    pool.setPreferred(['pinned'])
    expect(pool.pick()).toBe('pinned')
  })

  it('skips paused accounts', () => {
    const pool = poolWith(['a', 'b'], { strategy: 'lru' })
    pool.setPaused(['a'])
    expect(pool.pick()).toBe('b')
    pool.setPaused(['a', 'b'])
    expect(pool.pick()).toBeUndefined()
  })

  it('skips cooling-down accounts until the cooldown passes', () => {
    let now = 1_000
    const pool = poolWith(['a', 'b'], { strategy: 'lru', now: () => now })
    pool.cooldown('a', 5_000, 'rate limited')
    expect(pool.pick()).toBe('b')
    expect(pool.healthy('a')).toBe(false)
    now += 5_001
    expect(pool.healthy('a')).toBe(true)
    // 冷却结束后 a 重新参与轮转（两个号的 lastUsed 都是 0，顺序回到文档顺序）。
    expect(pool.pick()).toBe('a')
  })

  it('does not hand out more slots than maxConcurrent', () => {
    const pool = poolWith(['a'])
    expect(pool.acquire('a')).toBe(true)
    expect(pool.acquire('a')).toBe(false)
    pool.release('a')
    expect(pool.acquire('a')).toBe(true)
  })

  it('marks an account disabled until it is revived', () => {
    const pool = poolWith(['a', 'b'], { strategy: 'lru' })
    pool.disable('a', 'session rejected')
    expect(pool.pick()).toBe('b')
    pool.revive('a')
    expect(pool.hasUsable()).toBe(true)
  })

  it('drops accounts that disappear from the registry', () => {
    const pool = poolWith(['a', 'b'])
    pool.sync(['b'])
    expect(pool.list().map(entry => entry.id)).toEqual(['b'])
  })

  it('waits for a busy slot and gives up when nothing is waitable', async () => {
    const pool = poolWith(['a'])
    pool.acquire('a')
    setTimeout(() => pool.release('a'), 20)
    await expect(pool.waitForFreeSlot(200)).resolves.toBe(true)

    const busy = poolWith(['b'])
    busy.acquire('b')
    await expect(busy.waitForFreeSlot(20)).resolves.toBe(false)
  })

  it('reports the strategy it is currently using', () => {
    const pool = poolWith(['a'])
    expect(pool.currentStrategy()).toBe('balance')
    pool.setStrategy('lru')
    expect(pool.currentStrategy()).toBe('lru')
  })
})

describe('LoomyQueueGate', () => {
  it('grants immediately while under the limit', async () => {
    const gate = new LoomyQueueGate({ maxConcurrent: 1, maxQueue: 3, cooldownMs: 0 })
    expect(await gate.acquire()).toBe(true)
    gate.release()
    expect(gate.snapshot().active).toBe(0)
  })

  it('rejects with a clear message when the queue is full', async () => {
    const gate = new LoomyQueueGate({ maxConcurrent: 1, maxQueue: 1, cooldownMs: 0 })
    expect(await gate.acquire()).toBe(true)
    const queued = gate.acquire()
    expect(await gate.acquire()).toBe(false)
    expect(QUEUE_FULL_MESSAGE).toMatch(/queue is full/)
    gate.release()
    await expect(queued).resolves.toBe(true)
  })

  it('cancels a queued acquire on abort', async () => {
    const gate = new LoomyQueueGate({ maxConcurrent: 1, maxQueue: 2, cooldownMs: 0 })
    await gate.acquire()
    const controller = new AbortController()
    const queued = gate.acquire(controller.signal)
    controller.abort()
    await expect(queued).resolves.toBe(false)
  })

  it('drains waiters on dispose', async () => {
    const gate = new LoomyQueueGate({ maxConcurrent: 1, maxQueue: 2, cooldownMs: 0 })
    await gate.acquire()
    const queued = gate.acquire()
    gate.dispose()
    await expect(queued).resolves.toBe(false)
  })
})
