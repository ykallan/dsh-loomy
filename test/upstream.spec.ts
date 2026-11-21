import { describe, expect, it } from 'vitest'
import {
  buildModelHeaders,
  chatUrl,
  classifyUpstreamError,
  conversationKey,
  firstFrameError,
  modelsUrl,
  newTraceparent,
  pointsUrl,
  usageFromJson,
  usageFromSseLine,
} from '../src/upstream.ts'

/**
 * 模型网关这一层：请求头（`traceparent` 是硬要求）、错误归类、用量抽取。
 */

describe('buildModelHeaders', () => {
  it('sends the session both ways plus a traceparent and a version', () => {
    const headers = buildModelHeaders('session-1')
    expect(headers.Authorization).toBe('Bearer session-1')
    expect(headers.token).toBe('session-1')
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(headers['loomy-version']).toBe('0.9.38')
    expect(headers['X-Loomy-Request-Purpose']).toBe('chat.message')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('mints a fresh traceparent every time', () => {
    expect(newTraceparent()).not.toBe(newTraceparent())
  })

  it('lets the caller override the purpose and version', () => {
    const headers = buildModelHeaders('s', { purpose: 'chat.title', version: '9.9.9' })
    expect(headers['X-Loomy-Request-Purpose']).toBe('chat.title')
    expect(headers['loomy-version']).toBe('9.9.9')
  })
})

describe('urls', () => {
  it('point at the OpenAI-compatible root', () => {
    expect(chatUrl()).toMatch(/\/api\/v1\/chat\/completions$/)
    expect(modelsUrl()).toMatch(/\/api\/v1\/models$/)
    expect(pointsUrl()).toContain('/points/records?record_type=all&page_no=1&page_size=1')
  })
})

describe('classifyUpstreamError', () => {
  it('treats 401/403 as a dead session that needs a sign-in', () => {
    for (const status of [401, 403]) {
      const error = classifyUpstreamError(status, 'invalid session')
      expect(error.kind).toBe('auth')
      expect(error.needsLogin).toBe(true)
      expect(error.retryable).toBe(true)
    }
  })

  it('treats 402 / points wording as quota exhaustion', () => {
    expect(classifyUpstreamError(402, '').kind).toBe('quota')
    expect(classifyUpstreamError(400, 'insufficient points').kind).toBe('quota')
  })

  it('treats 429 and rate-limit wording as throttling', () => {
    expect(classifyUpstreamError(429, '').kind).toBe('rate-limit')
    expect(classifyUpstreamError(400, 'rate limit exceeded').kind).toBe('rate-limit')
  })

  it('treats a length complaint as a context overflow that must not be retried', () => {
    const error = classifyUpstreamError(400, 'This model\'s maximum context length is 1048576 tokens')
    expect(error.kind).toBe('context')
    expect(error.retryable).toBe(false)
  })

  it('treats an unknown-model complaint as a model error', () => {
    expect(classifyUpstreamError(400, 'unsupported model').kind).toBe('model')
  })

  it('retries 5xx and 408', () => {
    expect(classifyUpstreamError(503, 'busy').retryable).toBe(true)
    expect(classifyUpstreamError(408, 'timeout').retryable).toBe(true)
  })
})

describe('usage extraction', () => {
  it('reads tokens, reasoning tokens and points from a JSON body', () => {
    expect(usageFromJson({
      usage: {
        prompt_tokens: 3,
        completion_tokens: 5,
        completion_tokens_details: { reasoning_tokens: 2 },
        points_consumed: 1,
      },
    })).toEqual({ inputTokens: 3, outputTokens: 5, reasoningTokens: 2, pointsConsumed: 1 })
  })

  it('returns nothing for a body without usage', () => {
    expect(usageFromJson({})).toEqual({})
    expect(usageFromJson(null)).toEqual({})
  })

  it('folds usage out of an SSE line, ignoring [DONE] and junk', () => {
    expect(usageFromSseLine('data: {"usage":{"prompt_tokens":1}}')).toEqual({ inputTokens: 1 })
    expect(usageFromSseLine('data: [DONE]')).toBeUndefined()
    expect(usageFromSseLine('data: {"choices":[]}')).toBeUndefined()
    expect(usageFromSseLine('data: not json')).toBeUndefined()
    expect(usageFromSseLine('event: ping')).toBeUndefined()
  })

  it('surfaces an error that arrives as the first SSE frame', () => {
    expect(firstFrameError('data: {"error":{"message":"no points"}}\n\n')).toBe('no points')
    expect(firstFrameError('data: {"choices":[{"delta":{"content":"hi"}}]}')).toBeUndefined()
  })
})

describe('conversationKey', () => {
  it('is stable for the same first user message', () => {
    const a = conversationKey({ messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'hello' }] })
    const b = conversationKey({ messages: [{ role: 'system', content: 'y' }, { role: 'user', content: 'hello' }] })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
  })

  it('changes when the first user message changes', () => {
    const a = conversationKey({ messages: [{ role: 'user', content: 'one' }] })
    const b = conversationKey({ messages: [{ role: 'user', content: 'two' }] })
    expect(a).not.toBe(b)
  })
})
