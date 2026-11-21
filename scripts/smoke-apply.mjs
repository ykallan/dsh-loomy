#!/usr/bin/env node
/**
 * 离线冒烟：用假的 cordis Context 跑一遍 `apply()`，验证装配与路由。
 *
 * 用法：node scripts/smoke-apply.mjs
 *
 * 它不打真实上游（没有账号就不发请求），也不碰 `~/.dsh`（`DSH_HOME` 指向临时目录）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-loomy-smoke-'))
process.env.DSH_HOME = home

const mod = await import('../lib/index.mjs')

const routes = []
const adapters = []
const directory = []
const errors = []
const disposers = []
const logs = []

const ctx = {
  logger: {
    debug: message => logs.push(['debug', message]),
    info: message => logs.push(['info', message]),
    warn: (message, ...rest) => logs.push(['warn', message, ...rest]),
    error: (message, ...rest) => errors.push([message, ...rest]),
  },
  get: () => undefined,
  inject: (names, callback) => {
    if (names.includes('webServer')) callback(ctx)
  },
  effect: factory => {
    const result = factory()
    if (typeof result === 'function') disposers.push(result)
  },
  webServer: {
    register: spec => {
      routes.push(spec)
      return () => {}
    },
  },
  llm: {
    registerAdapter: providers => {
      adapters.push(providers)
      return Object.assign(() => {}, { replace: () => {} })
    },
    registerConfigurableProviders: entries => {
      directory.push(...entries)
      return Object.assign(() => {}, { replace: () => {} })
    },
  },
}

mod.apply(ctx, {})
await new Promise(resolve => setTimeout(resolve, 300))

console.log('name:', mod.name, '| inject:', JSON.stringify(mod.inject))
console.log('routes:', routes.length, routes.map(route => route.path).sort().join(' '))
console.log('adapters:', JSON.stringify(adapters))
console.log('directory:', JSON.stringify(directory.map(entry => entry.provider)))
console.log('debug log:', logs.filter(([level]) => level === 'debug').map(entry => entry[1]).join(' | '))

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

check('11 routes registered', routes.length === 11, String(routes.length))
check('adapter registered for loomy', JSON.stringify(adapters) === '[["loomy"]]', JSON.stringify(adapters))
check('directory entry registered', directory.length === 1)

const statusRoute = routes.find(route => route.path === '/api/loomy/status')
const res = {
  writeHead(status) {
    this.status = status
  },
  end(payload) {
    this.body = payload
  },
  on() {},
  off() {},
}
await statusRoute.handler({ method: 'GET', url: '/api/loomy/status', headers: { host: '127.0.0.1:58852' } }, res)
const status = JSON.parse(res.body ?? '{}').status ?? {}
check('status route answers 200', res.status === 200, String(res.status))
check('provider registered flag is true', status.providerRegistered === true, String(status.providerRegistered))
check('shim listens on a port', (status.shim?.port ?? 0) > 0, String(status.shim?.port))
check('no account signed in', status.signedIn === false)
check('strategy is reported', typeof status.strategy === 'string', String(status.strategy))
check('no credential in the document', !JSON.stringify(status).includes('password') && !JSON.stringify(status).includes('"session"'))

const guarded = { writeHead(status) { this.status = status }, end(payload) { this.body = payload }, on() {}, off() {} }
await statusRoute.handler({ method: 'GET', url: '/api/loomy/status', headers: { host: 'evil.example.com' } }, guarded)
check('non-loopback Host is rejected', guarded.status === 403, String(guarded.status))

const dockRoute = routes.find(route => route.path === '/api/loomy/dock')
const plain = { writeHead(status) { this.status = status }, end(payload) { this.body = payload }, on() {}, off() {} }
await dockRoute.handler({ method: 'POST', url: '/api/loomy/dock', headers: { host: '127.0.0.1:58852' } }, plain)
check('write without JSON content-type is rejected', plain.status === 415, String(plain.status))

for (const dispose of disposers) {
  try {
    dispose()
  } catch {
    // ignore
  }
}
rmSync(home, { recursive: true, force: true })

if (errors.length > 0) {
  failures += 1
  console.log('plugin errors:')
  for (const entry of errors) console.log('  -', entry.map(String).join(' '))
}

console.log(failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
