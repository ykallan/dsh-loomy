/**
 * 本机回环 shim：把 pi-ai 的 OpenAI 请求翻译成 Loomy 模型网关的请求。
 *
 * 为什么要有这一层，而不是让适配器直连上游：
 *
 * - 上游要求一批 pi-ai 不会发的头（`token` / `traceparent` / `loomy-version`），
 *   其中 `traceparent` 缺了上游会**挂到超时**（`upstream.ts`）；
 * - 会话是账号级的，多账号轮转、失败换号、额度冷却都发生在这一层；
 * - 并发闸门、点数记账、用量台账也只能在这里做（响应是流式的，适配器只看得到文本）。
 *
 * 适配器那边只需把 `baseUrl` 指向这里、apiKey 用这里发的随机 secret，其余照旧。
 *
 * @module dsh-loomy/shim
 */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  DEFAULT_MAX_QUEUE,
  DEFAULT_QUEUE_COOLDOWN_MS,
  DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS,
  MAX_ACCOUNT_ATTEMPTS,
  envNumber,
  exposedModelId,
  upstreamModelId,
} from './config.ts'
import type { LoomyAccountStore } from './accounts.ts'
import type { LoomyAccountPool } from './account-pool.ts'
import { resolveSelection, type LoomyCatalog, type LoomyModelInfo, type Selection } from './catalog.ts'
import { LoomyQueueGate, QUEUE_FULL_MESSAGE } from './queue.ts'
import { looksLikeQuotaExhausted, type LoomyPointsTracker } from './points.ts'
import type { LoomyUsageTracker } from './usage.ts'
import {
  buildModelHeaders,
  chatUrl,
  classifyUpstreamError,
  firstFrameError,
  readErrorText,
  usageFromJson,
  usageFromSseLine,
  type ChatUsage,
  type UpstreamError,
} from './upstream.ts'
import { hostIsLoopback } from './loopback.ts'

/** 等一个本地槽位最多等多久。 */
const SLOT_WAIT_MS = 5_000

/** 请求体上限。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** 探首帧时最多缓冲多少字节。 */
const PEEK_LIMIT = 8 * 1024

/** 额度用尽后的冷却（点数不会几秒就回来）。 */
const QUOTA_COOLDOWN_MS = 10 * 60_000

export interface LoomyShimOptions {
  store: LoomyAccountStore
  pool: LoomyAccountPool
  catalog: LoomyCatalog
  usage: LoomyUsageTracker
  /** 点数缓存：「额度用尽」标记与余额读数。 */
  points: LoomyPointsTracker
  /** 用户勾选的模型（模式 + id；缺省全给）。 */
  selection?: () => Selection
  logger?: { debug: (message: string) => void; warn: (message: string, ...rest: unknown[]) => void }
}

/** shim 对外句柄。 */
export interface LoomyShim {
  baseUrl(): string
  token(): string
  ready: Promise<void>
  close(): Promise<void>
  stats(): ShimStats
}

/** 诊断快照。 */
export interface ShimStats {
  port: number
  lastAccount?: string
  lastModel?: string
  lastError?: string
  lastStatus?: number
  lastLatencyMs?: number
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** OpenAI 风格的错误体（pi-ai 认识这个形状）。 */
function openAiError(res: ServerResponse, status: number, message: string, type = 'upstream_error'): void {
  json(res, status, { error: { message, type, code: status } })
}

function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', error => reject(error))
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 模型校验：上游对不认识的 id **静默回退**到默认模型，所以未知 id 必须在这里拦下来。
 *
 * 目录为空（还没登录/还没发现）时放行 —— 这时上游会自己报错，比本地拦一道更诚实。
 */
export function resolveRequestedModel(
  catalog: LoomyCatalog,
  requested: string,
): { wire: string; info?: LoomyModelInfo; unknown?: string } {
  const wire = upstreamModelId(requested)
  if (wire === '') {
    return catalog.current().length === 0
      ? { wire }
      : { wire, unknown: 'the request carried no model id' }
  }
  const info = catalog.find(wire)
  if (info !== undefined) return { wire: info.id, info }
  if (catalog.current().length === 0) return { wire }
  return { wire, unknown: `unknown model "${wire}" (upstream would silently answer with its default model)` }
}

export function createLoomyShim(options: LoomyShimOptions): LoomyShim {
  const { store, pool, catalog, usage, points, logger } = options
  const secret = randomUUID().replace(/-/g, '')
  const queue = new LoomyQueueGate({
    maxConcurrent: envNumber('LOOMY_MAX_CONCURRENCY', 1),
    maxQueue: envNumber('LOOMY_MAX_QUEUE', DEFAULT_MAX_QUEUE),
    cooldownMs: envNumber('LOOMY_QUEUE_COOLDOWN_MS', DEFAULT_QUEUE_COOLDOWN_MS),
  })
  const idleTimeoutMs = envNumber('UPSTREAM_IDLE_TIMEOUT_MS', DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS)
  let server: Server | undefined
  let port = 0
  const stats: ShimStats = { port: 0 }

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const value = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim()
    return value === secret
  }

  const handleModels = (req: IncomingMessage, res: ServerResponse): void => {
    if (!hostIsLoopback(req.headers.host)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    const models = resolveSelection(catalog.current(), options.selection?.() ?? { mode: 'all', enabled: [] })
    json(res, 200, {
      object: 'list',
      data: models.map(model => ({
        id: exposedModelId(model.id),
        object: 'model',
        owned_by: 'loomy',
        name: model.name,
        ...model.contextWindowKnown === true ? { context_length: model.contextWindow } : {},
        ...model.maxTokens > 0 ? { max_output_tokens: model.maxTokens } : {},
        capabilities: {
          reasoning: model.reasoning === true,
          vision: model.supportsImages,
          function_calling: model.toolCall === true,
          streaming: model.streaming !== false,
        },
      })),
    })
  }

  /** 把上游响应写回 pi-ai，并记账。 */
  const pipeUpstream = async (
    res: ServerResponse,
    params: {
      response: Response
      stream: boolean
      accountId: string
      wireModel: string
      started: number
    },
  ): Promise<void> => {
    const { response, stream, accountId, wireModel, started } = params
    let usageRecord: ChatUsage = {}
    try {
      if (!stream) {
        const text = await response.text()
        try {
          usageRecord = usageFromJson(JSON.parse(text) as unknown)
        } catch {
          // 不是 JSON 也照原样透传：pi-ai 会给出可读的解析错误。
        }
        usage.record(buildUsageEvent(accountId, wireModel, started, usageRecord, true))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
        res.end(text)
        return
      }

      const body = response.body
      if (body === null) {
        openAiError(res, 502, 'dsh-loomy: upstream returned an empty stream')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let carry = ''
      let peeked = ''
      let decided = false
      /** 中途断流 / 上游报错时置位：账本要如实记成一次失败。 */
      let failed = false
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const armIdle = (): void => {
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          logger?.warn('dsh-loomy: upstream stream idle timeout; aborting this turn')
          void reader.cancel().catch(() => {})
        }, idleTimeoutMs)
        idleTimer.unref?.()
      }
      try {
        armIdle()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value === undefined) continue
          armIdle()
          let text = decoder.decode(value, { stream: true })
          if (!decided) {
            peeked += text
            // 上游有时以 200 + SSE 报错：第一帧是 {"error":…}。先探一帧再决定怎么回。
            if (peeked.length < PEEK_LIMIT && !peeked.includes('\n')) continue
            decided = true
            const early = firstFrameError(peeked)
            if (early !== undefined) {
              await reader.cancel().catch(() => {})
              const classified = classifyUpstreamError(400, early)
              stats.lastError = `early: ${early}`
              openAiError(res, 502, classified.message, classified.kind)
              usage.record(buildUsageEvent(accountId, wireModel, started, {}, false))
              return
            }
            text = peeked
            peeked = ''
          }
          carry += text
          const newline = carry.lastIndexOf('\n')
          if (newline !== -1) {
            const complete = carry.slice(0, newline)
            carry = carry.slice(newline + 1)
            for (const line of complete.split('\n')) {
              const usageLine = usageFromSseLine(line)
              if (usageLine !== undefined) usageRecord = usageLine
            }
          }
          res.write(value)
        }
        if (carry !== '') {
          const usageLine = usageFromSseLine(carry)
          if (usageLine !== undefined) usageRecord = usageLine
        }
      } catch (error: unknown) {
        failed = true
        logger?.debug(`dsh-loomy: upstream stream ended early (${error instanceof Error ? error.message : String(error)})`)
      } finally {
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        res.end()
        usage.record(buildUsageEvent(accountId, wireModel, started, usageRecord, !failed))
        if (usageRecord.pointsConsumed !== undefined) {
          // 有明确扣点数就说明这个号还能花：清掉「额度用尽」标记。
          points.noteServed(accountId)
        }
      }
    } finally {
      // Loomy 没有 exitSessionQueue 那种槽位要放；这里什么都不用做。
    }
  }

  const handleChat = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!hostIsLoopback(req.headers.host)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (!authorized(req)) {
      openAiError(res, 401, 'dsh-loomy: missing or wrong shim token', 'auth_error')
      return
    }
    let body: Record<string, unknown>
    try {
      const parsed = JSON.parse(await readBody(req)) as unknown
      if (!isObject(parsed)) throw new Error('not an object')
      body = parsed
    } catch {
      openAiError(res, 400, 'dsh-loomy: request body is not a JSON object', 'invalid_request_error')
      return
    }

    const stream = body.stream === true
    const requestedModel = typeof body.model === 'string' ? body.model : ''
    const resolvedModel = resolveRequestedModel(catalog, requestedModel)
    if (resolvedModel.unknown !== undefined) {
      openAiError(res, 400, `dsh-loomy: ${resolvedModel.unknown}`, 'invalid_request_error')
      return
    }
    const wireModel = resolvedModel.wire

    // 并发闸门：排不下就直接 429（不要假装还在跑）。
    const granted = await queue.acquire()
    if (!granted) {
      openAiError(res, 429, QUEUE_FULL_MESSAGE, 'rate_limit_error')
      return
    }

    const controller = new AbortController()
    const onClose = (): void => controller.abort()
    res.on('close', onClose)
    const exclude = new Set<string>()
    let lastError: UpstreamError | undefined

    try {
      for (let index = 0; index < MAX_ACCOUNT_ATTEMPTS; index += 1) {
        const ready = await pool.waitForFreeSlot(SLOT_WAIT_MS, controller.signal)
        if (!ready) {
          // 已经有更具体的失败原因（比如 402 额度不足）就原样报出去 —— 把它换成一个
          // 笼统的 429 会让用户以为是排队问题，而实际是号没钱了。
          lastError ??= {
            kind: 'rate-limit',
            status: 429,
            message: 'every Loomy account is busy right now; please retry shortly',
            retryable: false,
            needsLogin: false,
          }
          break
        }
        const accountId = pool.pick(exclude)
        if (accountId === undefined) {
          lastError ??= {
            kind: 'auth',
            status: 401,
            message: 'no usable Loomy account; sign in from the Loomy plugin card',
            retryable: false,
            needsLogin: true,
          }
          break
        }
        if (!pool.acquire(accountId)) {
          exclude.add(accountId)
          continue
        }
        try {
          const resolved = await store.resolve(accountId)
          if (resolved === undefined) {
            pool.disable(accountId, 'session needs sign-in')
            lastError = {
              kind: 'auth',
              status: 401,
              message: 'a Loomy account needs to sign in again',
              retryable: true,
              needsLogin: true,
            }
            exclude.add(accountId)
            continue
          }
          const started = Date.now()
          let response: Response
          try {
            response = await fetch(chatUrl(), {
              method: 'POST',
              headers: buildModelHeaders(resolved.session),
              body: JSON.stringify({ ...body, model: wireModel, stream }),
              signal: controller.signal,
            })
          } catch (error: unknown) {
            usage.record(buildUsageEvent(accountId, wireModel, started, {}, false))
            pool.noteError(accountId, 3, 30_000, 'network error')
            lastError = {
              kind: 'network',
              status: 0,
              message: error instanceof Error ? error.message : String(error),
              retryable: true,
              needsLogin: false,
            }
            exclude.add(accountId)
            continue
          }
          if (response.ok) {
            pool.noteSuccess(accountId)
            points.noteServed(accountId)
            stats.lastAccount = accountId
            stats.lastModel = wireModel
            stats.lastStatus = response.status
            stats.lastLatencyMs = Date.now() - started
            stats.lastError = undefined
            await pipeUpstream(res, { response, stream, accountId, wireModel, started })
            return
          }
          const message = await readErrorText(response)
          const classified = classifyUpstreamError(response.status, message)
          usage.record(buildUsageEvent(accountId, wireModel, started, {}, false))
          stats.lastStatus = response.status
          stats.lastError = `${classified.kind}: ${message}`
          if (looksLikeQuotaExhausted(response.status, message)) {
            points.noteExhausted(accountId, message)
            pool.cooldown(accountId, QUOTA_COOLDOWN_MS, `out of points: ${message}`)
          } else if (classified.needsLogin) {
            // 有密码的账号这里只是「让它等下一次重登」，不判死。
            await store.markRejected(accountId, `upstream ${response.status}: ${message}`)
            if (classified.status === 401) pool.disable(accountId, `upstream ${response.status}`)
          } else if (classified.kind === 'rate-limit' || classified.kind === 'server') {
            pool.noteError(accountId, 3, 20_000, `${classified.kind}: ${message}`)
          }
          lastError = classified
          exclude.add(accountId)
          if (!classified.retryable) break
        } finally {
          pool.release(accountId)
        }
      }
      const error = lastError ?? {
        kind: 'server' as const,
        status: 500,
        message: 'dsh-loomy: no account could serve this request',
        retryable: false,
        needsLogin: false,
      }
      if (!res.headersSent) openAiError(res, error.status === 0 ? 502 : error.status, error.message, error.kind)
      else res.end()
    } finally {
      res.off('close', onClose)
      queue.release()
    }
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(port)}`)
    const path = url.pathname.replace(/\/$/, '')
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      handleModels(req, res)
      return
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      void handleChat(req, res).catch((error: unknown) => {
        logger?.warn('dsh-loomy: shim request failed', error)
        if (!res.headersSent) openAiError(res, 500, error instanceof Error ? error.message : String(error))
        else res.end()
      })
      return
    }
    if (req.method === 'GET' && path === '/health') {
      json(res, 200, { ok: true, accounts: pool.list().length, queue: queue.snapshot(), stats })
      return
    }
    json(res, 404, { error: 'not found' })
  }

  const ready = new Promise<void>((resolve, reject) => {
    const instance = createServer(handler)
    instance.once('error', reject)
    instance.listen(0, '127.0.0.1', () => {
      server = instance
      const address = instance.address() as AddressInfo | null
      port = address?.port ?? 0
      stats.port = port
      resolve()
    })
  })

  return {
    baseUrl: () => `http://127.0.0.1:${String(port)}`,
    token: () => secret,
    ready,
    close: async () => {
      queue.dispose()
      const instance = server
      server = undefined
      if (instance === undefined) return
      await new Promise<void>(resolve => {
        instance.close(() => resolve())
        const timer = setTimeout(resolve, 500)
        timer.unref?.()
      })
    },
    stats: () => ({ ...stats }),
  }
}

/** 一条用量事件（把 `ChatUsage` 摊平）。 */
function buildUsageEvent(
  account: string,
  model: string,
  started: number,
  record: ChatUsage,
  ok: boolean,
): Parameters<LoomyUsageTracker['record']>[0] {
  return {
    account,
    model,
    ok,
    ms: Date.now() - started,
    ...record.inputTokens === undefined ? {} : { inputTokens: record.inputTokens },
    ...record.outputTokens === undefined ? {} : { outputTokens: record.outputTokens },
    ...record.reasoningTokens === undefined ? {} : { reasoningTokens: record.reasoningTokens },
    ...record.pointsConsumed === undefined ? {} : { points: record.pointsConsumed },
  }
}
