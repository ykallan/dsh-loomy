/**
 * 上游生成的并发闸门。
 *
 * Loomy 的限流不透明（既没有公开的 RPM，也没有「排队位置」），但我们知道两件事：
 * 打得太密会被 429，而 429 之后重试又要重新排队。所以本地先排：默认 1 个在飞、最多 3 个
 * 等待，再多直接 429 —— 排队上限存在的意义是**别让用户以为它还在跑**。
 *
 * 排队入场的请求先冷却一小会儿（默认 500ms），避免刚释放就撞上上游的计数窗口。
 *
 * @module dsh-loomy/queue
 */

import { DEFAULT_MAX_CONCURRENCY, DEFAULT_MAX_QUEUE, DEFAULT_QUEUE_COOLDOWN_MS } from './config.ts'

/** 队列满时给调用方的错误（pi-ai 会把它显示成一次失败）。 */
export const QUEUE_FULL_MESSAGE = 'upstream generation queue is full, please retry shortly'

interface Waiter {
  resolve: (granted: boolean) => void
  /** 只是「入场前冷却」的定时器，取消时要清掉。 */
  timer?: ReturnType<typeof setTimeout>
  granted: boolean
}

export interface QueueSnapshot {
  /** 正在上游跑的数量。 */
  active: number
  /** 在本地排队的数量。 */
  queued: number
  /** 上限（诊断用）。 */
  maxConcurrent: number
  maxQueue: number
}

export class LoomyQueueGate {
  private active = 0
  private readonly waiters: Waiter[] = []
  private readonly maxConcurrent: number
  private readonly maxQueue: number
  private readonly cooldownMs: number
  private disposed = false

  constructor(options: { maxConcurrent?: number; maxQueue?: number; cooldownMs?: number } = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENCY)
    this.maxQueue = Math.max(0, options.maxQueue ?? DEFAULT_MAX_QUEUE)
    this.cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_QUEUE_COOLDOWN_MS)
  }

  /**
   * 申请一个生成位。
   *
   * @returns `true` = 拿到了，用完必须 `release()`；`false` = 队列已满（调用方回 429）。
   */
  async acquire(signal?: AbortSignal): Promise<boolean> {
    if (this.disposed) return false
    if (signal?.aborted === true) return false
    if (this.active < this.maxConcurrent && this.waiters.length === 0) {
      this.active += 1
      return true
    }
    if (this.waiters.length >= this.maxQueue) return false
    return await new Promise<boolean>(resolve => {
      const waiter: Waiter = { resolve, granted: false }
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter)
        if (index === -1) return
        this.waiters.splice(index, 1)
        if (waiter.timer !== undefined) clearTimeout(waiter.timer)
        resolve(false)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const originalResolve = waiter.resolve
      waiter.resolve = granted => {
        signal?.removeEventListener('abort', onAbort)
        originalResolve(granted)
      }
      this.waiters.push(waiter)
      this.pump()
    })
  }

  /** 释放一个生成位，并让队首入场。 */
  release(): void {
    if (this.active > 0) this.active -= 1
    this.pump()
  }

  /** 队列里还有几个在等。 */
  queued(): number {
    return this.waiters.length
  }

  snapshot(): QueueSnapshot {
    return {
      active: this.active,
      queued: this.waiters.length,
      maxConcurrent: this.maxConcurrent,
      maxQueue: this.maxQueue,
    }
  }

  /** 撤掉所有等待者（插件停用）。 */
  dispose(): void {
    this.disposed = true
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      waiter.resolve(false)
    }
  }

  /** 有空位就把队首放进来（排队过的请求先冷却一小会儿）。 */
  private pump(): void {
    if (this.disposed) return
    while (this.active < this.maxConcurrent) {
      const waiter = this.waiters.shift()
      if (waiter === undefined) return
      const grant = (): void => {
        if (waiter.granted) return
        waiter.granted = true
        this.active += 1
        waiter.resolve(true)
      }
      if (this.cooldownMs === 0) {
        grant()
        continue
      }
      // 已入队过：先等冷却再真正占位，避免上游还没准备好就撞上去。
      waiter.timer = setTimeout(grant, this.cooldownMs)
      waiter.timer.unref?.()
      return
    }
  }
}
