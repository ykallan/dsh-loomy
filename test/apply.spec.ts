import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LOOMY_PROVIDER, LOOMY_SETTINGS_NS, apply, inject, name } from '../src/index.ts'

/**
 * 宿主侧集成测试：用一个假的 cordis Context 把 `apply()` 跑起来。
 *
 * 它验证的是「装配」而不是上游行为：路由有没有全部挂上、provider 有没有真的注册、
 * 状态接口在没有任何账号时是否给出可用的空状态、以及 loopback 门禁是否生效。
 */

interface RegisteredRoute {
  kind: string
  path: string
  handler: (req: FakeRequest, res: FakeResponse) => Promise<void>
}

interface FakeRequest {
  method: string
  url: string
  headers: Record<string, string | undefined>
  /** 请求体（POST 用）；`on` 会把它当成一次 data/end 事件发出去。 */
  body?: string
  on: (event: string, handler: (chunk?: Buffer) => void) => void
  destroy: () => void
}

interface FakeResponse {
  status?: number
  body?: string
  writeHead: (status: number, headers?: Record<string, unknown>) => void
  end: (payload?: string) => void
  on: () => void
  off: () => void
}

function fakeRes(): FakeResponse {
  return {
    writeHead(status) {
      this.status = status
    },
    end(payload) {
      this.body = payload
    },
    on() {},
    off() {},
  }
}

function fakeReq(overrides: Partial<FakeRequest> = {}): FakeRequest {
  const body = overrides.body ?? ''
  return {
    method: 'GET',
    url: '/api/loomy/status',
    headers: { host: '127.0.0.1:58852' },
    ...overrides,
    // `readBody()` 是「先挂 data、再挂 end」，所以这里同步发事件就能把请求体喂完。
    on(event, handler) {
      if (event === 'data' && body !== '') handler(Buffer.from(body))
      if (event === 'end') handler()
    },
    destroy() {},
  }
}

function fakeContext(): {
  ctx: Record<string, unknown>
  routes: RegisteredRoute[]
  adapters: string[][]
  directory: unknown[]
  /** 记下每次 settings.update 的补丁（用于断言「模式」有没有跟着勾选一起落盘）。 */
  settingsWrites: Record<string, unknown>[]
  dispose: () => void
} {
  const routes: RegisteredRoute[] = []
  const adapters: string[][] = []
  const directory: unknown[] = []
  const settingsWrites: Record<string, unknown>[] = []
  const disposers: (() => void)[] = []
  const noop = (): void => {}
  const logger = { debug: noop, info: noop, warn: noop, error: noop }
  const handle = (): void => {}
  // 宿主在真实环境里提供 settings 服务；这里给一个只记账的替身。只写 enabledModels 的话，
  // 「全选」与「全不选」都是空数组 —— 所以必须能看到模式一起被写下去。
  const settings = {
    async update(_ns: unknown, patch: Record<string, unknown>) {
      settingsWrites.push(patch)
    },
  }
  const ctx = {
    logger,
    get: (name: string) => (name === 'settings' ? settings : undefined),
    // 真实的 cordis 子上下文与父上下文共享全部服务；这里也把同一个对象传下去。
    inject: (names: readonly string[], callback: (sub: unknown) => void) => {
      if (!names.includes('webServer')) return
      callback(ctx)
    },
    webServer: {
      register: (spec: RegisteredRoute) => {
        routes.push(spec)
        return () => {}
      },
    },
    effect: (factory: () => (() => void) | void) => {
      const result = factory()
      if (typeof result === 'function') disposers.push(result)
    },
    llm: {
      registerAdapter: (providers: string[]) => {
        adapters.push(providers)
        return Object.assign(handle, { replace: handle })
      },
      registerConfigurableProviders: (entries: unknown[]) => {
        directory.push(...entries)
        return Object.assign(handle, { replace: handle })
      },
    },
  }
  return {
    ctx,
    routes,
    adapters,
    directory,
    settingsWrites,
    dispose: () => {
      for (const disposer of disposers) {
        try {
          disposer()
        } catch {
          // 拆解失败不影响断言。
        }
      }
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

const dirs: string[] = []

afterEach(() => {
  delete process.env.DSH_HOME
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-loomy-apply-'))
  dirs.push(dir)
  process.env.DSH_HOME = dir
  return dir
}

describe('plugin identity', () => {
  it('declares a stable name and a single hard dependency', () => {
    expect(name).toBe('llm-loomy')
    expect(inject).toEqual(['llm'])
    expect(LOOMY_PROVIDER).toBe('loomy')
    expect(String(LOOMY_SETTINGS_NS)).toBe('loomy')
  })
})

describe('apply()', () => {
  it('mounts every route under /api/loomy/', async () => {
    tempHome()
    const { ctx, routes, dispose } = fakeContext()
    apply(ctx as never, {})
    try {
      await waitFor(() => routes.length > 0)
      const paths = routes.map(route => route.path).sort()
      expect(paths).toEqual([
        '/api/loomy/accounts',
        '/api/loomy/dock',
        '/api/loomy/doctor',
        '/api/loomy/enabled-models',
        '/api/loomy/login',
        '/api/loomy/models',
        '/api/loomy/points',
        '/api/loomy/refresh-models',
        '/api/loomy/selection/invert',
        '/api/loomy/session',
        '/api/loomy/sms',
        '/api/loomy/status',
      ])
      // 每个席位只注册一次：宿主对同一个 (kind, path) 只留一个注册位。
      expect(new Set(paths).size).toBe(paths.length)
      expect(routes.every(route => route.kind === 'exact')).toBe(true)
    } finally {
      dispose()
    }
  })

  it('registers the loomy provider and its directory entry', async () => {
    tempHome()
    const { ctx, adapters, directory, dispose } = fakeContext()
    apply(ctx as never, {})
    try {
      await waitFor(() => adapters.length > 0 && directory.length > 0)
      expect(adapters).toEqual([['loomy']])
      expect(directory[0]).toMatchObject({ provider: 'loomy', displayName: 'Loomy' })
    } finally {
      dispose()
    }
  })

  it('answers the status route with an empty but complete document', async () => {
    tempHome()
    const { ctx, routes, dispose } = fakeContext()
    apply(ctx as never, {})
    try {
      await waitFor(() => routes.length === 12)
      const route = routes.find(entry => entry.path === '/api/loomy/status')
      expect(route).toBeDefined()

      interface StatusDoc {
        status?: {
          provider: string
          signedIn: boolean
          accounts: unknown[]
          models: unknown[]
          providerRegistered: boolean
          shim: { port: number }
          strategy: string
          pointsNote: string
        }
      }
      const readStatus = async (): Promise<{ doc: StatusDoc; res: FakeResponse }> => {
        const res = fakeRes()
        await route?.handler(fakeReq(), res)
        return { doc: JSON.parse(res.body ?? '{}') as StatusDoc, res }
      }

      // provider 是 shim 起来之后才注册的；直接轮询状态文档，直到它变 true。
      let read = await readStatus()
      for (let attempt = 0; attempt < 100 && read.doc.status?.providerRegistered !== true; attempt += 1) {
        await new Promise<void>(resolve => setTimeout(resolve, 10))
        read = await readStatus()
      }
      const status = read.doc.status
      expect(read.res.status).toBe(200)
      expect(status?.provider).toBe('loomy')
      expect(status?.signedIn).toBe(false)
      expect(status?.accounts).toEqual([])
      expect(status?.models).toEqual([])
      expect(status?.providerRegistered).toBe(true)
      expect(status?.shim.port).toBeGreaterThan(0)
      expect(status?.strategy).toBe('balance')
      expect(status?.pointsNote).toMatch(/points/i)
      // 凭证（会话/密码）绝不能出现在状态文档里。
      expect(read.res.body ?? '').not.toContain('"password"')
      expect(read.res.body ?? '').not.toContain('"session"')
    } finally {
      dispose()
    }
  })

  it('rejects a non-loopback Host header', async () => {
    tempHome()
    const { ctx, routes, dispose } = fakeContext()
    apply(ctx as never, {})
    try {
      await waitFor(() => routes.length === 12)
      const route = routes.find(entry => entry.path === '/api/loomy/status')
      const res = fakeRes()
      await route?.handler(fakeReq({ headers: { host: 'evil.example.com' } }), res)
      expect(res.status).toBe(403)
    } finally {
      dispose()
    }
  })

  it('rejects a cross-origin Origin header', async () => {
    tempHome()
    const { ctx, routes, dispose } = fakeContext()
    apply(ctx as never, {})
    try {
      await waitFor(() => routes.length === 12)
      const route = routes.find(entry => entry.path === '/api/loomy/status')
      const res = fakeRes()
      await route?.handler(fakeReq({ headers: { host: '127.0.0.1:58852', origin: 'https://evil.example.com' } }), res)
      expect(res.status).toBe(403)
    } finally {
      dispose()
    }
  })

  it('refuses a write without the JSON content type', async () => {
    tempHome()
    const { ctx, routes, dispose } = fakeContext()
    apply(ctx as never, {})
    try {
      await waitFor(() => routes.length === 12)
      const route = routes.find(entry => entry.path === '/api/loomy/dock')
      const res = fakeRes()
      await route?.handler(fakeReq({ method: 'POST', url: '/api/loomy/dock', headers: { host: '127.0.0.1:58852' } }), res)
      expect(res.status).toBe(415)
    } finally {
      dispose()
    }
  })

  it('reports a failed login attempt as a 400 with the upstream reason', async () => {
    tempHome()
    const { ctx, routes, dispose } = fakeContext()
    apply(ctx as never, {})
    try {
      await waitFor(() => routes.length === 12)
      const route = routes.find(entry => entry.path === '/api/loomy/login')
      const res = fakeRes()
      await route?.handler(fakeReq({
        method: 'POST',
        url: '/api/loomy/login',
        headers: { host: '127.0.0.1:58852', 'content-type': 'application/json' },
      }), res)
      expect(res.status).toBe(400)
      expect(res.body ?? '').toContain('loginid')
    } finally {
      dispose()
    }
  })

  it('reports a missing account id as a 400 instead of throwing', async () => {
    tempHome()
    const { ctx, routes, dispose } = fakeContext()
    apply(ctx as never, {})
    try {
      await waitFor(() => routes.length === 12)
      const route = routes.find(entry => entry.path === '/api/loomy/accounts')
      const res = fakeRes()
      await route?.handler(fakeReq({
        method: 'POST',
        url: '/api/loomy/accounts',
        headers: { host: '127.0.0.1:58852', 'content-type': 'application/json' },
      }), res)
      expect(res.status).toBe(400)
      expect(res.body ?? '').toContain('missing id')
    } finally {
      dispose()
    }
  })

  it('answers the doctor route with a structured report', async () => {
    tempHome()
    const { ctx, routes, dispose } = fakeContext()
    apply(ctx as never, {})
    try {
      await waitFor(() => routes.length === 12)
      const route = routes.find(entry => entry.path === '/api/loomy/doctor')
      let parsed: { report: { ok: boolean; checks: { id: string; ok: boolean }[] } } = { report: { ok: true, checks: [] } }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const res = fakeRes()
        await route?.handler(fakeReq({ url: '/api/loomy/doctor' }), res)
        parsed = JSON.parse(res.body ?? '{}') as typeof parsed
        if (parsed.report.checks.find(check => check.id === 'provider')?.ok === true) break
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      }
      expect(parsed.report.checks.map(check => check.id)).toContain('provider')
      expect(parsed.report.checks.find(check => check.id === 'provider')?.ok).toBe(true)
      expect(parsed.report.ok).toBe(false)
    } finally {
      dispose()
    }
  })

  it('stores the selection mode together with the checked ids', async () => {
    tempHome()
    const { ctx, routes, settingsWrites, dispose } = fakeContext()
    apply(ctx as never, {})
    try {
      await waitFor(() => routes.length === 12)
      const route = routes.find(entry => entry.path === '/api/loomy/enabled-models')
      const post = async (body: unknown): Promise<FakeResponse> => {
        const res = fakeRes()
        await route?.handler(fakeReq({
          method: 'POST',
          url: '/api/loomy/enabled-models',
          headers: { host: '127.0.0.1:58852', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }), res)
        return res
      }

      // 「全不选」必须能和「全选」区分开：两者都是空 enabledModels，靠模式分辨。
      const none = await post({ mode: 'none', enabledModels: [] })
      expect(none.status).toBe(200)
      expect(settingsWrites.at(-1)).toEqual({ modelSelectionMode: 'none', enabledModels: [] })

      const all = await post({ mode: 'all', enabledModels: [] })
      expect(all.status).toBe(200)
      expect(settingsWrites.at(-1)).toEqual({ modelSelectionMode: 'all', enabledModels: [] })

      const custom = await post({ mode: 'custom', enabledModels: ['spark-x'] })
      expect(custom.status).toBe(200)
      expect(settingsWrites.at(-1)).toEqual({ modelSelectionMode: 'custom', enabledModels: ['spark-x'] })

      // 老客户端不带 mode：按旧约定推断（非空 = custom）。
      const legacy = await post({ enabledModels: ['spark-x'] })
      expect(legacy.status).toBe(200)
      expect(settingsWrites.at(-1)).toEqual({ modelSelectionMode: 'custom', enabledModels: ['spark-x'] })

      const bad = await post({ mode: 'every', enabledModels: [] })
      expect(bad.status).toBe(400)
    } finally {
      dispose()
    }
  })

  it('keeps a legacy enabledModels list working as a custom selection', async () => {
    tempHome()
    const { ctx, routes, dispose } = fakeContext()
    // 升级前存下来的配置只有 enabledModels，没有模式键。
    apply(ctx as never, { enabledModels: ['spark-x'] })
    try {
      await waitFor(() => routes.length === 12)
      const route = routes.find(entry => entry.path === '/api/loomy/enabled-models')
      const res = fakeRes()
      await route?.handler(fakeReq(), res)
      const parsed = JSON.parse(res.body ?? '{}') as { selection: { mode: string } }
      expect(res.status).toBe(200)
      expect(parsed.selection.mode).toBe('custom')
    } finally {
      dispose()
    }
  })

  it('answers the invert route and rejects a non-JSON write', async () => {
    tempHome()
    const { ctx, routes, settingsWrites, dispose } = fakeContext()
    apply(ctx as never, {})
    try {
      await waitFor(() => routes.length === 12)
      const route = routes.find(entry => entry.path === '/api/loomy/selection/invert')
      expect(route).toBeDefined()

      // 没有设置服务之外的问题时，反选会算出补集并落盘；目录为空时按当前选择原样写回。
      const res = fakeRes()
      await route?.handler(fakeReq({
        method: 'POST',
        url: '/api/loomy/selection/invert',
        headers: { host: '127.0.0.1:58852', 'content-type': 'application/json' },
        body: '{}',
      }), res)
      expect(res.status).toBe(200)
      expect(settingsWrites).toHaveLength(1)
      expect(settingsWrites[0]).toEqual({ modelSelectionMode: 'all', enabledModels: [] })

      const plain = fakeRes()
      await route?.handler(fakeReq({
        method: 'POST',
        url: '/api/loomy/selection/invert',
        headers: { host: '127.0.0.1:58852' },
      }), plain)
      expect(plain.status).toBe(415)

      const wrongMethod = fakeRes()
      await route?.handler(fakeReq({ url: '/api/loomy/selection/invert' }), wrongMethod)
      expect(wrongMethod.status).toBe(405)

      const foreign = fakeRes()
      await route?.handler(fakeReq({
        method: 'POST',
        url: '/api/loomy/selection/invert',
        headers: { host: 'evil.example.com', 'content-type': 'application/json' },
        body: '{}',
      }), foreign)
      expect(foreign.status).toBe(403)
    } finally {
      dispose()
    }
  })
})
