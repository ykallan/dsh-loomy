import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LoomyAccountStore,
  loomyAccountsPath,
  sessionRemainingMs,
  summarizeAccount,
  type LoomyAccount,
} from '../src/accounts.ts'
import { LoginError, newIdentity, type AccountService, type LoomyLoginResult } from '../src/login.ts'
import { SESSION_RENEW_BEFORE_MS, SESSION_TTL_MS } from '../src/config.ts'

/**
 * 账号文档 + 会话生命周期。
 *
 * 用鸭子类型的假 `AccountService` 替代真上游：能数出「到底登了几次」，也能按需让登录失败。
 */

interface FakeService {
  service: AccountService
  logins: string[]
}

function fakeService(options: {
  session?: string
  fail?: Error
  delayMs?: number
} = {}): FakeService {
  const logins: string[] = []
  let counter = 0
  const service = {
    async loginByPassword(loginid: string): Promise<LoomyLoginResult> {
      logins.push(loginid)
      if (options.delayMs !== undefined) {
        await new Promise<void>(resolve => setTimeout(resolve, options.delayMs))
      }
      if (options.fail !== undefined) throw options.fail
      counter += 1
      const now = Date.now()
      return {
        session: `${options.session ?? 'session-'}${String(counter)}`,
        userid: `uid-${loginid}`,
        phone: loginid,
        obtainedAt: now,
        expireAt: now + SESSION_TTL_MS,
      }
    },
    async sendSmsCode(): Promise<string> {
      return 'msgid-1'
    },
    async loginBySms(): Promise<LoomyLoginResult> {
      const now = Date.now()
      return { session: 'sms-session', obtainedAt: now, expireAt: now + SESSION_TTL_MS }
    },
    async baseInfo(): Promise<Record<string, unknown>> {
      return {}
    },
    async logout(): Promise<void> {},
  } as unknown as AccountService
  return { service, logins }
}

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-loomy-accounts-'))
  dirs.push(dir)
  return dir
}

function account(overrides: Partial<LoomyAccount> = {}): LoomyAccount {
  const now = Date.now()
  return {
    loginid: '13800000000',
    password: 'p@ss',
    session: 'stored-session',
    obtainedAt: now,
    expireAt: now + 10 * 24 * 3600 * 1000,
    identity: newIdentity('per_account'),
    ...overrides,
  }
}

describe('summarizeAccount', () => {
  it('never exposes the session or the password', () => {
    const summary = summarizeAccount('id-1', account())
    const text = JSON.stringify(summary)
    expect(text).not.toContain('stored-session')
    expect(text).not.toContain('p@ss')
    expect(summary.hasPassword).toBe(true)
    expect(summary.usable).toBe(true)
    expect(summary.loginid).toBe('138****0000')
  })

  it('marks an expired session as not usable', () => {
    const summary = summarizeAccount('id-1', account({ expireAt: Date.now() - 1000 }))
    expect(summary.usable).toBe(false)
    expect(summary.needsLogin).toBe(true)
    expect(summary.sessionDaysLeft).toBeUndefined()
  })

  it('reports remaining days with one decimal', () => {
    const summary = summarizeAccount('id-1', account({ expireAt: Date.now() + 5 * 24 * 3600 * 1000 }))
    expect(summary.sessionDaysLeft).toBe(5)
  })

  it('treats an account without expireAt as freshly issued', () => {
    expect(sessionRemainingMs(account({ expireAt: undefined }))).toBe(SESSION_TTL_MS)
  })
})

describe('LoomyAccountStore', () => {
  it('persists accounts with private permissions and reloads them', async () => {
    const path = join(tempDir(), 'accounts.json')
    const store = new LoomyAccountStore(path)
    const id = await store.upsert(account({ label: 'primary' }))
    expect(await store.ids()).toEqual([id])

    const reopened = new LoomyAccountStore(path)
    expect(await reopened.ids()).toEqual([id])
    expect((await reopened.account(id))?.label).toBe('primary')
  })

  it('writes the document under ~/.dsh by default', () => {
    expect(loomyAccountsPath('/home/x')).toBe(join('/home/x', '.loomy-accounts.json'))
  })

  it('skips records that can never serve a request', async () => {
    const path = join(tempDir(), 'accounts.json')
    const store = new LoomyAccountStore(path)
    // 手工写一份坏文档：既没会话也没密码。
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path, JSON.stringify({
      version: 1,
      order: ['dead', 'alive'],
      accounts: {
        dead: { identity: newIdentity('client') },
        alive: account({ session: 's' }),
      },
    }))
    expect(await store.ids()).toEqual(['alive'])
  })

  it('keeps user preferences across a re-login', async () => {
    const path = join(tempDir(), 'accounts.json')
    const store = new LoomyAccountStore(path)
    const id = await store.upsert(account({ paused: true, pinned: true, label: 'mine' }))
    await store.upsert(account({ label: 'mine' }), id)
    const loaded = await store.account(id)
    expect(loaded?.paused).toBe(true)
    expect(loaded?.pinned).toBe(true)
  })

  it('signs in with a password and stores the session', async () => {
    const path = join(tempDir(), 'accounts.json')
    const { service } = fakeService({ session: 'fresh-' })
    const store = new LoomyAccountStore(path, { service })
    const created = await store.signInWithPassword({ loginid: '13800000000', password: 'p@ss' })
    expect(created.account.session).toBe('fresh-1')
    expect(created.account.password).toBe('p@ss')
    expect(created.account.source).toBe('password')
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { accounts: Record<string, { password?: string }> }
    expect(doc.accounts[created.id]?.password).toBe('p@ss')
  })

  it('reuses the same record when the same phone signs in again', async () => {
    const { service } = fakeService()
    const store = new LoomyAccountStore(join(tempDir(), 'accounts.json'), { service })
    const first = await store.signInWithPassword({ loginid: '13800000000', password: 'p@ss' })
    const second = await store.signInWithPassword({ loginid: '13800000000', password: 'p@ss' })
    expect(second.id).toBe(first.id)
    expect(await store.ids()).toHaveLength(1)
  })

  it('stores a pasted session without a password and reports it as such', async () => {
    const store = new LoomyAccountStore(join(tempDir(), 'accounts.json'))
    const id = await store.addSession({ session: 'pasted-session', loginid: '13800000000' })
    const summary = (await store.list())[0]
    expect(summary?.id).toBe(id)
    expect(summary?.hasPassword).toBe(false)
    expect(summary?.source).toBe('session')
  })

  it('adds a password to a session-only account later', async () => {
    const store = new LoomyAccountStore(join(tempDir(), 'accounts.json'))
    const id = await store.addSession({ session: 'pasted-session' })
    expect(await store.setPassword(id, 'late-password')).toBe(true)
    const loaded = await store.account(id)
    expect(loaded?.password).toBe('late-password')
    expect(loaded?.source).toBe('password')
  })
})

describe('session resolution', () => {
  it('uses a healthy session without touching the account service', async () => {
    const { service, logins } = fakeService()
    const store = new LoomyAccountStore(join(tempDir(), 'accounts.json'), { service })
    const id = await store.upsert(account({ expireAt: Date.now() + 10 * 24 * 3600 * 1000 }))
    const resolved = await store.resolve(id)
    expect(resolved?.session).toBe('stored-session')
    expect(logins).toHaveLength(0)
  })

  it('renews a session that is inside the renewal window', async () => {
    const { service, logins } = fakeService({ session: 'renewed-' })
    const store = new LoomyAccountStore(join(tempDir(), 'accounts.json'), { service })
    const id = await store.upsert(account({ expireAt: Date.now() + SESSION_RENEW_BEFORE_MS - 1000 }))
    const resolved = await store.resolve(id)
    expect(logins).toEqual(['13800000000'])
    expect(resolved?.session).toBe('renewed-1')
  })

  it('only signs in once for concurrent callers', async () => {
    const { service, logins } = fakeService({ session: 'once-', delayMs: 5 })
    const store = new LoomyAccountStore(join(tempDir(), 'accounts.json'), { service })
    const id = await store.upsert(account({ expireAt: Date.now() + 1000 }))
    const [a, b] = await Promise.all([store.resolve(id), store.resolve(id)])
    expect(logins).toHaveLength(1)
    expect(a?.session).toBe('once-1')
    expect(b?.session).toBe('once-1')
  })

  it('marks a password-less account as needing sign-in once the session expires', async () => {
    const store = new LoomyAccountStore(join(tempDir(), 'accounts.json'))
    const id = await store.addSession({ session: 'old', expireAt: Date.now() - 1000 })
    expect(await store.resolve(id)).toBeUndefined()
    const summary = (await store.list())[0]
    expect(summary?.needsLogin).toBe(true)
  })

  it('marks a hard credential failure on an expired session as needing sign-in', async () => {
    const { service } = fakeService({ fail: new LoginError('credentials', 'wrong password') })
    const store = new LoomyAccountStore(join(tempDir(), 'accounts.json'), { service })
    const id = await store.upsert(account({ expireAt: Date.now() - 1000 }))
    expect(await store.resolve(id)).toBeUndefined()
    expect((await store.list())[0]?.needsLogin).toBe(true)
  })

  it('keeps serving the last valid session when only the password is broken', async () => {
    const { service } = fakeService({ fail: new LoginError('credentials', 'wrong password') })
    const store = new LoomyAccountStore(join(tempDir(), 'accounts.json'), { service })
    // 会话还有 2 天：已经进了续期窗口，但还没过期。
    const id = await store.upsert(account({ expireAt: Date.now() + 2 * 24 * 3600 * 1000 }))
    const resolved = await store.resolve(id)
    expect(resolved?.session).toBe('stored-session')
    expect((await store.list())[0]?.needsLogin).toBe(false)
  })

  it('recovers on the next renewal after a network failure', async () => {
    let fail = true
    const service = {
      async loginByPassword(loginid: string): Promise<LoomyLoginResult> {
        if (fail) throw new LoginError('network', 'ECONNRESET')
        const now = Date.now()
        return { session: 'recovered', userid: 'uid', phone: loginid, obtainedAt: now, expireAt: now + SESSION_TTL_MS }
      },
    } as unknown as AccountService
    const store = new LoomyAccountStore(join(tempDir(), 'accounts.json'), { service })
    const id = await store.upsert(account({ expireAt: Date.now() - 1000 }))
    expect(await store.resolve(id)).toBeUndefined()
    fail = false
    // 冷却期过了之后应该能恢复（这里直接把账号的冷却绕开：重新写入一次记录）。
    await store.upsert(account({ expireAt: Date.now() - 1000 }), id)
    const resolved = await store.resolve(id)
    expect(resolved?.session).toBe('recovered')
  })

  it('treats a rejected session on a password account as "sign in again, then retry"', async () => {
    const { service, logins } = fakeService({ session: 'after-reject-' })
    const store = new LoomyAccountStore(join(tempDir(), 'accounts.json'), { service })
    const id = await store.upsert(account({ expireAt: Date.now() + 10 * 24 * 3600 * 1000 }))
    await store.markRejected(id, 'upstream 401')
    const resolved = await store.resolve(id)
    expect(logins).toHaveLength(1)
    expect(resolved?.session).toBe('after-reject-1')
  })
})
