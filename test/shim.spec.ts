import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LoomyAccountStore } from '../src/accounts.ts'
import { LoomyAccountPool } from '../src/account-pool.ts'
import { LoomyCatalog } from '../src/catalog.ts'
import { LoomyPointsTracker } from '../src/points.ts'
import { LoomyUsageTracker } from '../src/usage.ts'
import { createLoomyShim, type LoomyShim } from '../src/shim.ts'
import { SESSION_TTL_MS } from '../src/config.ts'

/**
 * shim 的端到端行为：本机假上游 + 真 shim。
 *
 * 这里验证的是**转发**：请求头有没有带全、流式是不是原样透传、用量有没有记账、
 * 未知模型会不会被拦下来、额度用尽会不会冷却账号。不打真实 Loomy。
 */

interface UpstreamRequest {
  path: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

interface FakeUpstream {
  base: string
  requests: UpstreamRequest[]
  /** 下一次 chat 请求返回的状态与正文（用它模拟 402 / 401）。 */
  chatFailure?: { status: number; message: string }
  close: () => Promise<void>
}

async function startUpstream(): Promise<FakeUpstream> {
  const requests: UpstreamRequest[] = []
  const state: { chatFailure?: { status: number; message: string } } = {}
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ path: req.url ?? '', headers: req.headers, body })
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (state.chatFailure !== undefined) {
        const failure = state.chatFailure
        res.writeHead(failure.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: failure.message } }))
        return
      }
      if (path.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          object: 'list',
          data: [{
            id: 'spark-x',
            name: 'Spark X2.5 (x0.1)',
            context_length: 1_048_576,
            capabilities: { reasoning: true, function_calling: true, streaming: true },
          }],
        }))
        return
      }
      if (path.endsWith('/points/records')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: '000000', data: { balance: 100, dailyBalance: 50, availableBalance: 150 } }))
        return
      }
      if (path.endsWith('/chat/completions')) {
        const parsed = JSON.parse(body === '' ? '{}' : body) as { stream?: boolean; model?: string }
        if (parsed.stream === true) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hel' } }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 4, points_consumed: 1 } })}\n\n`)
          res.end('data: [DONE]\n\n')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          model: parsed.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 5, points_consumed: 1 },
        }))
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"not found"}}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${String(port)}/api/v1`,
    requests,
    get chatFailure() {
      return state.chatFailure
    },
    set chatFailure(value) {
      state.chatFailure = value
    },
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

const dirs: string[] = []
const shims: LoomyShim[] = []
const upstreams: FakeUpstream[] = []

afterEach(async () => {
  for (const shim of shims.splice(0)) await shim.close().catch(() => {})
  for (const upstream of upstreams.splice(0)) await upstream.close().catch(() => {})
  delete process.env.LOOMY_UPSTREAM
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup(options: { models?: boolean } = {}): Promise<{
  shim: LoomyShim
  upstream: FakeUpstream
  usage: LoomyUsageTracker
  points: LoomyPointsTracker
  pool: LoomyAccountPool
}> {
  const upstream = await startUpstream()
  upstreams.push(upstream)
  process.env.LOOMY_UPSTREAM = upstream.base

  const dir = mkdtempSync(join(tmpdir(), 'dsh-loomy-shim-'))
  dirs.push(dir)
  const store = new LoomyAccountStore(join(dir, 'accounts.json'))
  const id = await store.addSession({
    session: 'session-1',
    expireAt: Date.now() + SESSION_TTL_MS,
  })
  const points = new LoomyPointsTracker()
  const pool = new LoomyAccountPool([id], { available: accountId => points.available(accountId) })
  const catalog = new LoomyCatalog()
  if (options.models !== false) {
    catalog.set([{
      id: 'spark-x',
      name: 'Spark X2.5 (x0.1)',
      contextWindow: 1_048_576,
      contextWindowKnown: true,
      maxTokens: 32_768,
      supportsImages: false,
      reasoning: true,
      toolCall: true,
    }])
  }
  const usage = new LoomyUsageTracker({ path: join(dir, 'usage.json') })
  const shim = createLoomyShim({
    store,
    pool,
    catalog,
    usage,
    points,
    logger: { debug: () => {}, warn: () => {} },
  })
  shims.push(shim)
  await shim.ready
  return { shim, upstream, usage, points, pool }
}

function chat(shim: LoomyShim, body: Record<string, unknown>, token = shim.token()): Promise<Response> {
  return fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

describe('shim', () => {
  it('serves /v1/models from the catalog', async () => {
    const { shim } = await setup()
    const response = await fetch(`${shim.baseUrl()}/v1/models`)
    expect(response.status).toBe(200)
    const body = await response.json() as { data: { id: string; context_length?: number }[] }
    expect(body.data.map(model => model.id)).toEqual(['spark-x'])
    expect(body.data[0]?.context_length).toBe(1_048_576)
  })

  it('rejects a chat request without the shim token', async () => {
    const { shim } = await setup()
    const response = await chat(shim, { model: 'spark-x', messages: [] }, 'wrong')
    expect(response.status).toBe(401)
  })

  it('forwards a non-streaming request with the required headers and records usage', async () => {
    const { shim, upstream, usage } = await setup()
    const response = await chat(shim, {
      model: 'spark-x',
      messages: [{ role: 'user', content: 'ping' }],
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { choices: { message: { content: string } }[] }
    expect(body.choices[0]?.message.content).toBe('pong')

    const forwarded = upstream.requests.find(request => request.path.includes('/chat/completions'))
    expect(forwarded?.headers.authorization).toBe('Bearer session-1')
    expect(forwarded?.headers.token).toBe('session-1')
    expect(String(forwarded?.headers.traceparent)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(forwarded?.headers['loomy-version']).toBe('0.9.38')

    const snapshot = usage.snapshot()
    expect(snapshot.today.requests).toBe(1)
    expect(snapshot.today.inputTokens).toBe(3)
    expect(snapshot.today.outputTokens).toBe(5)
    expect(snapshot.today.points).toBe(1)
  })

  it('passes a stream through and folds the final usage chunk', async () => {
    const { shim, usage } = await setup()
    const response = await chat(shim, {
      model: 'spark-x',
      stream: true,
      messages: [{ role: 'user', content: 'ping' }],
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('hel')
    expect(text).toContain('lo')
    expect(text).toContain('[DONE]')
    expect(usage.snapshot().today.points).toBe(1)
    expect(usage.snapshot().today.outputTokens).toBe(4)
  })

  it('refuses an unknown model instead of letting the upstream silently fall back', async () => {
    const { shim } = await setup()
    const response = await chat(shim, { model: 'gpt-4o-mini', messages: [] })
    expect(response.status).toBe(400)
    const body = await response.json() as { error: { message: string } }
    expect(body.error.message).toContain('unknown model')
  })

  it('rejects a non-object body', async () => {
    const { shim } = await setup()
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: '[1,2,3]',
    })
    expect(response.status).toBe(400)
  })

  it('cools the account down when the upstream answers 402', async () => {
    const { shim, upstream, pool } = await setup()
    upstream.chatFailure = { status: 402, message: 'insufficient points' }
    const response = await chat(shim, { model: 'spark-x', messages: [{ role: 'user', content: 'x' }] })
    expect(response.status).toBe(402)
    const accounts = pool.list()
    expect(accounts[0]?.coolUntil ?? 0).toBeGreaterThan(Date.now())
  })

  it('exposes a health endpoint with the queue snapshot', async () => {
    const { shim } = await setup()
    const response = await fetch(`${shim.baseUrl()}/health`)
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; queue: { maxConcurrent: number } }
    expect(body.ok).toBe(true)
    expect(body.queue.maxConcurrent).toBe(1)
  })
})
