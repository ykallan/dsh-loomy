import { describe, expect, it } from 'vitest'
import {
  buildAccountHeaders,
  contentMd5,
  escapedPath,
  escapedQuery,
  httpDate,
  sign,
  stringToSign,
} from '../src/signer.ts'

/**
 * 账号服务签名：九行文本、逐段转义、Content-MD5。
 *
 * 这些用例对着 `docs/PROTOCOL.md` 第 3 节写的，改签名逻辑前先读那一节 ——
 * 少一行、多一行、少转义一个字符，上游只会回 `HMAC signature does not match`。
 */

describe('stringToSign', () => {
  const base = {
    method: 'post',
    path: '/login/account/byPwd',
    body: '{"a":1}',
    date: 'Sat, 26 Sep 2026 12:00:00 GMT',
    nonce: '11111111-2222-3333-4444-555555555555',
  } as const

  it('is exactly nine lines, with the last two empty when there are no x-* headers', () => {
    const text = stringToSign(base)
    const lines = text.split('\n')
    expect(lines).toHaveLength(9)
    expect(lines[0]).toBe('POST')
    expect(lines[1]).toBe('/login/account/byPwd')
    expect(lines[2]).toBe('')
    expect(lines[3]).toBe(contentMd5('{"a":1}'))
    expect(lines[4]).toBe('application/json')
    expect(lines[5]).toBe(base.date)
    expect(lines[6]).toBe(base.nonce)
    expect(lines[7]).toBe('')
    expect(lines[8]).toBe('')
  })

  it('leaves Content-MD5 empty for an empty body but keeps the line', () => {
    const lines = stringToSign({ ...base, body: '' }).split('\n')
    expect(lines).toHaveLength(9)
    expect(lines[3]).toBe('')
  })

  it('sorts and joins x-* headers into the last two lines', () => {
    const text = stringToSign({
      ...base,
      customHeaders: { 'X-Beta': '2', 'x-alpha': '1', Authorization: 'ignored' },
    })
    const lines = text.split('\n')
    expect(lines[7]).toBe('x-alpha;x-beta')
    // 最后一行本身可以含换行（每个 x-* 一行），所以整串是「9 行 + 额外一行」。
    expect(text.endsWith('x-alpha:1\nx-beta:2')).toBe(true)
  })

  it('keeps the canonicalized headers free of a trailing newline', () => {
    const text = stringToSign({
      ...base,
      customHeaders: { 'x-alpha': '1' },
    })
    expect(text.endsWith('x-alpha:1')).toBe(true)
    expect(text.endsWith('\n')).toBe(false)
  })
})

describe('escaping', () => {
  it('escapes RFC 3986 sub-delims that encodeURIComponent keeps', () => {
    expect(escapedPath("/a/b!c'd(e)f*g")).toBe('/a/b%21c%27d%28e%29f%2Ag')
  })

  it('keeps slashes as separators and drops one trailing slash', () => {
    expect(escapedPath('/login/phone/sendMsgCode/')).toBe('/login/phone/sendMsgCode')
    expect(escapedPath('login/account/getPuKey')).toBe('/login/account/getPuKey')
  })

  it('escapes query values in order', () => {
    expect(escapedQuery({ page_size: 1, q: 'a b' })).toBe('page_size=1&q=a%20b')
    expect(escapedQuery({})).toBe('')
  })
})

describe('buildAccountHeaders', () => {
  const options = {
    accessKeyId: 'ak-id',
    accessKeySecret: 'ak-secret',
    method: 'POST',
    path: '/login/account/getPuKey',
    body: '{"base":{}}',
    now: new Date('2026-09-26T12:00:00Z'),
    nonce: 'nonce-1',
  }

  it('produces Authorization, Date, Nonce, Content-Type and Content-MD5', () => {
    const headers = buildAccountHeaders(options)
    expect(headers.Authorization).toMatch(/^account ak-id:/)
    expect(headers.Date).toBe('Sat, 26 Sep 2026 12:00:00 GMT')
    expect(headers.Nonce).toBe('nonce-1')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['Content-MD5']).toBe(contentMd5('{"base":{}}'))
  })

  it('signs a stable digest for identical input', () => {
    const a = buildAccountHeaders(options)
    const b = buildAccountHeaders(options)
    expect(a.Authorization).toBe(b.Authorization)
    expect(a.Authorization).toBe(
      `account ak-id:${sign('ak-secret', {
        method: 'POST',
        path: '/login/account/getPuKey',
        body: '{"base":{}}',
        date: 'Sat, 26 Sep 2026 12:00:00 GMT',
        nonce: 'nonce-1',
      })}`,
    )
  })

  it('omits Content-MD5 when there is no body', () => {
    const headers = buildAccountHeaders({ ...options, body: '' })
    expect(headers['Content-MD5']).toBeUndefined()
  })

  it('formats the HTTP date in GMT', () => {
    expect(httpDate(new Date('2026-01-02T03:04:05Z'))).toBe('Fri, 02 Jan 2026 03:04:05 GMT')
  })
})
