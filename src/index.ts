/**
 * Loomy（讯飞桌面助手）的模型接入 DeepSeek Harness。
 *
 * 插件注册一个 `loomy` provider，请求经本机回环 shim 转发到 Loomy 的模型网关。
 * 登录是**服务端**的：手机号 + 密码（RSA 加密）换一个 14 天会话，会话就是模型的
 * Bearer；快到期时插件自己用存着的密码再登一次（上游没有 refresh token）。
 *
 * 多账号：`.loomy-accounts.json` 存账号，池按点数余额/轮转/最久未用选号 —— 上游每个号
 * 的额度是分开的，多一个号就多一份可用点数。模型目录来自上游 `GET /models`，启动时与
 * 每小时各拉一次，失败保留上一次的结果。
 *
 * 点数：上游有 `/points/records`，所以这里显示的是**真余额**（不是本机估算），
 * 卡片和体检都据此判断「这个号还有没有额度」。
 *
 * @module dsh-loomy
 */

import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  LoomyAccountStore,
  loomyAccountsPath,
  loomyRefreshLogPath,
  loomyUsagePath,
} from './accounts.ts'
import { LoomyAccountPool, type PoolStrategy } from './account-pool.ts'
import { LoomyCatalog, invertSelection as invertModelSelection, normalizeSelection, type Selection, type SelectionMode } from './catalog.ts'
import { refreshCatalog } from './discovery.ts'
import { LoomyUsageTracker } from './usage.ts'
import { LoomyPointsTracker, fetchPoints, looksLikeQuotaExhausted, type PointsSnapshot } from './points.ts'
import { createLoomyShim, type ShimStats } from './shim.ts'
import { createLoomyAdapter, LOOMY_PROVIDER } from './adapter.ts'
import { installSettingsSectionCompat, resolveSettingsNamespaceCompat } from './settings-compat.ts'
import {
  registerLoomyStatusRoutes,
  type LoomyDockFlags,
  type PointsRefreshResult,
} from './web-status.ts'
import { LOOMY_VERSION } from './version.ts'

export { LOOMY_PROVIDER, createLoomyAdapter, type LoomyAdapter } from './adapter.ts'
export { createLoomyShim, type LoomyShim, type ShimStats } from './shim.ts'
export {
  LoomyCatalog,
  filterEnabledModels,
  invertSelection,
  isSelectionMode,
  mergeModelLists,
  normalizeSelection,
  resolveSelection,
  type LoomyModelInfo,
  type Selection,
  type SelectionMode,
} from './catalog.ts'
export {
  LoomyAccountStore,
  loomyAccountsPath,
  loomyUsagePath,
  summarizeAccount,
  type LoomyAccount,
  type LoomyAccountSummary,
} from './accounts.ts'
export { LoomyAccountPool, type AccountRuntime, type PoolStrategy } from './account-pool.ts'
export { LoomyUsageTracker, type UsageSnapshot } from './usage.ts'
export {
  LoomyPointsTracker,
  parsePoints,
  looksLikeQuotaExhausted,
  type AccountPoints,
  type PointsSnapshot,
} from './points.ts'
export { discoverModels, fetchModels, parseModelsPayload, refreshCatalog, type DiscoveryOutcome } from './discovery.ts'
export { LoomyQueueGate } from './queue.ts'
export { AccountService, LoginError, newIdentity, type LoomyIdentity } from './login.ts'
export { buildAccountHeaders, sign, stringToSign } from './signer.ts'
export { rsaEncrypt } from './rsa.ts'
export { LOOMY_VERSION } from './version.ts'

/** 稳定的 Cordis 插件名（与 `cordis.patch.yml` 的 id 对齐）。 */
export const name = 'llm-loomy'

/** provider 注册前必须先有 `llm` 服务。 */
export const inject = ['llm']

/** 拥有配置卡片的 settings 命名空间。 */
export const LOOMY_SETTINGS_NS = 'loomy' as SettingsNamespace

/** 插件配置。 */
export interface Config {
  /** 模型选择器里允许出现的模型 id（`custom` 模式时生效；空 = 全部）。 */
  enabledModels?: string[]
  /** 模型勾选模式：`all` 全部 / `none` 一个都不给 / `custom` 只给勾选的。 */
  modelSelectionMode?: SelectionMode
  /** 对话输入框下方的 `Provider Loomy · 模型 · 今日点数` 那一行。 */
  showDock?: boolean
  /** 侧边栏图标列里的 Loomy 入口。缺省关：图标列是全宿主共用资源。 */
  showSidebarPanel?: boolean
  /** 设置左侧导航里的 Loomy 入口。缺省开。 */
  showSettingsEntry?: boolean
  /** 同时打到上游的生成数。 */
  maxConcurrent?: number
  /** 本地排队上限，超出直接 429。 */
  maxQueue?: number
  /** 选号策略。 */
  strategy?: PoolStrategy
  /** 会话快到期时自动用存着的密码重登。 */
  autoRenew?: boolean
}

interface VolatileValue<T> {
  get: () => T
}

function unwrapVolatileValue<T>(value: unknown): T {
  if (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function') {
    return (value as VolatileValue<T>).get()
  }
  return value as T
}

function unwrapConfig(value: unknown): Config {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) out[key] = unwrapVolatileValue(field)
  return out as Config
}

export const Config: z<Config> = z.object({
  enabledModels: z.array(z.string())
    .description('Model ids offered in the model pickers (only used in custom mode)')
    .volatile(),
  modelSelectionMode: z.union(['all', 'none', 'custom'])
    // **故意不给 default**：老配置里只有 enabledModels，没有这个键。写死一个默认值会让
    // 「曾经勾好的子集」在升级后被当成 all 而无声丢弃。缺省时由 enabledModels 推断
    // （空 = all，非空 = custom），见 `normalizeSelection()`。
    .description('Model selection mode: all, none, or only the checked models (unset = infer from enabledModels)')
    .volatile(),
  showDock: z.boolean().default(true)
    .description('Show the Loomy line (provider, model, today points) under the chat input box')
    .volatile(),
  showSidebarPanel: z.boolean().default(false)
    .description('Show a Loomy icon in the DSH sidebar icon column')
    .volatile(),
  showSettingsEntry: z.boolean().default(true)
    .description('Show a Loomy entry in the left navigation of DSH Settings')
    .volatile(),
  maxConcurrent: z.natural().default(1)
    .description('Concurrent upstream generations')
    .volatile(),
  maxQueue: z.natural().default(3)
    .description('Local queue depth before requests are rejected with 429')
    .volatile(),
  strategy: z.union(['balance', 'round_robin', 'lru']).default('balance')
    .description('Account selection strategy: balance (most points first), round_robin, or lru')
    .volatile(),
  autoRenew: z.boolean().default(true)
    .description('Sign in again with the stored password before the 14-day session expires')
    .volatile(),
}) as unknown as z<Config>

/** 点数说明（卡片直接展示，别让用户以为这是本机估算）。 */
export const POINTS_NOTE = 'These are the account-level points the Loomy gateway reports: '
  + 'available = permanent balance + the daily grant. The daily grant resets on the upstream side, '
  + 'so no countdown is shown. "Today" below is only what THIS machine spent through this plugin.'

function settingsCompatNamespace(ctx: Context): SettingsNamespace {
  return resolveSettingsNamespaceCompat(ctx, ctx.get('settings'), LOOMY_SETTINGS_NS)
}

export function apply(ctx: Context, rawConfig: Config): void {
  const config = unwrapConfig(rawConfig)

  /**
   * 续期/登录失败日志。
   *
   * 宿主对插件的 info/debug 没有出口，warn 会变成系统通知 —— 一次网络抖动就弹一次窗口
   * 不行。所以失败原因写插件自己的文件，1MB 截断重来。
   */
  const appendRefreshLog = (message: string): void => {
    try {
      const path = loomyRefreshLogPath()
      try {
        if (statSync(path).size > 1_000_000) writeFileSync(path, '')
      } catch {
        // 文件还不存在：append 会创建它。
      }
      appendFileSync(path, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 })
    } catch {
      // 日志写不进去不能影响续期本身。
    }
  }

  const points = new LoomyPointsTracker()
  const store = new LoomyAccountStore(loomyAccountsPath(), {
    log: appendRefreshLog,
    // `per_account`（缺省）给每个号一个独立的 devid；`client` 则逐字照抄客户端的 `web`。
    // 这只影响账号服务信封里的设备字段，不改变网络出口（`docs/PROTOCOL.md` 第 2 节）。
    identityMode: process.env.LOOMY_IDENTITY_MODE === 'client' ? 'client' : 'per_account',
  })
  const pool = new LoomyAccountPool([], {
    maxConcurrent: config.maxConcurrent ?? 1,
    strategy: config.strategy ?? 'balance',
    available: id => points.available(id),
  })
  const catalog = new LoomyCatalog()
  const usage = new LoomyUsageTracker({ path: loomyUsagePath() })

  let current = (): Config => config
  const dock = (): LoomyDockFlags => ({
    dock: current().showDock !== false,
    sidebar: current().showSidebarPanel === true,
    settingsEntry: current().showSettingsEntry !== false,
  })

  const setDock = async (patch: Partial<LoomyDockFlags>): Promise<boolean> => {
    const settings = ctx.get('settings')
    if (settings === undefined) return false
    await settings.update(settingsCompatNamespace(ctx), {
      ...patch.dock === undefined ? {} : { showDock: patch.dock },
      ...patch.sidebar === undefined ? {} : { showSidebarPanel: patch.sidebar },
      ...patch.settingsEntry === undefined ? {} : { showSettingsEntry: patch.settingsEntry },
    })
    return true
  }

  const setEnabledModels = async (mode: SelectionMode, ids: readonly string[]): Promise<boolean> => {
    const settings = ctx.get('settings')
    if (settings === undefined) return false
    // 两个字段一起写：模式决定「空数组」到底是全给还是一个都不给。
    await settings.update(settingsCompatNamespace(ctx), {
      modelSelectionMode: mode,
      enabledModels: mode === 'custom' ? [...ids] : [],
    })
    return true
  }

  /** 当前的模型勾选（模式 + 勾选 id）。 */
  const selection = (): Selection => normalizeSelection(
    current().enabledModels,
    current().modelSelectionMode,
  )

  /**
   * 反选：把「现在暴露的」翻成「现在没暴露的」。
   *
   * 全选 → 一个都不给、一个都不给 → 全选、部分 → 补集。语义在 `catalog.ts` 里，
   * 这里只负责落盘。
   */
  const invertSelection = async (): Promise<boolean> => {
    const next = invertModelSelection(catalog.current(), selection())
    return setEnabledModels(next.mode, next.enabled)
  }

  /** 把池与账号文档对齐（新增/删除账号后调）。 */
  const syncPool = async (): Promise<void> => {
    const ids = await store.ids()
    pool.sync(ids)
    const summaries = await store.list()
    pool.setPaused(summaries.filter(entry => entry.paused).map(entry => entry.id))
    pool.setPreferred(summaries.filter(entry => entry.pinned).map(entry => entry.id))
    pool.setStrategy(current().strategy ?? 'balance')
    // 被删掉的账号不该继续占着点数缓存。
    points.prune(ids)
  }

  /**
   * 重新查一遍所有账号的点数。
   *
   * 这是**真查询**（`GET /points/records`），不像 DevEco 那边只能拿目录探活 —— 上游确实
   * 有账本。失败时保留上一次的数值，绝不清成 0。
   */
  const refreshPoints = async (): Promise<PointsRefreshResult> => {
    await syncPool()
    const ids = await store.dispatchIds()
    const accounts: PointsRefreshResult['accounts'] = []
    for (const id of ids) {
      try {
        const resolved = await store.resolve(id)
        if (resolved === undefined) {
          accounts.push({ id, ok: false, message: 'account needs sign-in' })
          continue
        }
        const snapshot: PointsSnapshot = await fetchPoints(resolved.session)
        points.noteOk(id, snapshot)
        accounts.push({
          id,
          ok: true,
          ...snapshot.available === undefined ? {} : { available: snapshot.available },
        })
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        if (looksLikeQuotaExhausted(0, message)) points.noteExhausted(id, message)
        else points.noteError(id, message)
        accounts.push({ id, ok: false, message })
      }
    }
    const probed = accounts.length
    const ok = accounts.some(entry => entry.ok)
    const known = accounts.filter(entry => entry.available !== undefined)
    const total = known.reduce((sum, entry) => sum + (entry.available ?? 0), 0)
    return {
      ok,
      probed,
      accounts,
      message: probed === 0
        ? 'no account to probe'
        : ok
          ? `probed ${String(probed)} account(s); ${String(known.length)} report points, ${total.toLocaleString('en-US')} available in total`
          : `points lookup failed: ${accounts.find(entry => !entry.ok)?.message ?? 'unknown'}`,
    }
  }

  /** 手动/自动刷新目录。 */
  const refreshModels = async (): Promise<{ models: number; refreshed: boolean }> => {
    await syncPool()
    const outcome = await refreshCatalog(store, catalog)
    return { models: catalog.current().length, refreshed: outcome.anySucceeded }
  }

  /** 账号变动之后统一收口：对齐池、复活、补目录与点数。 */
  const afterAccountChange = async (): Promise<void> => {
    await syncPool()
    void refreshCatalog(store, catalog).catch(() => {})
    void refreshPoints().catch(() => {})
  }

  /** provider 是否真的挂上了 —— 卡片体检要能看到这一条（注册失败时它会是 false）。 */
  let providerRegistered = false

  const shim = createLoomyShim({
    store,
    pool,
    catalog,
    usage,
    points,
    selection,
    logger: ctx.logger,
  })
  let stopped = false

  // ---- 路由 ----------------------------------------------------------------
  ctx.inject(['webServer'], webCtx => {
    registerLoomyStatusRoutes(webCtx, {
      store,
      models: () => catalog.current(),
      selection,
      setEnabledModels,
      invertSelection,
      pool: () => pool.list(),
      strategy: () => pool.currentStrategy(),
      reviveAccount: id => pool.revive(id),
      afterAccountChange,
      usage: () => usage.snapshot(),
      points: () => points.snapshot(),
      refreshPoints,
      dock,
      setDock,
      refreshModels,
      shimStats: (): ShimStats => shim.stats(),
      providerRegistered: () => providerRegistered,
      version: LOOMY_VERSION,
      pointsNote: POINTS_NOTE,
    })
  })

  // ---- 设置卡片 ------------------------------------------------------------
  installSettingsSectionCompat(ctx, LOOMY_SETTINGS_NS, Config, config, {
    setSource(source) {
      current = () => unwrapConfig(source())
      void syncPool().catch(() => {})
    },
    onChange() {
      void syncPool().catch(() => {})
    },
  })

  // ---- 目录发现 ------------------------------------------------------------
  const CATALOG_REFRESH_MS = 60 * 60 * 1000
  /** 目录空时的重试（指数退避，封顶 5 分钟）。 */
  const CATALOG_EMPTY_RETRY_MS = 60 * 1000
  const CATALOG_EMPTY_RETRY_MAX_MS = 5 * 60 * 1000
  let discoveryTimer: ReturnType<typeof setTimeout> | undefined
  let emptyStreak = 0
  const abort = new AbortController()

  const discoverLoop = async (): Promise<void> => {
    if (stopped) return
    try {
      await syncPool()
      const outcome = await refreshCatalog(store, catalog, abort.signal)
      if (outcome.anySucceeded) {
        ctx.logger.debug(`dsh-loomy: model catalog refreshed (${String(outcome.models.length)} models)`)
      } else if ((await store.ids()).length > 0) {
        ctx.logger.debug('dsh-loomy: model discovery found nothing usable; keeping the current catalog')
      }
    } catch (error: unknown) {
      ctx.logger.debug('dsh-loomy: model discovery failed; keeping the current catalog', error)
    }
    if (stopped) return
    let delay: number
    if (catalog.current().length === 0) {
      delay = Math.min(CATALOG_EMPTY_RETRY_MS * 2 ** emptyStreak, CATALOG_EMPTY_RETRY_MAX_MS)
      emptyStreak += 1
    } else {
      emptyStreak = 0
      delay = CATALOG_REFRESH_MS
    }
    discoveryTimer = setTimeout(() => void discoverLoop(), delay)
    discoveryTimer.unref?.()
  }

  // ---- 会话保活 ------------------------------------------------------------
  /**
   * 每 6 小时检查一次「会话快到期」的账号。
   *
   * 会话寿命 14 天、提前 3 天续；6 小时的粒度足够，而且不会让上游觉得我们在刷登录接口。
   * 没有密码的账号无法续期，这里只把它暴露出来（卡片会显示剩余天数）。
   */
  const KEEP_ALIVE_INTERVAL_MS = 6 * 60 * 60 * 1000
  let keepAliveTimer: ReturnType<typeof setTimeout> | undefined
  const keepAliveLoop = async (): Promise<void> => {
    if (stopped) return
    try {
      if (current().autoRenew !== false) {
        const outcome = await store.keepAlive()
        if (outcome.refreshed > 0) ctx.logger.debug(`dsh-loomy: renewed ${String(outcome.refreshed)} session(s)`)
        if (outcome.needsLogin.length > 0) {
          ctx.logger.debug(`dsh-loomy: ${String(outcome.needsLogin.length)} account(s) need a fresh sign-in`)
        }
      }
    } catch (error: unknown) {
      ctx.logger.debug('dsh-loomy: session keep-alive failed; will retry', error)
    }
    if (stopped) return
    keepAliveTimer = setTimeout(() => void keepAliveLoop(), KEEP_ALIVE_INTERVAL_MS)
    keepAliveTimer.unref?.()
  }

  // ---- 点数轮询 ------------------------------------------------------------
  /** 点数变化不快，30 分钟一次足够；首次延迟 20 秒，别和启动瞬间抢上游。 */
  const POINTS_FIRST_DELAY_MS = 20 * 1000
  const POINTS_REFRESH_MS = 30 * 60 * 1000
  let pointsTimer: ReturnType<typeof setTimeout> | undefined
  const pointsLoop = async (): Promise<void> => {
    if (stopped) return
    try {
      await refreshPoints()
    } catch (error: unknown) {
      ctx.logger.debug('dsh-loomy: points refresh failed; keeping the last numbers', error)
    }
    if (stopped) return
    pointsTimer = setTimeout(() => void pointsLoop(), POINTS_REFRESH_MS)
    pointsTimer.unref?.()
  }

  // ---- 启动 ----------------------------------------------------------------
  void usage.load().catch(() => {})

  ctx.effect(() => () => {
    stopped = true
    abort.abort()
    for (const timer of [discoveryTimer, keepAliveTimer, pointsTimer]) {
      if (timer !== undefined) clearTimeout(timer)
    }
    void usage.flush().catch(() => {})
    void shim.close().catch(() => {})
  })

  void shim.ready
    .then(async () => {
      if (stopped) return
      // 先把池和目录对齐，再让 provider 挂上：目录空起步，模型要等第一轮发现填进来。
      await syncPool()
      void discoverLoop()
      void keepAliveLoop()
      pointsTimer = setTimeout(() => void pointsLoop(), POINTS_FIRST_DELAY_MS)
      pointsTimer.unref?.()

      const loomy = createLoomyAdapter({
        shim,
        catalog,
        selection,
        resolveAttachments: () => ctx.get('attachments'),
      })

      let releaseAdapter: (() => void) | undefined
      let releaseDirectory: (() => void) | undefined
      try {
        releaseAdapter = ctx.llm.registerAdapter([LOOMY_PROVIDER], loomy.adapter)
        releaseDirectory = ctx.llm.registerConfigurableProviders([{
          provider: LOOMY_PROVIDER,
          displayName: 'Loomy',
          settingsNs: settingsCompatNamespace(ctx),
          settingsPath: [],
          declared: false,
        }])
      } finally {
        if (releaseAdapter === undefined || releaseDirectory === undefined) {
          releaseAdapter?.()
          releaseDirectory?.()
        }
      }
      try {
        ctx.effect(() => () => {
          releaseAdapter?.()
          releaseDirectory?.()
        })
      } catch {
        releaseAdapter?.()
        releaseDirectory?.()
      }

      providerRegistered = true
      ctx.logger.debug(`dsh-loomy: provider "${LOOMY_PROVIDER}" registered (shim on ${shim.baseUrl()})`)
    })
    .catch((error: unknown) => {
      ctx.logger.error('dsh-loomy: loopback shim failed to start; provider not registered', error)
    })
}
