import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AccountService,
  LoginError,
  accountKeyOf,
  maskPhone,
  newIdentity,
  readLoginResult,
} from '../src/login.ts'

/**
 * 账号服务客户端。用假的 `fetch` 覆盖整条登录链路，不打真实上游。
 */

interface Captured {
  url: string
  headers: Record<string, string>
  body: string
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function capture(
  handler: (request: Captured) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: Captured = {
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : '',
    }
    calls.push(request)
    return await handler(request)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('newIdentity', () => {
  it('gives every account a distinct devid in per_account mode', () => {
    const a = newIdentity('per_account')
    const b = newIdentity('per_account')
    expect(a.devid).toMatch(/^web-[0-9a-f]{16}$/)
    expect(a.devid).not.toBe(b.devid)
    expect(a.ua).toBe('Loomy|Desktop|Electron|macOS')
    expect(a.modelid).toBe('Web')
    expect(a.version).toBe('1.0.0')
    expect(a.campusDeviceId).toMatch(/^loomy-campus-/)
  })

  it('mirrors the shipped client in client mode', () => {
    const identity = newIdentity('client')
    expect(identity.devid).toBe('web')
    expect(identity.campusDeviceId).toBeUndefined()
  })
})

describe('AccountService', () => {
  it('signs every call and puts the client envelope in the body', async () => {
    const { fetchImpl, calls } = capture(() => jsonResponse({ code: '000000', data: { pukey: 'x', rcode: 'r' } }))
    const service = new AccountService({
      baseUrl: 'https://account.example',
      accessKeyId: 'ak-id',
      accessKeySecret: 'ak-secret',
      fetchImpl,
    })
    await service.getPublicKey()

    const call = calls[0]
    expect(call?.url).toBe('https://account.example/login/account/getPuKey')
    expect(call?.headers.Authorization).toMatch(/^account ak-id:/)
    expect(call?.headers.Nonce).toBeTruthy()
    expect(call?.headers.Date).toMatch(/GMT$/)
    expect(call?.headers['Content-MD5']).toBeTruthy()

    const body = JSON.parse(call?.body ?? '{}') as { base?: Record<string, string> }
    expect(body.base?.appid).toBe('GM3LOOMY')
    expect(body.base?.devid).toBe('web')
    expect(body.base?.traceid).toMatch(/^[0-9a-f]{32}$/)
  })

  it('logs in with the password encrypted under the server key', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pukey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const { fetchImpl, calls } = capture(request => {
      if (request.url.endsWith('/getPuKey')) {
        return jsonResponse({ code: '000000', data: { pukey, rcode: 'rcode-1' } })
      }
      return jsonResponse({
        code: '000000',
        data: { session: 'session-abc', userid: 'uid-1', phone: '13800000000' },
      })
    })
    const service = new AccountService({ baseUrl: 'https://account.example', fetchImpl })
    const result = await service.loginByPassword('13800000000', 'p@ssw0rd')
    expect(result.session).toBe('session-abc')
    expect(result.userid).toBe('uid-1')
    expect(result.expireAt - result.obtainedAt).toBe(14 * 24 * 3600 * 1000)

    const login = JSON.parse(calls[1]?.body ?? '{}') as { param?: Record<string, unknown> }
    expect(login.param?.loginid).toBe('13800000000')
    expect(login.param?.rcode).toBe('rcode-1')
    expect(login.param?.expire).toBe(1209600)
    expect(login.param?.password).not.toBe('p@ssw0rd')

    const decrypted = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(String(login.param?.password), 'base64'),
    )
    expect(decrypted.toString('utf8')).toBe('p@ssw0rd')
  })

  it('reads the msgid out of the SMS response and posts it back', async () => {
    const { fetchImpl, calls } = capture(request => {
      if (request.url.endsWith('/sendMsgCode')) return jsonResponse({ code: '000000', data: { msgid: 'msg-1' } })
      return jsonResponse({ code: '000000', data: { session: 'sms-session', userid: 'uid-2' } })
    })
    const service = new AccountService({ baseUrl: 'https://account.example', fetchImpl })
    const msgid = await service.sendSmsCode('13900000000')
    expect(msgid).toBe('msg-1')
    const result = await service.loginBySms('13900000000', '123456', msgid)
    expect(result.session).toBe('sms-session')
    const body = JSON.parse(calls[1]?.body ?? '{}') as { param?: Record<string, unknown> }
    expect(body.param?.mcode).toBe('123456')
    expect(body.param?.msgid).toBe('msg-1')
  })

  it('surfaces a business code as a LoginError', async () => {
    const { fetchImpl } = capture(() => jsonResponse({ code: '100001', desc: 'system busy' }))
    const service = new AccountService({ baseUrl: 'https://account.example', fetchImpl })
    await expect(service.getPublicKey()).rejects.toBeInstanceOf(LoginError)
    await expect(service.getPublicKey()).rejects.toThrow(/system busy/)
  })

  it('treats a non-JSON answer as a server error', async () => {
    const { fetchImpl } = capture(() => new Response('<html>gateway</html>', { status: 502 }))
    const service = new AccountService({ baseUrl: 'https://account.example', fetchImpl })
    await expect(service.getPublicKey()).rejects.toThrow(/HTTP 502/)
  })

  it('treats a network failure as kind network', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    const service = new AccountService({ baseUrl: 'https://account.example', fetchImpl })
    await expect(service.getPublicKey()).rejects.toMatchObject({ kind: 'network' })
  })

  it('requires a phone number and a password locally', async () => {
    const service = new AccountService({ baseUrl: 'https://account.example', fetchImpl: capture(() => jsonResponse({})) .fetchImpl })
    await expect(service.loginByPassword('', 'x')).rejects.toThrow(/phone number is required/)
    await expect(service.loginByPassword('13800000000', '')).rejects.toThrow(/password is required/)
  })
})

describe('readLoginResult', () => {
  it('accepts a data-wrapped and a flat payload', () => {
    expect(readLoginResult({ data: { session: 's' } }, '138').session).toBe('s')
    expect(readLoginResult({ session: 't' }, '138').session).toBe('t')
  })

  it('refuses a login without a session', () => {
    expect(() => readLoginResult({ data: { userid: 'x' } }, '138')).toThrow(/returned no session/)
  })
})

describe('accountKeyOf / maskPhone', () => {
  it('prefers userid, then phone, then a session hash', () => {
    expect(accountKeyOf({ userid: 'uid', loginid: '138' })).toBe('uid')
    expect(accountKeyOf({ loginid: '138' })).toBe('138')
    expect(accountKeyOf({ session: 'abc' })).toMatch(/^s[0-9a-f]{15}$/)
  })

  it('masks all but the first three and last four digits', () => {
    expect(maskPhone('13800000000')).toBe('138****0000')
    expect(maskPhone('123')).toBe('123')
    expect(maskPhone(undefined)).toBeUndefined()
  })
})
