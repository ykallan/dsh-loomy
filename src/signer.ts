/**
 * 讯飞账号服务的请求签名（HMAC-SHA1）。
 *
 * 与客户端 `electron/xfyun/sign.js` 的算法逐字对应（`docs/PROTOCOL.md` 第 3 节）：
 *
 * ```
 * stringToSign = "\n".join([
 *   METHOD, ESCAPED_PATH, ESCAPED_QUERY, Content-MD5,
 *   Content-Type, Date, Nonce, SignedHeaders, CanonicalizedHeaders,
 * ])
 * signature     = base64(hmac_sha1(accessKeySecret, stringToSign))
 * Authorization = "account <accessKeyId>:<signature>"
 * ```
 *
 * **九行，不是七行**：没有自定义 `x-*` 头时最后两行是空串，但必须存在 —— 少一行就是
 * `HMAC signature does not match`，而这个错误完全看不出是行数问题。
 *
 * @module dsh-loomy/signer
 */

import { createHash, createHmac, randomUUID } from 'node:crypto'

/** RFC 3986 保留字符：`encodeURIComponent` 留着它们，服务端却要转义。 */
const EXTRA_ESCAPES: Record<string, string> = {
  '!': '%21',
  "'": '%27',
  '(': '%28',
  ')': '%29',
  '*': '%2A',
}

/** `encodeURIComponent` 的 safe 集是 `-_.!~*'()`，这里收窄到 `-_.~` 再补转义。 */
function escape(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => EXTRA_ESCAPES[character] ?? character)
}

/** `base64(md5(body))`；空 body 是空串（不是空 md5）。 */
export function contentMd5(body: string): string {
  if (body === '') return ''
  return createHash('md5').update(body, 'utf8').digest('base64')
}

/** 逐段转义路径（`/a/b` → `/a/b`，段内的保留字符才转义）。 */
export function escapedPath(path: string): string {
  let value = path.startsWith('/') ? path : `/${path}`
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1)
  return value.split('/').map(segment => (segment === '' ? '' : escape(segment))).join('/')
}

/** 转义查询串（按传入顺序，与签名一致）。 */
export function escapedQuery(params: Record<string, string | number | undefined> = {}): string {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return ''
  return entries
    .map(([key, value]) => `${escape(key)}=${escape(value === undefined ? '' : String(value))}`)
    .join('&')
}

/** 自定义头里的 `x-*`：排序后的名字与规范化的 `k:v\n` 行。 */
function canonicalized(customHeaders: Record<string, string> = {}): { signed: string; canonical: string } {
  const picked: Record<string, string> = {}
  for (const [key, value] of Object.entries(customHeaders)) {
    const lower = key.toLowerCase()
    if (lower.startsWith('x-')) picked[lower] = String(value).trim()
  }
  const keys = Object.keys(picked).sort()
  if (keys.length === 0) return { signed: '', canonical: '' }
  return {
    signed: keys.join(';'),
    canonical: keys.map(key => `${key}:${picked[key]}\n`).join('').replace(/\n$/, ''),
  }
}

export interface SignInput {
  method: string
  /** 未转义的路径，例如 `/login/account/byPwd`。 */
  path: string
  query?: Record<string, string | number | undefined>
  body?: string
  contentType?: string
  /** HTTP 日期串，形如 `Sat, 26 Sep 2026 12:00:00 GMT`。 */
  date: string
  nonce: string
  customHeaders?: Record<string, string>
}

/** 待签名的九行文本。导出给测试逐行比对。 */
export function stringToSign(input: SignInput): string {
  const { signed, canonical } = canonicalized(input.customHeaders)
  return [
    input.method.toUpperCase(),
    escapedPath(input.path),
    escapedQuery(input.query),
    contentMd5(input.body ?? ''),
    input.contentType ?? 'application/json',
    input.date,
    input.nonce,
    signed,
    canonical,
  ].join('\n')
}

/** HMAC-SHA1 签名（base64）。 */
export function sign(secret: string, input: SignInput): string {
  return createHmac('sha1', secret).update(stringToSign(input), 'utf8').digest('base64')
}

/** HTTP 日期（GMT，`Sat, 26 Sep 2026 12:00:00 GMT` 形态）。 */
export function httpDate(at: Date = new Date()): string {
  return at.toUTCString()
}

export interface SignedHeadersOptions {
  accessKeyId: string
  accessKeySecret: string
  method: string
  path: string
  query?: Record<string, string | number | undefined>
  body?: string
  contentType?: string
  customHeaders?: Record<string, string>
  /** 可注入的时钟/随机数，便于测试。 */
  now?: Date
  nonce?: string
}

/**
 * 一次账号服务请求的完整头集合。
 *
 * `Content-MD5` 只在有 body 时出现 —— 但签名里的那一行**永远**存在（空串）。
 */
export function buildAccountHeaders(options: SignedHeadersOptions): Record<string, string> {
  const body = options.body ?? ''
  const contentType = options.contentType ?? 'application/json'
  const date = httpDate(options.now)
  const nonce = options.nonce ?? randomUUID()
  const signature = sign(options.accessKeySecret, {
    method: options.method,
    path: options.path,
    ...options.query === undefined ? {} : { query: options.query },
    body,
    contentType,
    date,
    nonce,
    ...options.customHeaders === undefined ? {} : { customHeaders: options.customHeaders },
  })
  const headers: Record<string, string> = {
    Authorization: `account ${options.accessKeyId}:${signature}`,
    Date: date,
    Nonce: nonce,
    'Content-Type': contentType,
  }
  const md5 = contentMd5(body)
  if (md5 !== '') headers['Content-MD5'] = md5
  for (const [key, value] of Object.entries(options.customHeaders ?? {})) headers[key] = String(value)
  return headers
}

export { randomUUID }
