/**
 * 打开「设置 → DevEco」这一页，不依赖宿主的私有 API。
 *
 * 两条路：
 * 1. 新壳：设置面板在 `sidebar.settings` 槽上留了一个 store，`actions.openSection(id)` 直接开；
 * 2. 老壳：先 `shortcuts.invoke('settings.open')`，再在设置弹层里点同名导航行。
 *
 * 两条都失败时返回 false，由调用方决定退路（卡片自己就在设置里，通常不必退）。
 *
 * @module dsh-loomy/client/settings-route
 */

/** 设置壳所在的槽位键。 */
const SETTINGS_SLOT = 'sidebar.settings'

/** 老壳里重试点击的节奏（毫秒）。 */
const RETRY_DELAYS_MS = [0, 60, 70, 80, 90]

export interface SettingsRouteDeps {
  slots?: { entries?: (key: string) => readonly unknown[] }
  shortcuts?: { invoke?: (id: string, context?: unknown) => void }
  /** 目标分节的 id（= 插件的 `settings.section` 注册 id）。 */
  sectionId: string
  /** 目标分节的显示文案（老壳按文本匹配导航行）。 */
  label?: () => string
  doc?: Document
  schedule?: (run: () => void, ms: number) => void
}

interface SectionStore {
  create?: () => { actions?: { openSection?: (id: string) => void } } | undefined
}

function openViaStore(deps: SettingsRouteDeps): boolean {
  try {
    const entries = deps.slots?.entries?.(SETTINGS_SLOT) ?? []
    for (const entry of entries) {
      const store = (entry as { store?: SectionStore }).store
      const controller = store?.create?.()
      const open = controller?.actions?.openSection
      if (typeof open === 'function') {
        open(deps.sectionId)
        return true
      }
    }
  } catch {
    // 新壳不可用：走老路。
  }
  return false
}

function openViaShortcut(deps: SettingsRouteDeps): boolean {
  const invoke = deps.shortcuts?.invoke
  if (typeof invoke !== 'function') return false
  const doc = deps.doc ?? (typeof document === 'undefined' ? undefined : document)
  if (doc === undefined) return false
  const schedule = deps.schedule ?? ((run: () => void, ms: number) => {
    const timer = setTimeout(run, ms)
    timer.unref?.()
  })
  const wanted = (deps.label?.() ?? deps.sectionId).trim()
  invoke('settings.open', { modal: null })
  for (const delay of RETRY_DELAYS_MS) {
    schedule(() => {
      const scope = doc.querySelector('[data-shortcut-modal="settings"]') ?? doc
      const rows = [...scope.querySelectorAll('[role="tab"], button, [role="menuitem"]')]
      const row = rows.find(element => (element.textContent ?? '').trim() === wanted)
      if (row instanceof HTMLElement) row.click()
    }, delay)
  }
  return true
}

/** 尽力打开设置里的 DevEco 分节；两条路都不通时返回 false。 */
export function openPluginSettings(deps: SettingsRouteDeps): boolean {
  return openViaStore(deps) || openViaShortcut(deps)
}
