import { describe, expect, it } from 'vitest'
import {
  fetchModels,
  parseModelsPayload,
  parseMultiplier,
  parseReasoningEfforts,
  toModelInfo,
} from '../src/discovery.ts'
import { filterEnabledModels, mergeModelLists, type LoomyModelInfo } from '../src/catalog.ts'
import { resolveRequestedModel } from '../src/shim.ts'
import { LoomyCatalog } from '../src/catalog.ts'

/**
 * 模型目录解析。
 *
 * 上游对**不认识的模型 id 会静默回退**到默认模型，所以「目录里有什么」是唯一可信的可用
 * 集合；解析器对空条目、缺字段、两种包裹形态都必须给出确定的答案。
 */

const openAiShape = {
  object: 'list',
  data: [
    {
      id: 'deepseek-v4-flash-0731',
      object: 'model',
      name: 'DeepSeek V4 Flash 0731 (x3.0)',
      context_length: 1_048_576,
      max_output_tokens: 32_768,
      capabilities: { reasoning: true, vision: false, function_calling: true, streaming: true },
      reasoning_efforts: ['low', 'high'],
    },
    {
      id: 'GLM-5.3-Flash',
      object: 'model',
      name: 'GLM 5.3 Flash (x0.8)',
      context_length: 1_048_576,
      capabilities: { reasoning: false, vision: true, function_calling: true },
    },
  ],
}

describe('parseModelsPayload', () => {
  it('reads the OpenAI-style list', () => {
    const { models } = parseModelsPayload(openAiShape)
    expect(models.map(model => model.id)).toEqual(['deepseek-v4-flash-0731', 'GLM-5.3-Flash'])
    const flash = models.find(model => model.id === 'deepseek-v4-flash-0731')
    expect(flash?.contextWindow).toBe(1_048_576)
    expect(flash?.contextWindowKnown).toBe(true)
    expect(flash?.maxTokens).toBe(32_768)
    expect(flash?.reasoning).toBe(true)
    expect(flash?.toolCall).toBe(true)
    expect(flash?.streaming).toBe(true)
    expect(flash?.thinking?.levels).toEqual(['low', 'high'])
    expect(flash?.multiplier).toBe(3)
  })

  it('also accepts a code-wrapped payload', () => {
    const { models } = parseModelsPayload({ code: '000000', data: openAiShape.data })
    expect(models).toHaveLength(2)
  })

  it('drops entries without an id instead of inventing one', () => {
    const { models } = parseModelsPayload({ data: [{ name: 'no id here' }, openAiShape.data[0]] })
    expect(models.map(model => model.id)).toEqual(['deepseek-v4-flash-0731'])
  })

  it('returns an empty catalog for junk', () => {
    expect(parseModelsPayload(null).models).toEqual([])
    expect(parseModelsPayload({ data: 'nope' }).models).toEqual([])
  })

  it('detects vision from capabilities or modality strings', () => {
    expect(toModelInfo({ id: 'a', capabilities: { vision: true } })?.supportsImages).toBe(true)
    expect(toModelInfo({ id: 'b', modality: ['text', 'image'] })?.supportsImages).toBe(true)
    expect(toModelInfo({ id: 'c', capabilities: { vision: false } })?.supportsImages).toBe(false)
  })

  it('accepts max_tokens as an alias for max_output_tokens', () => {
    expect(toModelInfo({ id: 'a', max_tokens: '4096' })?.maxTokens).toBe(4096)
  })
})

describe('parseMultiplier', () => {
  it('reads the x-factor out of the display name', () => {
    expect(parseMultiplier('Spark X2.5 (x0.1)')).toBe(0.1)
    expect(parseMultiplier('Qwen 3.8 Max (x12.0)')).toBe(12)
    expect(parseMultiplier('no multiplier')).toBeUndefined()
  })
})

describe('parseReasoningEfforts', () => {
  it('accepts an array of strings, an array of objects, a JSON string and an object', () => {
    expect(parseReasoningEfforts(['low', 'high'])?.levels).toEqual(['low', 'high'])
    expect(parseReasoningEfforts([{ level: 'low' }, 'high'])?.levels).toEqual(['low', 'high'])
    expect(parseReasoningEfforts('["minimal"]')?.levels).toEqual(['minimal'])
    expect(parseReasoningEfforts({ level: ['low', 'max'], default: 'max' })).toEqual({
      levels: ['low', 'max'],
      default: 'max',
    })
  })

  it('drops a default that is not one of the levels', () => {
    expect(parseReasoningEfforts({ level: ['low'], default: 'high' })?.default).toBeUndefined()
  })

  it('returns undefined for anything unusable', () => {
    expect(parseReasoningEfforts(undefined)).toBeUndefined()
    expect(parseReasoningEfforts('not json')).toBeUndefined()
    expect(parseReasoningEfforts({})).toBeUndefined()
  })
})

describe('catalog helpers', () => {
  const glm: LoomyModelInfo = { id: 'GLM-5.3-Flash', name: 'GLM', contextWindow: 100, maxTokens: 10, supportsImages: true }
  const spark: LoomyModelInfo = { id: 'spark-x', name: 'Spark', contextWindow: 1000, maxTokens: 100, supportsImages: false }

  it('dedupes by id case-insensitively and keeps the richer entry', () => {
    const merged = mergeModelLists([
      [{ ...glm, contextWindow: 0, maxTokens: 0 }],
      [glm, spark],
    ])
    expect(merged.map(model => model.id)).toEqual(['GLM-5.3-Flash', 'spark-x'])
    expect(merged[0]?.contextWindow).toBe(100)
  })

  it('narrows to the checked subset', () => {
    expect(filterEnabledModels([glm, spark], ['spark-x']).map(model => model.id)).toEqual(['spark-x'])
  })

  it('falls back to the whole catalog when nothing matches', () => {
    expect(filterEnabledModels([glm, spark], ['gone'])).toHaveLength(2)
    expect(filterEnabledModels([glm, spark], [])).toHaveLength(2)
  })

  it('finds a model by case-insensitive id and strips the imodel/ prefix', () => {
    const catalog = new LoomyCatalog()
    catalog.set([glm])
    expect(catalog.find('glm-5.3-flash')?.id).toBe('GLM-5.3-Flash')
    expect(catalog.find('imodel/GLM-5.3-Flash')?.id).toBe('GLM-5.3-Flash')
  })
})

describe('fetchModels', () => {
  it('sends the required headers and parses the body', async () => {
    let seen: Record<string, string> | undefined
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = (init?.headers ?? {}) as Record<string, string>
      return new Response(JSON.stringify(openAiShape), { status: 200 })
    }) as unknown as typeof fetch
    const fetched = await fetchModels('session-1', { fetchImpl })
    expect(fetched.models).toHaveLength(2)
    expect(seen?.Authorization).toBe('Bearer session-1')
    expect(seen?.token).toBe('session-1')
    expect(seen?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(seen?.['loomy-version']).toBe('0.9.38')
  })

  it('throws a readable error on a rejected session', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    await expect(fetchModels('bad', { fetchImpl })).rejects.toThrow(/HTTP 401/)
  })

  it('refuses an empty catalog rather than pretending it has models', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch
    await expect(fetchModels('s', { fetchImpl })).rejects.toThrow(/no usable model/)
  })
})

describe('resolveRequestedModel', () => {
  it('passes a known model through', () => {
    const catalog = new LoomyCatalog()
    catalog.set([{ id: 'spark-x', name: 'Spark', contextWindow: 1, maxTokens: 1, supportsImages: false }])
    const resolved = resolveRequestedModel(catalog, 'spark-x')
    expect(resolved.wire).toBe('spark-x')
    expect(resolved.unknown).toBeUndefined()
  })

  it('refuses an unknown model when the catalog is known (no silent fallback)', () => {
    const catalog = new LoomyCatalog()
    catalog.set([{ id: 'spark-x', name: 'Spark', contextWindow: 1, maxTokens: 1, supportsImages: false }])
    const resolved = resolveRequestedModel(catalog, 'gpt-4o-mini')
    expect(resolved.unknown).toContain('unknown model')
  })

  it('passes anything through while the catalog is still empty', () => {
    const catalog = new LoomyCatalog()
    expect(resolveRequestedModel(catalog, 'whatever').unknown).toBeUndefined()
  })
})
