/**
 * 对话输入框下方那一行：`Loomy · 模型 · 今日 tokens · 花费点数`。
 *
 * 只在当前模型确实来自 `loomy` 时渲染 —— 别的 provider 的对话不该出现这一行。
 * 状态每 60 秒刷一次（够用，且不给 `/status` 添压力）。
 *
 * @module dsh-loomy/client/LoomyDock
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { LoomyWebStatus } from '../web-status.ts'
import { formatCount } from './format.ts'
import styles from './LoomyPluginCard.module.css'

/** 这个 provider 路由的名字（客户端不能 import 宿主模块，所以这里单独抄一份）。 */
const LOOMY_PROVIDER = 'loomy'

/** 状态刷新间隔。 */
const REFRESH_INTERVAL_MS = 60_000

export interface LoomyDockProps {
  /** 宿主提供的「当前模型/供应商」投影读取器（没有就退化成不显示）。 */
  useProjection?: (key: string) => unknown
  t: (key: string, params?: Record<string, string | number>) => string
  /** `bar` = 输入框下方的积分条区，`dock` = 输入框下沿 —— 目前两者渲染一致。 */
  zone?: 'bar' | 'dock'
  onOpenSettings?: () => boolean
}

interface ModelSelection {
  provider?: string
  model?: string
  name?: string
}

/** 读当前选中的 provider/model。 */
function readSelection(useProjection: LoomyDockProps['useProjection']): ModelSelection | undefined {
  if (useProjection === undefined) return undefined
  try {
    const value = useProjection('modelSelection')
    if (typeof value !== 'object' || value === null) return undefined
    const raw = value as { provider?: unknown; model?: unknown; name?: unknown }
    return {
      ...typeof raw.provider === 'string' ? { provider: raw.provider } : {},
      ...typeof raw.model === 'string' ? { model: raw.model } : {},
      ...typeof raw.name === 'string' ? { name: raw.name } : {},
    }
  } catch {
    return undefined
  }
}

export function LoomyDock({ useProjection, t, onOpenSettings }: LoomyDockProps): ReactElement | null {
  const [status, setStatus] = useState<LoomyWebStatus | undefined>(undefined)
  const selection = readSelection(useProjection)
  const isLoomy = selection?.provider === LOOMY_PROVIDER

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const response = await fetch('/api/loomy/status', { headers: { Accept: 'application/json' } })
        if (!response.ok) return
        const parsed = await response.json() as { status?: LoomyWebStatus }
        if (!cancelled && parsed.status !== undefined) setStatus(parsed.status)
      } catch {
        // 状态读不到就不显示，不影响对话。
      }
    }
    void load()
    const timer = setInterval(() => void load(), REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  // 只有当前模型来自 Loomy 时才占这个位置。
  if (status === undefined || !isLoomy) return null
  if (status.dock.dock !== true) return null

  const modelName = selection?.name ?? selection?.model ?? ''
  const today = status.usage.today
  const tokens = today.inputTokens + today.outputTokens
  const needsLogin = status.accounts.filter(account => account.needsLogin).length
  const clickable = typeof onOpenSettings === 'function'

  return (
    <span
      className={styles.dockLine}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onOpenSettings?.() : undefined}
      onKeyDown={clickable
        ? event => {
            if (event.key === 'Enter' || event.key === ' ') onOpenSettings?.()
          }
        : undefined}
      title={status.accounts.length === 0 ? t('dockNone') : undefined}
    >
      <span>{modelName === '' ? t('dockProvider') : `${t('dockProvider')} · ${modelName}`}</span>
      <span className={styles.dockSeparator}>|</span>
      <span>{t('dockUsage', { tokens: formatCount(tokens) })}</span>
      <span className={styles.dockSeparator}>|</span>
      <span>{t('dockPoints', { points: formatCount(today.points) })}</span>
      {needsLogin === 0 ? null : (
        <>
          <span className={styles.dockSeparator}>|</span>
          <span className={styles.warnText}>{t('dockNeedsLogin', { count: needsLogin })}</span>
        </>
      )}
    </span>
  )
}
