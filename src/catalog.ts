/**
 * Loomy 模型目录。
 *
 * **目录只放上游给的东西。** 唯一来源是 `GET /models`（`docs/PROTOCOL.md` 第 5 节）：
 * 启动时、每小时、以及卡片上「刷新模型」各拉一次，取所有成功账号的并集。上游没返回的
 * 模型就是没有，未登录时目录为空 —— 不拿一份历史名单冒充「可用模型」。
 *
 * 为什么必须守住这条：上游对**不认识的模型 id 会静默回退**到 `deepseek-v4-flash-0731`
 * 并回 200。所以「目录里有什么」是唯一可信的可用模型集合，猜一个 id 只会让用户以为
 * 自己在用别的模型。
 *
 * @module dsh-loomy/catalog
 */

import { upstreamModelId } from './config.ts'

/** 上游声明的思考强度。 */
export interface LoomyModelThinking {
  /** 可选档位（`reasoning_efforts` 的原值）。 */
  levels: readonly string[]
  /** 上游默认档位。 */
  default?: string
}

/** 一个暴露给 DSH 的模型。 */
export interface LoomyModelInfo {
  /** 模型 id —— 与上游 wire id 相同（不做别名映射）。 */
  id: string
  /** 展示名（上游 `name`，里面有 `x0.8` 这样的点数倍率）。 */
  name: string
  contextWindow: number
  /** `contextWindow` 是上游真的给的，还是兜底值。卡片只在真值时印规格。 */
  contextWindowKnown?: boolean
  maxTokens: number
  supportsImages: boolean
  /** 是不是思考模型（`capabilities.reasoning`）。 */
  reasoning?: boolean
  /** 支持工具调用（`capabilities.function_calling`）。 */
  toolCall?: boolean
  /** 上游声明支持流式（`capabilities.streaming`）。 */
  streaming?: boolean
  /** 上游声明的思考档位。空/缺省 = 不显示推理档位选择器。 */
  thinking?: LoomyModelThinking
  /** 点数倍率（上游 `name` 里的 `x0.8`）。只展示，不参与路由。 */
  multiplier?: number
}

/** 可变目录，由 shim 的 `/v1/models` 与适配器共享。 */
export class LoomyCatalog {
  /** 空目录起步：没发现过就是没有模型。 */
  private models: readonly LoomyModelInfo[] = []

  current(): readonly LoomyModelInfo[] {
    return this.models
  }

  set(models: readonly LoomyModelInfo[]): void {
    this.models = [...models]
  }

  /** 按 id 找一条（大小写不敏感，接受 `imodel/` 前缀）。 */
  find(id: string): LoomyModelInfo | undefined {
    const wire = upstreamModelId(id).toLowerCase()
    if (wire === '') return undefined
    return this.models.find(model => model.id.toLowerCase() === wire)
  }
}

/** 把目录收窄到用户勾选的子集（空/缺省 = 全给）。 */
export function filterEnabledModels(
  models: readonly LoomyModelInfo[],
  enabled: readonly string[] | undefined,
): readonly LoomyModelInfo[] {
  if (enabled === undefined || enabled.length === 0) return models
  const allow = new Set(enabled.map(id => upstreamModelId(id).toLowerCase()).filter(id => id !== ''))
  const kept = models.filter(model => allow.has(model.id.toLowerCase()))
  // 勾选项全都对不上（比如目录刚刷新过）时不要变成空列表：那会让模型选择器直接消失。
  return kept.length === 0 ? models : kept
}

/**
 * 合并多路来源（多账号）的模型清单。
 *
 * 规则：
 *  - 按 id 去重（大小写不敏感）；
 *  - 参数更全的一条优先（有真窗口 > 兜底窗口，支持图片 > 不支持）；
 *  - 输出按 id 排序，保证刷新前后顺序稳定。
 */
export function mergeModelLists(sets: readonly (readonly LoomyModelInfo[])[]): readonly LoomyModelInfo[] {
  const merged = new Map<string, LoomyModelInfo>()
  for (const set of sets) {
    for (const model of set) {
      const id = model.id.trim()
      if (id === '') continue
      const key = id.toLowerCase()
      const current = merged.get(key)
      merged.set(key, current === undefined ? { ...model, id } : richerModel(current, model))
    }
  }
  return [...merged.values()].sort((a, b) => (a.id.toLowerCase() < b.id.toLowerCase() ? -1 : 1))
}

function richerModel(current: LoomyModelInfo, next: LoomyModelInfo): LoomyModelInfo {
  const keep = richerThan(next, current) ? next : current
  const drop = keep === next ? current : next
  const merged: LoomyModelInfo = {
    ...keep,
    contextWindow: keep.contextWindowKnown === true || drop.contextWindowKnown !== true
      ? keep.contextWindow
      : drop.contextWindow,
    maxTokens: keep.maxTokens > 0 ? keep.maxTokens : drop.maxTokens,
    supportsImages: keep.supportsImages || drop.supportsImages,
    ...drop.reasoning === true || keep.reasoning === true ? { reasoning: true } : {},
    ...drop.toolCall === true || keep.toolCall === true ? { toolCall: true } : {},
    ...drop.streaming === true || keep.streaming === true ? { streaming: true } : {},
    ...keep.thinking === undefined && drop.thinking === undefined ? {} : { thinking: keep.thinking ?? drop.thinking },
  }
  if (keep.contextWindowKnown !== true && drop.contextWindowKnown !== true) delete merged.contextWindowKnown
  return merged
}

function richerThan(a: LoomyModelInfo, b: LoomyModelInfo): boolean {
  const aKnown = a.contextWindowKnown === true
  const bKnown = b.contextWindowKnown === true
  if (aKnown !== bKnown) return aKnown
  if ((a.contextWindow > 0) !== (b.contextWindow > 0)) return a.contextWindow > 0
  if ((a.maxTokens > 0) !== (b.maxTokens > 0)) return a.maxTokens > 0
  return a.supportsImages && !b.supportsImages
}
