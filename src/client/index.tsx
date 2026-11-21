/**
 * Loomy 插件的浏览器侧入口。
 *
 * 注册五处界面，全部复用同一张卡片：
 *
 * | 槽位 | 什么时候出现 |
 * |---|---|
 * | `plugins.bundle.config` | 永远（设置 → 插件 → 本 bundle） |
 * | `settings.section` | 缺省开（设置左侧导航多一个入口） |
 * | `sidebar.panellist` | 缺省关（图标列是全宿主共用资源） |
 * | `main` | 跟着 `sidebar.panellist` 的打开状态 |
 * | `conversation.input.left` | 当前模型来自 Loomy 时（底部状态行） |
 *
 * `inject` 里只写 `slots` 和 `locale`：依赖缺失会让整个 `apply` 不跑，所以 `layout`
 * 和 `shortcuts` 都是可选（`ctx.get`）。
 *
 * @module dsh-loomy/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { LoomyDock } from './LoomyDock.tsx'
import { LoomyPanelIcon, LoomyPanelPage } from './LoomyPanel.tsx'
import { LoomyPluginCard, type LoomyPluginCardInjected } from './LoomyPluginCard.tsx'
import { en, zh, type LoomySettingsKey } from './locales.ts'
import {
  settingsEntryWanted,
  setSettingsEntryWanted,
  setSidebarPanelWanted,
  sidebarPanelWanted,
  subscribeSettingsEntryWanted,
  subscribeSidebarPanelWanted,
} from './panel-switch.ts'
import { openPluginSettings } from './settings-route.ts'

/** 卡片文案的命名空间。 */
const NAMESPACE = 'settings.loomy'

/** 侧边栏图标与 `main` 面板共用的 key。 */
const PANEL_ID = 'dsh-loomy'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    // 声明的是**键的联合**（`LocaleDictOf` 用它构造 `Record<union, string>`），
    // 所以这里传 `keyof`，不能直接传接口本身。
    'settings.loomy': keyof LoomySettingsKey
  }

  interface SlotMap {
    /** bundle 详情页里的配置卡片（rc.2 起），key = 包名。 */
    'plugins.bundle.config': { kind: 'keyed'; scope: 'root'; owner: { children?: never } }
    'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: { size: number; active: boolean } }
    main: { kind: 'keyed'; scope: 'root'; owner: { children?: never } }
    'settings.section': { kind: 'list'; scope: 'root' }
  }
}

export const name = 'dsh-loomy-client'

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  try {
    ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'dsh-loomy: settings copy')
    const t = ctx.locale.bind(NAMESPACE) as LoomyPluginCardInjected['t']

    // ---- 设置 → 插件 → 本 bundle 的卡片 ----------------------------------
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: 'dsh-loomy',
      locale: NAMESPACE,
    }, () => <LoomyPluginCard t={t} />))

    // ---- 对话底部状态行 ---------------------------------------------------
    const layout = ctx.get('layout') as { selectPanel?: (id: string | null) => void } | undefined
    const shortcuts = ctx.get('shortcuts') as { invoke?: (id: string, context?: unknown) => void } | undefined

    const openSettings = (): boolean => openPluginSettings({
      slots: ctx.get('slots') as { entries?: (key: string) => readonly unknown[] } | undefined,
      shortcuts,
      sectionId: PANEL_ID,
      label: () => t('tabLabel'),
    })

    try {
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'loomy-dock',
        order: 30,
        locale: NAMESPACE,
        inject: () => ({ t, zone: 'bar' as const, onOpenSettings: openSettings }),
      }, LoomyDock))
    } catch (error: unknown) {
      // 老宿主没有这个槽：底部状态行缺席，但插件其它部分照常工作。
      console.warn('[dsh-loomy] conversation dock slot unavailable:', error)
    }

    // ---- 侧边栏图标 + 整页 ------------------------------------------------
    const panelClaims: (() => void)[] = []
    const syncPanel = (): void => {
      for (const claim of panelClaims.splice(0)) {
        try {
          claim()
        } catch {
          // 已经注销过就忽略。
        }
      }
      if (!sidebarPanelWanted()) return
      panelClaims.push(ctx.slots.inject('sidebar.panellist', () => {
        try {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 50,
            label: () => t('tabLabel'),
            locale: NAMESPACE,
          }, LoomyPanelIcon)
        } catch (error: unknown) {
          console.warn('[dsh-loomy] sidebar icon registration failed:', error)
          return () => {}
        }
      }))
      panelClaims.push(ctx.slots.inject('main', () => {
        try {
          return ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NAMESPACE,
            inject: () => ({ t, backToConversation: () => layout?.selectPanel?.(null) }),
          }, LoomyPanelPage)
        } catch (error: unknown) {
          console.warn('[dsh-loomy] sidebar page registration failed:', error)
          return () => {}
        }
      }))
    }

    // ---- 设置左侧导航入口 -------------------------------------------------
    const settingsClaims: (() => void)[] = []
    const syncSettingsEntry = (): void => {
      for (const claim of settingsClaims.splice(0)) {
        try {
          claim()
        } catch {
          // 同上。
        }
      }
      if (!settingsEntryWanted()) return
      settingsClaims.push(ctx.slots.inject('settings.section', () => {
        try {
          return ctx.slots.register({
            name: 'settings.section',
            id: PANEL_ID,
            order: 50,
            label: () => t('tabLabel'),
            locale: NAMESPACE,
            inject: () => ({ t }),
          }, LoomyPluginCard)
        } catch (error: unknown) {
          console.warn('[dsh-loomy] settings section registration failed:', error)
          return () => {}
        }
      }))
    }

    syncPanel()
    syncSettingsEntry()
    ctx.effect(() => {
      const offPanel = subscribeSidebarPanelWanted(syncPanel)
      const offSettings = subscribeSettingsEntryWanted(syncSettingsEntry)
      return () => {
        offPanel()
        offSettings()
        for (const claim of panelClaims.splice(0)) claim()
        for (const claim of settingsClaims.splice(0)) claim()
      }
    }, 'dsh-loomy: navigation entries')

    // ---- 初始显隐状态：以服务端为准 ---------------------------------------
    void (async () => {
      try {
        const response = await fetch('/api/loomy/dock', { headers: { Accept: 'application/json' } })
        if (!response.ok) return
        const data = await response.json() as { dock?: { sidebar?: boolean; settingsEntry?: boolean } }
        setSidebarPanelWanted(data.dock?.sidebar === true)
        setSettingsEntryWanted(data.dock?.settingsEntry !== false)
      } catch {
        // 读不到就按缺省：侧边栏关、设置入口开。
      }
    })()
  } catch (error: unknown) {
    // 界面挂了不能连累宿主侧的 provider。
    console.error('[dsh-loomy] client card failed to load (host provider unaffected):', error)
  }
}
