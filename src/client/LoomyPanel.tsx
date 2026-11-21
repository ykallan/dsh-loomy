/**
 * 侧边栏图标 + 整页面板。
 *
 * 图标是内联 SVG：插件的图标列只有 16px，用 `currentColor` 才能跟着主题走。
 *
 * @module dsh-loomy/client/LoomyPanel
 */

import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { LoomyPluginCard, type LoomyPluginCardInjected } from './LoomyPluginCard.tsx'
import styles from './LoomyPluginCard.module.css'

/** 侧边栏图标（16×16：一个对话气泡 + 一个点，呼应「助手」）。 */
export function LoomyPanelIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.4 4.2c0-.9.7-1.6 1.6-1.6h8c.9 0 1.6.7 1.6 1.6v5.2c0 .9-.7 1.6-1.6 1.6H7.1L4 13.4v-2.4H4c-.9 0-1.6-.7-1.6-1.6V4.2Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="5.9" cy="7" r="1" fill="currentColor" />
      <circle cx="8" cy="7" r="1" fill="currentColor" />
      <circle cx="10.1" cy="7" r="1" fill="currentColor" />
    </svg>
  )
}

export interface LoomyPanelPageInjected extends LoomyPluginCardInjected {
  backToConversation?: (() => void) | undefined
}

/** 侧边栏里的整页版本：一个返回按钮 + 同一张卡片。 */
export function LoomyPanelPage({ t, backToConversation }: LoomyPanelPageInjected): ReactElement {
  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        {backToConversation === undefined ? null : (
          <Button variant="ghost" size="sm" onClick={() => backToConversation()}>
            ← {t('backToConversation')}
          </Button>
        )}
        <h2 className={styles.panelTitle}>{t('panelTitle')}</h2>
      </div>
      <LoomyPluginCard t={t} />
    </div>
  )
}
