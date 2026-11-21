/**
 * 模型网关这一层的「怎么说话」：请求头、地址、错误归类、用量抽取。
 *
 * 上游是 OpenAI 兼容的，所以请求体基本可以原样转发 —— 真正的坑全在头上
 * （`docs/PROTOCOL.md` 第 2 节）：
 *
 * - `Authorization: Bearer <session>` **和** `token: <session>` 都发（客户端两种都认）；
 * - `traceparent` 必须在：**没有它上游会挂到超时**，而且报错是「超时」不是「缺头」；
 * - `loomy-version` 只检查存在；
 * - 流式与非流式是**同一个路径**，靠 body 里的 `stream` 区分（与 DevEco 相反）。
 *
 * @module dsh-loomy/upstream
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  DEFAULT_MODEL,
  LOOMY_CLIENT_VERSION,
  MODEL_PATHS,
  REQUEST_PURPOSE,
  modelBase,
} from './config.ts'

/** 一次请求要带的会话头。 */
export function buildModelHeaders(
  session: string,
  extra: { purpose?: string; version?: string } = {},
): Record<string, string> {
  return {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session}`,
    // 客户端的 provider 用 useSessionAuth，两种写法上游都认，两个都发最省事。
    token: session,
    // 缺了它上游会一直挂着直到超时（客户端作者实测）。
    traceparent: newTraceparent(),
    'loomy-version': extra.version ?? LOOMY_CLIENT_VERSION,
    'X-Loomy-Request-Purpose': extra.purpose ?? REQUEST_PURPOSE,
  }
}

/** W3C traceparent：`00-<32 hex>-<16 hex>-01`。 */
export function newTraceparent(): string {
  return `00-${randomUUID().replace(/-/g, '')}-${randomUUID().replace(/-/g, '').slice(0, 16)}-01`
}

/** 聊天地址（流式/非流式同一个路径）。 */
export function chatUrl(): string {
  return `${modelBase()}${MODEL_PATHS.chat}`
}

/** 模型目录地址。 */
export function modelsUrl(): string {
  return `${modelBase()}${MODEL_PATHS.models}`
}

/** 点数记录地址（`data.{balance, dailyBalance, availableBalance}`）。 */
export function pointsUrl(pageSize = 1): string {
  return `${modelBase()}${MODEL_PATHS.points}?record_type=all&page_no=1&page_size=${String(pageSize)}`
}

/** 上游错误的归类。 */
export type UpstreamErrorKind =
  | 'auth'
  | 'quota'
  | 'rate-limit'
  | 'context'
  | 'model'
  | 'server'
  | 'network'

/** 把一次失败的响应翻译成可操作的错误。 */
export interface UpstreamError {
  kind: UpstreamErrorKind
  status: number
  message: string
  /** 换一个账号重试是否有意义。 */
  retryable: boolean
  /** 需要重新登录（有密码的账号会自动重登）。 */
  needsLogin: boolean
}

/** 从响应体里抠出可读的错误文本。 */
export async function readErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text()
    if (text === '') return `HTTP ${response.status}`
    try {
      const parsed = JSON.parse(text) as unknown
      if (isObject(parsed)) {
        const error = parsed.error
        if (typeof error === 'string') return error
        if (isObject(error) && typeof error.message === 'string') return error.message
        if (typeof parsed.message === 'string') return parsed.message
        if (typeof parsed.msg === 'string') return parsed.msg
        if (typeof parsed.desc === 'string' && parsed.desc !== '') return parsed.desc
      }
    } catch {
      // 不是 JSON：直接用原文。
    }
    return text.length > 600 ? `${text.slice(0, 600)}…` : text
  } catch {
    return `HTTP ${response.status}`
  }
}

/**
 * 归类一次上游失败。
 *
 * 上游的语义（`docs/PROTOCOL.md` 第 7 节 + 实测）：
 *
 * | 信号 | 含义 | 处理 |
 * |---|---|---|
 * | `401` / `403` | 会话失效 | 有密码就自动重登，没密码标待登录 |
 * | `402` / 点数不足 | 额度用完 | 冷却该号，换号重试 |
 * | `429` | 限流 | 冷却该号，换号重试 |
 * | `5xx` / `408` | 上游抖动 | 换号重试 |
 * | 400 + 长度关键词 | 上下文溢出 | 直接报清楚，不重试 |
 */
export function classifyUpstreamError(status: number, message: string): UpstreamError {
  const text = message.toLowerCase()
  if (status === 401 || status === 403) {
    return { kind: 'auth', status, message, retryable: true, needsLogin: true }
  }
  if (status === 402 || text.includes('insufficient') || text.includes('points') || text.includes('余额')) {
    return { kind: 'quota', status, message, retryable: true, needsLogin: false }
  }
  if (status === 429 || text.includes('rate limit') || text.includes('too many')) {
    return { kind: 'rate-limit', status, message, retryable: true, needsLogin: false }
  }
  if (status === 413 || (status === 400 && looksLikeLengthError(text))) {
    return { kind: 'context', status, message, retryable: false, needsLogin: false }
  }
  if (status === 400 && (text.includes('model') || text.includes('param') || text.includes('unsupported'))) {
    return { kind: 'model', status, message, retryable: false, needsLogin: false }
  }
  if (status >= 500 || status === 408) {
    return { kind: 'server', status, message, retryable: true, needsLogin: false }
  }
  return { kind: 'server', status, message, retryable: false, needsLogin: false }
}

function looksLikeLengthError(text: string): boolean {
  return text.includes('too long')
    || text.includes('prompt length')
    || text.includes('maximum input length')
    || text.includes('context length')
    || text.includes('context_length_exceeded')
    || text.includes('too many tokens')
    || text.includes('overlimit')
}

/** 本轮请求的用量。 */
export interface ChatUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  /** 上游按点数计费：这次扣了多少点。 */
  pointsConsumed?: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed)
  }
  return undefined
}

/** 从一次响应体里取用量。 */
export function usageFromJson(body: unknown): ChatUsage {
  if (!isObject(body)) return {}
  const usage = body.usage
  if (!isObject(usage)) return {}
  const input = numberOrUndefined(usage.prompt_tokens ?? usage.input_tokens)
  const output = numberOrUndefined(usage.completion_tokens ?? usage.output_tokens)
  const details = isObject(usage.completion_tokens_details) ? usage.completion_tokens_details : undefined
  const reasoning = numberOrUndefined(details?.reasoning_tokens ?? usage.reasoning_tokens)
  const points = numberOrUndefined(usage.points_consumed)
  return {
    ...input === undefined ? {} : { inputTokens: input },
    ...output === undefined ? {} : { outputTokens: output },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
    ...points === undefined ? {} : { pointsConsumed: points },
  }
}

/**
 * 从一行 SSE `data:` 里取用量。
 *
 * 流式响应通常在最后一个块带 `usage`（`points_consumed` 也在里面），也可能压根不带 ——
 * 拿不到就不记，绝不猜。
 */
export function usageFromSseLine(line: string): ChatUsage | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return undefined
  const payload = trimmed.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return undefined
  if (!payload.includes('usage')) return undefined
  try {
    const parsed = JSON.parse(payload) as unknown
    const usage = usageFromJson(parsed)
    return Object.keys(usage).length === 0 ? undefined : usage
  } catch {
    return undefined
  }
}

/**
 * 流式响应里第一帧的错误。
 *
 * 上游有时以 **200 + SSE** 的形式报错：第一帧是 `data: {"error":{...}}`。原样透传给
 * pi-ai，它会把这段当正文渲染出来，用户看到一堆 JSON 而不是错误提示。
 */
export function firstFrameError(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as unknown
      if (!isObject(parsed)) continue
      const error = parsed.error
      if (isObject(error) && typeof error.message === 'string') return error.message
      if (typeof error === 'string' && error !== '') return error
    } catch {
      // 不是 JSON 的帧不是错误帧。
    }
  }
  return undefined
}

/** 上游没给模型时的兜底（`deepseek-v4-flash-0731` 是上游自己的默认模型）。 */
export const FALLBACK_MODEL = DEFAULT_MODEL

/**
 * 会话键：用**首条 user 消息**做种子，而不是 `messages[0]` —— 后者通常是 system prompt，
 * 里面的日期/路径每次都变，用它做键等于每轮都是「新会话」。
 *
 * 上游的点数账本会按 ChatId 归类，稳定一点更容易排查。
 */
export function conversationKey(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const firstUser = messages.find(message => isObject(message) && message.role === 'user')
  const seed = firstUser ?? messages[0] ?? ''
  return createHash32(JSON.stringify(seed))
}

/** 32 位十六进制哈希。 */
function createHash32(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}
