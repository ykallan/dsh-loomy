/**
 * 动态模型发现：`GET /models`。
 *
 * 上游按**账号**返回目录（额度、套餐可能不同），所以多账号要逐号拉一次再取并集 ——
 * 一个号失败不影响其它号。结果是「真实可用模型」的唯一来源。
 *
 * 响应形状（`docs/PROTOCOL.md` 第 5 节）：
 *
 * ```jsonc
 * { "object": "list",
 *   "data": [ { "id": "deepseek-v4-flash-0731", "object": "model",
 *               "name": "DeepSeek V4 Flash 0731 (x3.0)",
 *               "context_length": 1048576,
 *               "max_output_tokens": 32768,
 *               "capabilities": { "reasoning": true, "vision": false,
 *                                 "function_calling": true, "streaming": true },
 *               "reasoning_efforts": ["low", "high"] } ] }
 * ```
 *
 * 也见过套一层 `{code, data:[…]}` 的形态，所以解析器对两种都容忍；但**不猜**：
 * 一个条目没有 `id` 就当它不存在。
 *
 * @module dsh-loomy/discovery
 */

import { CATALOG_TIMEOUT_MS } from './config.ts'
import { mergeModelLists, type LoomyModelInfo, type LoomyModelThinking, type LoomyCatalog } from './catalog.ts'
import type { LoomyAccountStore } from './accounts.ts'
import { buildModelHeaders, modelsUrl } from './upstream.ts'

/** 一个 `data[]` 条目（字段名按上游原样，全部可选）。 */
export interface ModelEntry {
  id?: unknown
  name?: unknown
  context_length?: unknown
  max_output_tokens?: unknown
  max_tokens?: unknown
  capabilities?: unknown
  modality?: unknown
  input_modalities?: unknown
  reasoning_efforts?: unknown
  reasoning_effort?: unknown
}

/** 一次目录抓取的结果。 */
export interface CatalogFetch {
  models: readonly LoomyModelInfo[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') out.push(item.trim())
    else if (isObject(item)) {
      const level = item.level ?? item.name ?? item.id
      if (typeof level === 'string' && level.trim() !== '') out.push(level.trim())
    }
  }
  return out
}

/** `context_length` / `max_output_tokens` 可能是数字也可能是字符串。 */
function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

/** 从展示名里抠出点数倍率：`GLM 5.3 Flash (x0.8)` → `0.8`。 */
export function parseMultiplier(name: string): number | undefined {
  const match = /\(\s*x\s*([0-9]+(?:\.[0-9]+)?)\s*\)/i.exec(name)
  if (match === null) return undefined
  const value = Number.parseFloat(match[1] ?? '')
  return Number.isFinite(value) ? value : undefined
}

/** 档位：`["low","high"]`、`[{level:"low"}]`、`{level:[…],default:"high"}` 都接受。 */
export function parseReasoningEfforts(raw: unknown): LoomyModelThinking | undefined {
  if (raw === undefined || raw === null) return undefined
  if (Array.isArray(raw)) {
    const levels = stringList(raw)
    return levels.length === 0 ? undefined : { levels }
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '') return undefined
    try {
      return parseReasoningEfforts(JSON.parse(trimmed) as unknown)
    } catch {
      return undefined
    }
  }
  if (!isObject(raw)) return undefined
  const levels = stringList(raw.level)
  if (levels.length === 0) return undefined
  const fallback = typeof raw.default === 'string' && levels.includes(raw.default) ? raw.default : undefined
  return fallback === undefined ? { levels } : { levels, default: fallback }
}

/** 视觉能力：`capabilities.vision`，或 `modality`/`input_modalities` 里出现 image。 */
function supportsImages(entry: ModelEntry, capabilities: Record<string, unknown> | undefined): boolean {
  if (capabilities?.vision === true) return true
  for (const field of [entry.modality, entry.input_modalities]) {
    const items = Array.isArray(field) ? field : typeof field === 'string' ? [field] : []
    for (const item of items) {
      if (typeof item === 'string' && item.toLowerCase().includes('image')) return true
    }
  }
  return false
}

/** 一条 `data[]` → 目录项；没有 id 就是 undefined。 */
export function toModelInfo(raw: unknown): LoomyModelInfo | undefined {
  if (!isObject(raw)) return undefined
  const entry = raw as ModelEntry
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (id === '') return undefined
  const capabilities = isObject(entry.capabilities) ? entry.capabilities : undefined
  const contextWindow = parsePositiveInt(entry.context_length)
  const maxTokens = parsePositiveInt(entry.max_output_tokens ?? entry.max_tokens)
  const name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : id
  const multiplier = parseMultiplier(name)
  const thinking = parseReasoningEfforts(entry.reasoning_efforts ?? entry.reasoning_effort)
  return {
    id,
    name,
    contextWindow: contextWindow ?? 0,
    ...contextWindow === undefined ? {} : { contextWindowKnown: true },
    maxTokens: maxTokens ?? 0,
    supportsImages: supportsImages(entry, capabilities),
    ...capabilities?.reasoning === true ? { reasoning: true } : {},
    ...capabilities?.function_calling === true ? { toolCall: true } : {},
    ...capabilities?.streaming === true ? { streaming: true } : {},
    ...thinking === undefined ? {} : { thinking },
    ...multiplier === undefined ? {} : { multiplier },
  }
}

/** 找到载荷里的模型数组（`data[]` 或 `data.data[]` 或根数组）。 */
function modelArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (!isObject(raw)) return []
  if (Array.isArray(raw.data)) return raw.data
  if (isObject(raw.data) && Array.isArray(raw.data.data)) return raw.data.data
  if (Array.isArray(raw.models)) return raw.models
  return []
}

/** 解析整个 `/models` 响应。 */
export function parseModelsPayload(raw: unknown): CatalogFetch {
  const models: LoomyModelInfo[] = []
  for (const entry of modelArray(raw)) {
    const info = toModelInfo(entry)
    if (info !== undefined) models.push(info)
  }
  return { models: mergeModelLists([models]) }
}

/** 拉一个账号的模型目录。 */
export async function fetchModels(
  session: string,
  options: { signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<CatalogFetch> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? CATALOG_TIMEOUT_MS)
  timer.unref?.()
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    const response = await fetchImpl(modelsUrl(), {
      method: 'GET',
      headers: buildModelHeaders(session),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`GET /models returned HTTP ${response.status}`)
    const body = await response.json() as unknown
    const parsed = parseModelsPayload(body)
    if (parsed.models.length === 0) throw new Error('GET /models listed no usable model')
    return parsed
  } finally {
    clearTimeout(timer)
  }
}

/** 一次跨账号发现的完整结果。 */
export interface DiscoveryOutcome {
  models: readonly LoomyModelInfo[]
  /** 至少一个账号能给出目录。 */
  anySucceeded: boolean
  accounts: { id: string; models: number; errors: string[] }[]
}

/** 逐号发现并合并。 */
export async function discoverModels(
  store: LoomyAccountStore,
  signal?: AbortSignal,
): Promise<DiscoveryOutcome> {
  const ids = await store.dispatchIds()
  const perAccount: { id: string; models: number; errors: string[] }[] = []
  const sets: LoomyModelInfo[][] = []
  for (const id of ids) {
    try {
      const resolved = await store.resolve(id)
      if (resolved === undefined) {
        perAccount.push({ id, models: 0, errors: ['no usable session'] })
        continue
      }
      const fetched = await fetchModels(resolved.session, signal === undefined ? {} : { signal })
      sets.push([...fetched.models])
      perAccount.push({ id, models: fetched.models.length, errors: [] })
    } catch (error: unknown) {
      perAccount.push({ id, models: 0, errors: [error instanceof Error ? error.message : String(error)] })
    }
  }
  return {
    models: mergeModelLists(sets),
    anySucceeded: sets.some(set => set.length > 0),
    accounts: perAccount,
  }
}

/** 拉一次目录并写进 `catalog`；失败时保留旧目录（上游抖动不该清空模型选择器）。 */
export async function refreshCatalog(
  store: LoomyAccountStore,
  catalog: LoomyCatalog,
  signal?: AbortSignal,
): Promise<DiscoveryOutcome> {
  const outcome = await discoverModels(store, signal)
  if (outcome.anySucceeded && outcome.models.length > 0) catalog.set(outcome.models)
  return outcome
}

/**
 * 单号快速探活：能不能列出模型。
 *
 * 这是「这个号今天还能不能用」最轻的证明：`/models` 要鉴权、不消耗点数。
 */
export async function probeSession(
  session: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; models: number; message?: string }> {
  try {
    const fetched = await fetchModels(session, signal === undefined ? {} : { signal })
    return { ok: true, models: fetched.models.length }
  } catch (error: unknown) {
    return { ok: false, models: 0, message: error instanceof Error ? error.message : String(error) }
  }
}
