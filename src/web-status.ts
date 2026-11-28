/**
 * 插件卡片用的同源 HTTP 路由。
 *
 * 浏览器侧只通过这里读状态、加/删账号、切换模型勾选、刷新点数、切显示开关。
 * 三个硬约束（与 DevEco 插件一致，理由相同）：
 *
 * 1. **只服务 loopback**：`Host` 与 `Origin` 都必须是回环（防 DNS rebinding）。本机任何
 *    一个网页都能访问 127.0.0.1，所以绑定地址本身不是信任边界。
 * 2. **任何凭证都不出浏览器**：状态文档里只有打码手机号、到期时间、点数、勾选状态。
 *    会话和密码留在宿主进程里。
 * 3. **写操作要 `content-type: application/json`**：挡住表单式的跨站提交。
 *
 * @module dsh-loomy/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { LoomyAccountStore, LoomyAccountSummary } from './accounts.ts'
import type { AccountRuntime, PoolStrategy } from './account-pool.ts'
import type { LoomyModelInfo } from './catalog.ts'
import type { AccountPoints } from './points.ts'
import type { AccountCheckin, CheckinSummary } from './checkin.ts'
import type { UsageSnapshot } from './usage.ts'
import type { ShimStats } from './shim.ts'
import { LOOMY_PROVIDER } from './adapter.ts'
import {
  isSelectionMode,
  normalizeSelection,
  resolveSelection,
  type Selection,
  type SelectionMode,
} from './catalog.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'

/** 把签到类型一并暴露给浏览器侧（只走类型，客户端不会拿到宿主运行时）。 */
export type { AccountCheckin, CheckinOutcome, CheckinSummary } from './checkin.ts'

// ---------------------------------------------------------------------------
// 路由常量
// ---------------------------------------------------------------------------

export const LOOMY_STATUS_PATH = '/api/loomy/status'
export const LOOMY_MODELS_PATH = '/api/loomy/models'
export const LOOMY_SELECTION_PATH = '/api/loomy/enabled-models'
/** 反选：POST 一次，把当前的勾选翻成补集（全选 ⇄ 一个都不给）。 */
export const LOOMY_SELECTION_INVERT_PATH = '/api/loomy/selection/invert'
export const LOOMY_ACCOUNTS_PATH = '/api/loomy/accounts'
export const LOOMY_LOGIN_PATH = '/api/loomy/login'
export const LOOMY_SMS_PATH = '/api/loomy/sms'
export const LOOMY_SESSION_PATH = '/api/loomy/session'
export const LOOMY_POINTS_PATH = '/api/loomy/points'
/** 手动签到：POST 一次，给每个可用账号发一遍上游 `first-login`。 */
export const LOOMY_CHECKIN_PATH = '/api/loomy/checkin'
export const LOOMY_REFRESH_MODELS_PATH = '/api/loomy/refresh-models'
export const LOOMY_DOCK_PATH = '/api/loomy/dock'
export const LOOMY_DOCTOR_PATH = '/api/loomy/doctor'

// ---------------------------------------------------------------------------
// 契约类型（客户端只认这一份）
// ---------------------------------------------------------------------------

/** 对话底部的显示开关。 */
export interface LoomyDockFlags {
  /** 对话输入框下方那一行（Provider / 模型 / 今日点数）。 */
  dock: boolean
  /** 侧边栏图标列里的入口。 */
  sidebar: boolean
  /** 设置左侧导航里的入口。 */
  settingsEntry: boolean
}

/** 缺省值：dock 与 settingsEntry 开着，侧边栏关着。 */
export const DEFAULT_DOCK_FLAGS: LoomyDockFlags = {
  dock: true,
  sidebar: false,
  settingsEntry: true,
}

/** 卡片上的一个账号（不含凭证）。 */
export interface LoomyWebAccount extends LoomyAccountSummary {
  /** 池里的运行时状态（槽位/冷却），账号不在池里时缺省。 */
  slot?: Pick<AccountRuntime, 'activeConcurrent' | 'maxConcurrent' | 'coolUntil' | 'disabled' | 'lastError'>
  /** 这个号最近查到的点数。 */
  points?: AccountPoints
  /** 这个号最近一次签到的结果（宿主启动时自动跑，也可手动触发）。 */
  checkin?: AccountCheckin
}

/** 卡片上的一个模型。 */
export interface LoomyWebModel {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  supportsImages?: boolean
  reasoning?: boolean
  toolCall?: boolean
  /** 上游声明的思考档位。 */
  levels?: readonly string[]
  /** 点数倍率（`x0.8`）。 */
  multiplier?: number
}

/** 完整状态文档。 */
export interface LoomyWebStatus {
  version: string
  provider: string
  node: string
  /** 选号策略（`balance` / `round_robin` / `lru`）。 */
  strategy: PoolStrategy
  /** 有没有任何账号。 */
  signedIn: boolean
  accounts: LoomyWebAccount[]
  models: LoomyWebModel[]
  usage: UsageSnapshot
  /** 点数记账口径说明（卡片直接展示）。 */
  pointsNote: string
  dock: LoomyDockFlags
  /** 显示开关是否可写（没有 settings 服务时只读）。 */
  writable: boolean
  shim: ShimStats
  /** provider 是否已经挂到宿主 LLM 层（注册失败时为 false，体检会指出）。 */
  providerRegistered: boolean
}

/** 模型勾选面板的数据。 */
export interface LoomyModelSelection {
  choices: (LoomyWebModel & { enabled: boolean })[]
  /** 当前模式：`all` / `none` / `custom`。 */
  mode: SelectionMode
  /** 已选子集是否小于全集。 */
  restricted: boolean
  writable: boolean
}

/** 刷点数的一次结果。 */
export interface PointsRefreshResult {
  ok: boolean
  probed: number
  accounts: { id: string; ok: boolean; available?: number; message?: string }[]
  message: string
}

/** 路由依赖。全部由 `index.ts` 注入，路由本身不持有任何状态。 */
export interface LoomyRouteOptions {
  store: LoomyAccountStore
  models: () => readonly LoomyModelInfo[]
  /** 当前勾选（模式 + id）。 */
  selection: () => Selection
  setEnabledModels: (mode: SelectionMode, ids: readonly string[]) => Promise<boolean>
  /** 反选（全选 ⇄ 一个都不给，部分 → 补集）。 */
  invertSelection: () => Promise<boolean>
  pool: () => AccountRuntime[]
  strategy: () => PoolStrategy
  reviveAccount: (id: string) => void
  /** 账号变动之后：对齐池、复活、重拉目录/点数。 */
  afterAccountChange: (id?: string) => Promise<void>
  usage: () => UsageSnapshot
  points: () => Record<string, AccountPoints>
  refreshPoints: () => Promise<PointsRefreshResult>
  /** 各账号最近一次签到的结果。 */
  checkins: () => Record<string, AccountCheckin>
  /** 手动触发一轮签到（同一个账号按天幂等）。 */
  checkinNow: () => Promise<CheckinSummary>
  dock: () => LoomyDockFlags
  setDock: (patch: Partial<LoomyDockFlags>) => Promise<boolean>
  refreshModels: () => Promise<{ models: number; refreshed: boolean }>
  shimStats: () => ShimStats
  providerRegistered: () => boolean
  version: string
  pointsNote: string
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** 只信任来回路环的请求。 */
function loopbackRequest(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
}

/** 写操作必须是 JSON。 */
function isJsonRequest(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.toLowerCase().includes('application/json')
}

function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req)
  if (raw.trim() === '') return {}
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 500 ? `${message.slice(0, 500)}…` : message
}

function toWebModel(model: LoomyModelInfo): LoomyWebModel {
  return {
    id: model.id,
    name: model.name,
    ...model.contextWindowKnown === true && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
    ...model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {},
    ...model.supportsImages ? { supportsImages: true } : {},
    ...model.reasoning ? { reasoning: true } : {},
    ...model.toolCall ? { toolCall: true } : {},
    ...model.thinking === undefined ? {} : { levels: model.thinking.levels },
    ...model.multiplier === undefined ? {} : { multiplier: model.multiplier },
  }
}

/** 组装状态文档（不含任何凭证）。 */
export async function buildStatus(deps: LoomyRouteOptions): Promise<LoomyWebStatus> {
  const summaries = await deps.store.list()
  const slots = new Map(deps.pool().map(entry => [entry.id, entry]))
  const points = deps.points()
  const checkins = deps.checkins()
  const accounts: LoomyWebAccount[] = summaries.map(summary => {
    const slot = slots.get(summary.id)
    const pointState = points[summary.id]
    const checkin = checkins[summary.id]
    return {
      ...summary,
      ...slot === undefined ? {} : {
        slot: {
          activeConcurrent: slot.activeConcurrent,
          maxConcurrent: slot.maxConcurrent,
          coolUntil: slot.coolUntil,
          disabled: slot.disabled,
          ...slot.lastError === undefined ? {} : { lastError: slot.lastError },
        },
      },
      ...pointState === undefined ? {} : { points: pointState },
      ...checkin === undefined ? {} : { checkin },
    }
  })
  return {
    version: deps.version,
    provider: LOOMY_PROVIDER,
    node: process.version,
    strategy: deps.strategy(),
    signedIn: accounts.length > 0,
    accounts,
    models: deps.models().map(toWebModel),
    usage: deps.usage(),
    pointsNote: deps.pointsNote,
    dock: deps.dock(),
    writable: true,
    shim: deps.shimStats(),
    providerRegistered: deps.providerRegistered(),
  }
}

/** 勾选面板的数据。 */
export function selectionOf(deps: LoomyRouteOptions): LoomyModelSelection {
  const models = deps.models()
  const selection = deps.selection()
  const exposed = new Set(resolveSelection(models, selection).map(model => model.id.toLowerCase()))
  const choices = models.map(model => ({
    ...toWebModel(model),
    enabled: exposed.has(model.id.toLowerCase()),
  }))
  return {
    choices,
    mode: selection.mode,
    restricted: choices.some(choice => !choice.enabled),
    writable: true,
  }
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function statusHandler(deps: LoomyRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    json(res, 200, { status: await buildStatus(deps) })
  }
}

function modelsHandler(deps: LoomyRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    json(res, 200, { models: deps.models().map(toWebModel) })
  }
}

function selectionHandler(deps: LoomyRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method === 'GET') {
      json(res, 200, { selection: selectionOf(deps) })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isJsonRequest(req)) {
      json(res, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const body = await readJson(req)
      if (!Array.isArray(body.enabledModels) || body.enabledModels.some(id => typeof id !== 'string')) {
        json(res, 400, { error: 'enabledModels must be an array of model ids' })
        return
      }
      // 模式缺省时按旧约定推断（空数组 = 全给），这样老客户端仍然能用。
      const requested = body.mode
      if (requested !== undefined && !isSelectionMode(requested)) {
        json(res, 400, { error: "mode must be one of 'all', 'none', 'custom'" })
        return
      }
      const selection = normalizeSelection(body.enabledModels as string[], requested)
      const ok = await deps.setEnabledModels(selection.mode, selection.enabled)
      if (!ok) {
        json(res, 403, { error: 'selection-not-writable' })
        return
      }
      json(res, 200, { ok: true, selection: selectionOf(deps) })
    } catch (error: unknown) {
      json(res, 400, { error: safeMessage(error) })
    }
  }
}

/**
 * 反选：全选 ⇄ 一个都不给，部分选 → 补集。
 *
 * 放在宿主侧算，是为了让「全选 / 反选」这一对操作的语义只有一份实现（`catalog.ts`）；
 * 浏览器只按返回的新选择重绘。
 */
function invertSelectionHandler(deps: LoomyRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isJsonRequest(req)) {
      json(res, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const ok = await deps.invertSelection()
      if (!ok) {
        json(res, 403, { error: 'selection-not-writable' })
        return
      }
      json(res, 200, { ok: true, selection: selectionOf(deps) })
    } catch (error: unknown) {
      json(res, 400, { error: safeMessage(error) })
    }
  }
}

/** 新增账号：手机号 + 密码（服务端登录）。 */
function loginHandler(deps: LoomyRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isJsonRequest(req)) {
      json(res, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const body = await readJson(req)
      const loginid = typeof body.loginid === 'string' ? body.loginid.trim() : ''
      const password = typeof body.password === 'string' ? body.password : ''
      const label = typeof body.label === 'string' ? body.label : undefined
      if (loginid === '' || password === '') {
        json(res, 400, { error: 'loginid and password are required' })
        return
      }
      const created = await deps.store.signInWithPassword({
        loginid,
        password,
        ...label === undefined ? {} : { label },
      })
      await deps.afterAccountChange(created.id)
      deps.reviveAccount(created.id)
      json(res, 200, { ok: true, id: created.id, status: await buildStatus(deps) })
    } catch (error: unknown) {
      json(res, 400, { error: safeMessage(error) })
    }
  }
}

/** 短信验证码：`POST {loginid}` 发码 / `POST {loginid, code, msgid}` 换会话。 */
function smsHandler(deps: LoomyRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isJsonRequest(req)) {
      json(res, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const body = await readJson(req)
      const loginid = typeof body.loginid === 'string' ? body.loginid.trim() : ''
      if (loginid === '') {
        json(res, 400, { error: 'loginid is required' })
        return
      }
      const code = typeof body.code === 'string' ? body.code.trim() : ''
      const msgid = typeof body.msgid === 'string' ? body.msgid.trim() : ''
      if (code === '' || msgid === '') {
        const nextMsgid = await deps.store.accountService.sendSmsCode(loginid)
        json(res, 200, { ok: true, msgid: nextMsgid })
        return
      }
      const created = await deps.store.signInWithSms({
        loginid,
        code,
        msgid,
        ...typeof body.label === 'string' ? { label: body.label } : {},
      })
      await deps.afterAccountChange(created.id)
      deps.reviveAccount(created.id)
      json(res, 200, { ok: true, id: created.id, status: await buildStatus(deps) })
    } catch (error: unknown) {
      json(res, 400, { error: safeMessage(error) })
    }
  }
}

/** 粘贴一个已有会话（没有密码，只用于「先让它跑起来」）。 */
function sessionHandler(deps: LoomyRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isJsonRequest(req)) {
      json(res, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const body = await readJson(req)
      const session = typeof body.session === 'string' ? body.session.trim() : ''
      if (session === '') {
        json(res, 400, { error: 'session is required' })
        return
      }
      // 先证明它真的能用：列一次模型（要鉴权，但不花点数）。
      const probe = await deps.store.accountService.baseInfo(session).then(
        () => undefined,
        (error: unknown) => safeMessage(error),
      )
      if (probe !== undefined) {
        json(res, 400, { error: `the session was rejected by the account service: ${probe}` })
        return
      }
      const id = await deps.store.addSession({
        session,
        ...typeof body.label === 'string' && body.label.trim() !== '' ? { label: body.label.trim() } : {},
        ...typeof body.loginid === 'string' && body.loginid.trim() !== '' ? { loginid: body.loginid.trim() } : {},
      })
      await deps.afterAccountChange(id)
      deps.reviveAccount(id)
      json(res, 200, { ok: true, id, status: await buildStatus(deps) })
    } catch (error: unknown) {
      json(res, 400, { error: safeMessage(error) })
    }
  }
}

/** 账号操作：暂停/置顶/改备注/补密码/重新登录。 */
function accountsHandler(deps: LoomyRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method === 'DELETE') {
      const id = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('id')
      if (id === null || id === '') {
        json(res, 400, { error: 'missing id' })
        return
      }
      await deps.store.remove(id)
      await deps.afterAccountChange()
      json(res, 200, { ok: true, status: await buildStatus(deps) })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isJsonRequest(req)) {
      json(res, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const body = await readJson(req)
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '') {
        json(res, 400, { error: 'missing id' })
        return
      }
      let touched = false
      if (typeof body.paused === 'boolean') touched = await deps.store.setPaused(id, body.paused) || touched
      if (typeof body.pinned === 'boolean') touched = await deps.store.setPinned(id, body.pinned) || touched
      if (typeof body.label === 'string') touched = await deps.store.setLabel(id, body.label) || touched
      if (typeof body.password === 'string') touched = await deps.store.setPassword(id, body.password) || touched
      if (body.relogin === true) touched = await deps.store.forceRelogin(id) || touched
      if (!touched) {
        json(res, 404, { error: 'unknown account or nothing to change' })
        return
      }
      await deps.afterAccountChange(id)
      deps.reviveAccount(id)
      json(res, 200, { ok: true, status: await buildStatus(deps) })
    } catch (error: unknown) {
      json(res, 400, { error: safeMessage(error) })
    }
  }
}

/** 点数：GET 读缓存；POST 重新查一遍（会打上游，但很轻）。 */
function pointsHandler(deps: LoomyRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method === 'GET') {
      json(res, 200, { points: deps.points() })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isJsonRequest(req)) {
      json(res, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const outcome = await deps.refreshPoints()
      json(res, 200, { outcome, status: await buildStatus(deps) })
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/**
 * 手动签到：给每个可用账号发一遍上游 `first-login`。
 *
 * 为什么要有这条路由：启动那一轮可能碰上网络抖动，用户不该为了重试去重启 DSH；
 * 上游按天幂等，所以这里可以放心重复调用（应答 `alreadyProcessed: true`）。
 */
function checkinHandler(deps: LoomyRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isJsonRequest(req)) {
      json(res, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const outcome = await deps.checkinNow()
      json(res, 200, { outcome, status: await buildStatus(deps) })
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

function refreshModelsHandler(deps: LoomyRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    try {
      const outcome = await deps.refreshModels()
      json(res, 200, { ...outcome, selection: selectionOf(deps), status: await buildStatus(deps) })
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

function dockHandler(deps: LoomyRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method === 'GET') {
      json(res, 200, { dock: deps.dock(), writable: true })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isJsonRequest(req)) {
      json(res, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const body = await readJson(req)
      const patch: Partial<LoomyDockFlags> = {}
      for (const key of ['dock', 'sidebar', 'settingsEntry'] as const) {
        if (typeof body[key] === 'boolean') patch[key] = body[key]
      }
      const ok = await deps.setDock(patch)
      if (!ok) {
        json(res, 403, { error: 'dock-not-writable' })
        return
      }
      json(res, 200, { ok: true, dock: deps.dock(), writable: true })
    } catch (error: unknown) {
      json(res, 400, { error: safeMessage(error) })
    }
  }
}

function doctorHandler(deps: LoomyRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    const status = await buildStatus(deps)
    const shim = deps.shimStats()
    const usable = status.accounts.filter(account => account.usable && !account.paused)
    const withBalance = status.accounts.filter(account => (account.points?.snapshot?.available ?? 0) > 0)
    const checks: { id: string; ok: boolean; detail: string }[] = [
      { id: 'version', ok: true, detail: `${status.version} on ${status.node}` },
      {
        id: 'accounts',
        ok: status.accounts.length > 0,
        detail: status.accounts.length === 0 ? 'no account signed in' : `${status.accounts.length} account(s)`,
      },
      {
        id: 'usable-accounts',
        ok: usable.length > 0,
        detail: usable.length === 0 ? 'every account needs sign-in or is paused' : `${usable.length} usable`,
      },
      {
        id: 'catalog',
        ok: status.models.length > 0,
        detail: status.models.length === 0 ? 'model catalog is empty' : `${status.models.length} model(s)`,
      },
      { id: 'shim', ok: shim.port > 0, detail: shim.port > 0 ? `loopback shim on port ${shim.port}` : 'shim is not listening' },
      {
        id: 'provider',
        ok: status.providerRegistered,
        detail: status.providerRegistered ? 'provider loomy is registered' : 'provider loomy is NOT registered',
      },
      {
        id: 'points',
        ok: status.accounts.length === 0 || withBalance.length > 0,
        detail: status.accounts.length === 0
          ? 'no account to look up'
          : withBalance.length === 0
            ? 'no account reports a positive balance yet (try refreshing points)'
            : `${withBalance.length} account(s) with points`,
      },
    ]
    json(res, 200, {
      report: {
        ok: checks.every(check => check.ok),
        version: status.version,
        node: status.node,
        checks,
        hints: status.accounts.length === 0
          ? ['add a Loomy account with its phone number and password (or paste a session)']
          : [],
      },
    })
  }
}

/** 挂载全部路由。 */
export function registerLoomyStatusRoutes(ctx: Context, deps: LoomyRouteOptions): void {
  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: LOOMY_STATUS_PATH, handler: statusHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: LOOMY_MODELS_PATH, handler: modelsHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: LOOMY_SELECTION_PATH, handler: selectionHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: LOOMY_SELECTION_INVERT_PATH, handler: invertSelectionHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: LOOMY_ACCOUNTS_PATH, handler: accountsHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: LOOMY_LOGIN_PATH, handler: loginHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: LOOMY_SMS_PATH, handler: smsHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: LOOMY_SESSION_PATH, handler: sessionHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: LOOMY_POINTS_PATH, handler: pointsHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: LOOMY_CHECKIN_PATH, handler: checkinHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: LOOMY_REFRESH_MODELS_PATH, handler: refreshModelsHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: LOOMY_DOCK_PATH, handler: dockHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: LOOMY_DOCTOR_PATH, handler: doctorHandler(deps) }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-loomy: web routes')
}
