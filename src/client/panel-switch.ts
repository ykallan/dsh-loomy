/**
 * 侧边栏 / 设置导航入口的开关（纯内存，不落盘）。
 *
 * 为什么不用「渲染时返回 null」：宿主画导航行用的是**注册元数据**，返回 null 只会留下
 * 一个点得动但什么都不显示的空行。所以这里用「注销 → 重新注册」的方式真正增删入口。
 *
 * @module dsh-loomy/client/panel-switch
 */

export interface WantedSwitch {
  get(): boolean
  set(next: boolean): void
  subscribe(listener: () => void): () => void
}

export function createWantedSwitch(initial: boolean): WantedSwitch {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: next => {
      if (next === value) return
      value = next
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // 订阅者自己负责兜底。
        }
      }
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** 侧边栏图标列入口：缺省关（图标列是全宿主共用资源）。 */
export const sidebarEntrySwitch = createWantedSwitch(false)
/** 设置左侧导航入口：缺省开。 */
export const settingsEntrySwitch = createWantedSwitch(true)

export const sidebarPanelWanted = sidebarEntrySwitch.get
export const setSidebarPanelWanted = sidebarEntrySwitch.set
export const subscribeSidebarPanelWanted = sidebarEntrySwitch.subscribe
export const settingsEntryWanted = settingsEntrySwitch.get
export const setSettingsEntryWanted = settingsEntrySwitch.set
export const subscribeSettingsEntryWanted = settingsEntrySwitch.subscribe
