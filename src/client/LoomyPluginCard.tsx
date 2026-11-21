/**
 * Loomy 插件卡片（设置页 / 侧边栏整页 / bundle 详情页共用同一个组件）。
 *
 * 卡片自己读状态：`GET /api/loomy/status` 一次拿到账号、模型、用量、点数与显示开关，
 * 之后每 30 秒刷一次。所有写操作都返回新的状态文档，直接替换本地快照 —— 不靠「祈祷
 * 下一次轮询能反映出来」。
 *
 * 登录是**服务端**的，所以这里没有「打开浏览器授权」的跳转：手机号+密码直接 POST，
 * 卡片等 HTTP 响应即可。短信路径分两步（发码 → 填码），因为没有密码的账号只能这样
 * 拿一次会话。
 *
 * @module dsh-loomy/client/LoomyPluginCard
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Button, Checkbox, Input, SegmentedTabs, StateDot, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SegmentedTab, StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  LoomyDockFlags,
  LoomyModelSelection,
  LoomyWebAccount,
  LoomyWebModel,
  LoomyWebStatus,
  PointsRefreshResult,
} from '../web-status.ts'
import { DEFAULT_DOCK_FLAGS, dockSnapshot, publishDock, subscribeDock } from './dock-store.ts'
import { setSettingsEntryWanted, setSidebarPanelWanted } from './panel-switch.ts'
import { accountDisplayName, formatCount, formatTokens, formatWhen } from './format.ts'
import styles from './LoomyPluginCard.module.css'

/** 卡片注入的东西：只有翻译函数。 */
export interface LoomyPluginCardInjected {
  t: (key: string, params?: Record<string, string | number>) => string
}

type Tab = 'accounts' | 'models' | 'points' | 'display'

/** 状态轮询间隔。 */
const POLL_MS = 30_000

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...init?.body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...init?.headers ?? {},
    },
  })
  const text = await response.text()
  const parsed = text === '' ? {} : JSON.parse(text) as unknown
  if (!response.ok) {
    const message = typeof parsed === 'object' && parsed !== null && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  return parsed as T
}

function statusOfDot(account: LoomyWebAccount): StateDotState {
  if (account.paused) return 'idle'
  if (account.needsLogin) return 'error'
  if (account.slot?.coolUntil !== undefined && account.slot.coolUntil > Date.now()) return 'warning'
  return 'done'
}

type AccountAction =
  | 'pause'
  | 'resume'
  | 'pin'
  | 'unpin'
  | 'remove'
  | 'relogin'
  | 'rename'
  | 'password'

/** 一个账号行。 */
function AccountRow({
  account,
  t,
  pending,
  onAction,
}: {
  account: LoomyWebAccount
  t: LoomyPluginCardInjected['t']
  pending: boolean
  onAction: (action: AccountAction, value?: string) => void
}): ReactElement {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(account.label ?? '')
  const [settingPassword, setSettingPassword] = useState(false)
  const [password, setPassword] = useState('')
  const name = accountDisplayName(account, t('accountNoLabel'))
  const points = account.points?.snapshot?.available

  return (
    <div className={styles.accountRow}>
      <div className={styles.accountMain}>
        <div className={styles.accountTitle}>
          <StateDot state={statusOfDot(account)} />
          <span className={styles.accountName}>{name}</span>
          {account.pinned ? <Tag tone="info">{t('accountPinned')}</Tag> : null}
          {account.needsLogin ? <Tag tone="danger">{t('accountNeedsLogin')}</Tag> : null}
          {account.paused ? <Tag tone="neutral">{t('accountPaused')}</Tag> : null}
          {account.hasPassword ? null : <Tag tone="warning">{t('accountNoPassword')}</Tag>}
          <Tag tone={points === undefined ? 'outline' : points > 0 ? 'success' : 'warning'}>
            {points === undefined ? t('accountPointsUnknown') : t('accountPoints', { points: formatCount(points) })}
          </Tag>
        </div>
        <div className={styles.accountMeta}>
          {account.loginid === undefined ? <span>{account.id}</span> : <span>{account.loginid}</span>}
          {account.sessionDaysLeft === undefined
            ? <span>{t('accountSessionExpired')}</span>
            : <span>{t('accountSessionDays', { days: account.sessionDaysLeft })}</span>}
          {account.slot === undefined ? null : (
            <span>{t('accountConcurrency', { active: account.slot.activeConcurrent, max: account.slot.maxConcurrent })}</span>
          )}
          {account.devid === '' ? null : <span>{t('accountDevid', { devid: account.devid })}</span>}
          {account.slot?.lastError === undefined ? null : (
            <span className={styles.warnText} title={account.slot.lastError}>!</span>
          )}
        </div>
        {renaming ? (
          <div className={styles.inlineForm}>
            <Input
              value={draft}
              placeholder={t('accountRenamePlaceholder')}
              onChange={event => setDraft(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                onAction('rename', draft)
                setRenaming(false)
              }}
            >
              OK
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>×</Button>
          </div>
        ) : null}
        {settingPassword ? (
          <div className={styles.inlineForm}>
            <Input
              type="password"
              value={password}
              placeholder={t('accountSetPasswordPlaceholder')}
              onChange={event => setPassword(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={pending || password === ''}
              onClick={() => {
                onAction('password', password)
                setPassword('')
                setSettingPassword(false)
              }}
            >
              OK
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSettingPassword(false)}>×</Button>
          </div>
        ) : null}
      </div>
      <div className={styles.accountActions}>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setRenaming(value => !value)}>
          {t('accountRename')}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setSettingPassword(value => !value)}>
          {t('accountSetPassword')}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending || !account.hasPassword} onClick={() => onAction('relogin')}>
          {t('accountRelogin')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => onAction(account.pinned ? 'unpin' : 'pin')}
        >
          {account.pinned ? t('accountUnpin') : t('accountPin')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => onAction(account.paused ? 'resume' : 'pause')}
        >
          {account.paused ? t('accountResume') : t('accountPause')}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => onAction('remove')}>
          {t('accountDelete')}
        </Button>
      </div>
    </div>
  )
}

/** 一个模型行。 */
function ModelRow({
  model,
  enabled,
  t,
  onToggle,
}: {
  model: LoomyWebModel
  enabled: boolean
  t: LoomyPluginCardInjected['t']
  onToggle: (next: boolean) => void
}): ReactElement {
  return (
    <label className={styles.modelRow}>
      <Checkbox checked={enabled} onChange={onToggle} label="" />
      <div className={styles.modelMain}>
        <div className={styles.modelTitle}>
          <span className={styles.modelName}>{model.name}</span>
          {model.name === model.id ? null : <span className={styles.muted}>{model.id}</span>}
          {model.supportsImages ? <Tag tone="info">{t('modelVision')}</Tag> : null}
          {model.reasoning ? <Tag tone="outline">{t('modelReasoning')}</Tag> : null}
          {model.toolCall ? <Tag tone="outline">{t('modelTools')}</Tag> : null}
          {model.multiplier === undefined ? null : (
            <Tag tone="neutral">{t('modelMultiplier', { value: model.multiplier })}</Tag>
          )}
        </div>
        <div className={styles.modelMeta}>
          {model.contextWindow === undefined ? null : (
            <span>{t('modelContext', { tokens: formatTokens(model.contextWindow) })}</span>
          )}
          {model.maxTokens === undefined ? null : (
            <span>{t('modelOutput', { tokens: formatTokens(model.maxTokens) })}</span>
          )}
          {model.levels === undefined ? null : <span>{t('modelLevels', { levels: model.levels.join('/') })}</span>}
        </div>
      </div>
    </label>
  )
}

export function LoomyPluginCard({ t }: LoomyPluginCardInjected): ReactElement {
  const [status, setStatus] = useState<LoomyWebStatus | undefined>(undefined)
  const [selection, setSelection] = useState<LoomyModelSelection | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [tab, setTab] = useState<Tab>('accounts')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [smsCode, setSmsCode] = useState('')
  const [smsMsgid, setSmsMsgid] = useState<string | undefined>(undefined)
  const [session, setSession] = useState('')
  const [dock, setDock] = useState<LoomyDockFlags>(dockSnapshot().dock ?? DEFAULT_DOCK_FLAGS)
  const mounted = useRef(true)

  const refresh = async (): Promise<void> => {
    try {
      const [next, nextSelection] = await Promise.all([
        requestJson<{ status: LoomyWebStatus }>('/api/loomy/status'),
        requestJson<{ selection: LoomyModelSelection }>('/api/loomy/enabled-models'),
      ])
      if (!mounted.current) return
      setStatus(next.status)
      setSelection(nextSelection.selection)
      setDock(next.status.dock)
      publishDock({ dock: next.status.dock, writable: next.status.writable })
      setSettingsEntryWanted(next.status.dock.settingsEntry)
      setSidebarPanelWanted(next.status.dock.sidebar)
      setError(undefined)
    } catch (caught: unknown) {
      if (!mounted.current) return
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    const unsubscribe = subscribeDock(() => setDock(dockSnapshot().dock))
    return () => {
      mounted.current = false
      clearInterval(timer)
      unsubscribe()
    }
    // `refresh` 每次渲染都是新函数，但它的行为不变；只在挂载时排一次轮询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tabs = useMemo<readonly [SegmentedTab<Tab>, ...SegmentedTab<Tab>[]]>(() => [
    { value: 'accounts', label: t('tabAccounts'), id: 'loomy-tab-accounts', panelId: 'loomy-panel-accounts' },
    { value: 'models', label: t('tabModels'), id: 'loomy-tab-models', panelId: 'loomy-panel-models' },
    { value: 'points', label: t('tabPoints'), id: 'loomy-tab-points', panelId: 'loomy-panel-points' },
    { value: 'display', label: t('tabDisplay'), id: 'loomy-tab-display', panelId: 'loomy-panel-display' },
  ], [t])

  const accountAction = async (id: string, action: AccountAction, value?: string): Promise<void> => {
    setBusy(`${action}:${id}`)
    try {
      if (action === 'remove') {
        const next = await requestJson<{ status: LoomyWebStatus }>(
          `/api/loomy/accounts?id=${encodeURIComponent(id)}`,
          { method: 'DELETE' },
        )
        setStatus(next.status)
      } else {
        const body: Record<string, unknown> = { id }
        if (action === 'pause') body.paused = true
        if (action === 'resume') body.paused = false
        if (action === 'pin') body.pinned = true
        if (action === 'unpin') body.pinned = false
        if (action === 'relogin') body.relogin = true
        if (action === 'rename') body.label = value ?? ''
        if (action === 'password') body.password = value ?? ''
        const next = await requestJson<{ status: LoomyWebStatus }>('/api/loomy/accounts', {
          method: 'POST',
          body: JSON.stringify(body),
        })
        setStatus(next.status)
      }
      setError(undefined)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(undefined)
    }
  }

  const signIn = async (): Promise<void> => {
    setBusy('login')
    setNotice(undefined)
    try {
      const trimmedPhone = phone.trim()
      const next = await requestJson<{ status: LoomyWebStatus }>('/api/loomy/login', {
        method: 'POST',
        body: JSON.stringify({ loginid: trimmedPhone, password }),
      })
      setStatus(next.status)
      setPhone('')
      setPassword('')
      setNotice(t('signInDone'))
      setError(undefined)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(undefined)
    }
  }

  const sendSmsCode = async (): Promise<void> => {
    setBusy('sms-send')
    setNotice(undefined)
    try {
      const result = await requestJson<{ msgid: string }>('/api/loomy/sms', {
        method: 'POST',
        body: JSON.stringify({ loginid: phone.trim() }),
      })
      setSmsMsgid(result.msgid)
      setNotice(t('smsSent'))
      setError(undefined)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(undefined)
    }
  }

  const signInWithSms = async (): Promise<void> => {
    if (smsMsgid === undefined) return
    setBusy('sms-verify')
    try {
      const next = await requestJson<{ status: LoomyWebStatus }>('/api/loomy/sms', {
        method: 'POST',
        body: JSON.stringify({ loginid: phone.trim(), code: smsCode.trim(), msgid: smsMsgid }),
      })
      setStatus(next.status)
      setSmsCode('')
      setSmsMsgid(undefined)
      setPhone('')
      setError(undefined)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(undefined)
    }
  }

  const saveSession = async (): Promise<void> => {
    setBusy('session')
    try {
      const next = await requestJson<{ status: LoomyWebStatus }>('/api/loomy/session', {
        method: 'POST',
        body: JSON.stringify({ session: session.trim() }),
      })
      setStatus(next.status)
      setSession('')
      setError(undefined)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(undefined)
    }
  }

  const toggleModel = async (model: LoomyWebModel, next: boolean): Promise<void> => {
    if (selection === undefined) return
    const enabledIds = selection.choices.filter(choice => choice.enabled).map(choice => choice.id)
    const set = new Set(enabledIds)
    if (next) set.add(model.id)
    else set.delete(model.id)
    const all = selection.choices.map(choice => choice.id)
    // 全选 = 空数组（语义是「全部都可用」，不是「一个都不给」）。
    const payload = set.size === all.length ? [] : [...set]
    setBusy('models')
    try {
      const result = await requestJson<{ selection: LoomyModelSelection }>('/api/loomy/enabled-models', {
        method: 'POST',
        body: JSON.stringify({ enabledModels: payload }),
      })
      setSelection(result.selection)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(undefined)
    }
  }

  const refreshModels = async (): Promise<void> => {
    setBusy('refresh-models')
    try {
      const result = await requestJson<{
        models: number
        refreshed: boolean
        selection: LoomyModelSelection
        status: LoomyWebStatus
      }>('/api/loomy/refresh-models', { method: 'POST' })
      setSelection(result.selection)
      setStatus(result.status)
      setError(undefined)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(undefined)
    }
  }

  /** 「刷新点数」：真的去查上游账本（不是探活）。 */
  const refreshPoints = async (): Promise<void> => {
    setBusy('points')
    try {
      const result = await requestJson<{ outcome: PointsRefreshResult; status: LoomyWebStatus }>(
        '/api/loomy/points',
        { method: 'POST', body: '{}' },
      )
      setStatus(result.status)
      setNotice(result.outcome.message)
      setError(result.outcome.ok ? undefined : result.outcome.message)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(undefined)
    }
  }

  /** 体检：读一次 /doctor，把结果写进 notice/error。 */
  const diagnose = async (): Promise<void> => {
    setBusy('doctor')
    try {
      const result = await requestJson<{ report: { ok: boolean; checks: { id: string; ok: boolean; detail: string }[] } }>(
        '/api/loomy/doctor',
      )
      const failed = result.report.checks.find(check => !check.ok)
      if (result.report.ok) {
        setNotice(t('doctorOk'))
        setError(undefined)
      } else {
        setNotice(undefined)
        setError(t('doctorFail', {
          detail: failed === undefined ? 'unknown' : `${failed.id}: ${failed.detail}`,
        }))
      }
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(undefined)
    }
  }

  const setDockFlag = async (patch: Partial<LoomyDockFlags>): Promise<void> => {
    setDock(current => ({ ...current, ...patch }))
    publishDock({ dock: patch })
    if (patch.sidebar !== undefined) setSidebarPanelWanted(patch.sidebar)
    if (patch.settingsEntry !== undefined) setSettingsEntryWanted(patch.settingsEntry)
    try {
      await requestJson('/api/loomy/dock', { method: 'POST', body: JSON.stringify(patch) })
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const accounts = status?.accounts ?? []
  const usage = status?.usage
  const exhausted = accounts.filter(account => account.points?.exhaustedAt !== undefined)
  const withPoints = accounts.filter(account => account.points?.snapshot?.available !== undefined)
  const totalPoints = withPoints.reduce((sum, account) => sum + (account.points?.snapshot?.available ?? 0), 0)

  return (
    <div className={styles.card}>
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <h2 className={styles.title}>{t('cardTitle')}</h2>
          <p className={styles.subtitle}>{t('cardSubtitle')}</p>
        </div>
        <div className={styles.headerMeta}>
          {status === undefined ? (
            <span className={styles.muted}>{t('statusLoading')}</span>
          ) : (
            <Tag tone={accounts.length > 0 ? 'success' : 'warning'}>
              {accounts.length === 0 ? t('signedOut') : t('signedInCount', { count: accounts.length })}
            </Tag>
          )}
          {status === undefined ? null : <span className={styles.muted}>{t('versionLabel', { version: status.version })}</span>}
        </div>
      </header>

      {error === undefined ? null : <div className={styles.error}>{t('loadFailed', { message: error })}</div>}
      {notice === undefined ? null : <div className={styles.notice}>{notice}</div>}

      <SegmentedTabs items={tabs} value={tab} onChange={setTab} label={t('cardTitle')} className={styles.tabs} size="sm" />

      {tab === 'accounts' ? (
        <section id="loomy-panel-accounts" role="tabpanel" aria-labelledby="loomy-tab-accounts" className={styles.section}>
          <div className={styles.signInBox}>
            <Input
              value={phone}
              placeholder={t('phonePlaceholder')}
              onChange={event => setPhone(event.target.value)}
              className={styles.tokenInput}
            />
            <Input
              type="password"
              value={password}
              placeholder={t('passwordPlaceholder')}
              onChange={event => setPassword(event.target.value)}
              className={styles.tokenInput}
            />
            <Button
              variant="primary"
              disabled={busy === 'login' || phone.trim() === '' || password === ''}
              onClick={() => void signIn()}
            >
              {t('signInSubmit')}
            </Button>
          </div>
          <p className={styles.note}>{t('signInHint')}</p>
          <div className={styles.signInBox}>
            <Button
              variant="outline"
              size="sm"
              disabled={busy === 'sms-send' || phone.trim() === ''}
              onClick={() => void sendSmsCode()}
            >
              {t('smsSend')}
            </Button>
            <Input
              value={smsCode}
              placeholder={t('smsPlaceholder')}
              onChange={event => setSmsCode(event.target.value)}
              className={styles.tokenInput}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={busy === 'sms-verify' || smsMsgid === undefined || smsCode.trim() === ''}
              onClick={() => void signInWithSms()}
            >
              {t('smsSubmit')}
            </Button>
            <span className={styles.muted}>{t('smsHint')}</span>
          </div>
          <div className={styles.signInBox}>
            <Input
              value={session}
              placeholder={t('sessionPlaceholder')}
              onChange={event => setSession(event.target.value)}
              className={styles.tokenInput}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={busy === 'session' || session.trim() === ''}
              onClick={() => void saveSession()}
            >
              {t('sessionSubmit')}
            </Button>
            <span className={styles.muted}>{t('sessionHint')}</span>
          </div>
          {accounts.length === 0 ? (
            <p className={styles.muted}>{t('signedOut')}</p>
          ) : (
            <div className={styles.list}>
              {accounts.map(account => (
                <AccountRow
                  key={account.id}
                  account={account}
                  t={t}
                  pending={busy !== undefined && busy.endsWith(`:${account.id}`)}
                  onAction={(action, value) => void accountAction(account.id, action, value)}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {tab === 'models' ? (
        <section id="loomy-panel-models" role="tabpanel" aria-labelledby="loomy-tab-models" className={styles.section}>
          <div className={styles.toolbar}>
            <Button variant="outline" size="sm" disabled={busy === 'refresh-models'} onClick={() => void refreshModels()}>
              {busy === 'refresh-models' ? t('refreshing') : t('refreshModels')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={selection === undefined || busy === 'models'}
              onClick={() => {
                if (selection === undefined) return
                setBusy('models')
                void requestJson<{ selection: LoomyModelSelection }>('/api/loomy/enabled-models', {
                  method: 'POST',
                  body: JSON.stringify({ enabledModels: [] }),
                }).then(result => setSelection(result.selection)).catch(() => {}).finally(() => setBusy(undefined))
              }}
            >
              {t('selectAll')}
            </Button>
            <span className={styles.muted}>
              {selection === undefined || !selection.restricted ? t('selectionAll') : t('selectionRestricted')}
            </span>
          </div>
          {(selection?.choices ?? []).length === 0 ? (
            <>
              <p className={styles.muted}>{t('modelsEmpty')}</p>
              <p className={styles.muted}>{t('modelsEmptyHint')}</p>
            </>
          ) : (
            <div className={styles.list}>
              {(selection?.choices ?? []).map(choice => (
                <ModelRow
                  key={choice.id}
                  model={choice}
                  enabled={choice.enabled}
                  t={t}
                  onToggle={next => void toggleModel(choice, next)}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {tab === 'points' ? (
        <section id="loomy-panel-points" role="tabpanel" aria-labelledby="loomy-tab-points" className={styles.section}>
          <div className={styles.quotaBox}>
            <div className={styles.toolbar}>
              <span className={styles.quotaTitle}>{t('pointsTitle')}</span>
              <Tag tone={exhausted.length > 0 ? 'danger' : 'outline'}>
                {t('pointsAvailable', { points: formatCount(totalPoints) })}
              </Tag>
              <span className={styles.muted}>{t('strategyLabel')}：{strategyLabel(status?.strategy, t)}</span>
              <Button variant="outline" size="sm" disabled={busy === 'points'} onClick={() => void refreshPoints()}>
                {busy === 'points' ? t('pointsRefreshing') : t('pointsRefresh')}
              </Button>
            </div>
            {exhausted.length === 0 ? null : (
              <div className={styles.quotaExhausted}>
                <Tag tone="danger">{t('pointsExhaustedTag')}</Tag>
                <span>{t('pointsExhaustedNotice', { count: exhausted.length })}</span>
                <span className={styles.muted}>
                  {exhausted
                    .map(account => accountDisplayName(account, t('accountNoLabel')))
                    .join(', ')}
                </span>
              </div>
            )}
            <p className={styles.note}>{t('pointsNote')}</p>
          </div>
          {accounts.length === 0 ? <p className={styles.muted}>{t('signedOut')}</p> : (
            <div className={styles.list}>
              {accounts.map(account => {
                const state = account.points
                const snapshot = state?.snapshot
                return (
                  <div key={account.id} className={styles.checkinRow}>
                    <StateDot state={state === undefined
                      ? 'idle'
                      : state.exhaustedAt !== undefined
                        ? 'error'
                        : state.error !== undefined ? 'warning' : 'done'}
                    />
                    <span className={styles.accountName}>{accountDisplayName(account, t('accountNoLabel'))}</span>
                    <span className={styles.muted}>
                      {snapshot === undefined
                        ? t('pointsNever')
                        : `${t('pointsAvailable', { points: formatCount(snapshot.available ?? 0) })} · ${
                          t('pointsBalance', { points: formatCount(snapshot.balance ?? 0) })} · ${
                          t('pointsDaily', { points: formatCount(snapshot.dailyBalance ?? 0) })}`}
                    </span>
                    <span className={styles.muted}>
                      {state?.checkedAt === undefined ? '' : t('pointsChecked', { when: formatWhen(state.checkedAt) })}
                    </span>
                    {state?.error === undefined ? null : (
                      <span className={styles.warnText}>{t('pointsError', { message: state.error })}</span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      ) : null}

      {tab === 'display' ? (
        <section id="loomy-panel-display" role="tabpanel" aria-labelledby="loomy-tab-display" className={styles.section}>
          {status !== undefined && status.writable !== true ? <p className={styles.muted}>{t('displayReadonly')}</p> : null}
          <div className={styles.switchRow}>
            <Switch checked={dock.dock} onChange={next => void setDockFlag({ dock: next })} label={t('showDock')} />
            <span>{t('showDock')}</span>
          </div>
          <div className={styles.switchRow}>
            <Switch checked={dock.sidebar} onChange={next => void setDockFlag({ sidebar: next })} label={t('showSidebar')} />
            <span>{t('showSidebar')}</span>
          </div>
          <div className={styles.switchRow}>
            <Switch
              checked={dock.settingsEntry}
              onChange={next => void setDockFlag({ settingsEntry: next })}
              label={t('showSettings')}
            />
            <span>{t('showSettings')}</span>
          </div>
        </section>
      ) : null}

      <footer className={styles.footer}>
        <span className={styles.footerTitle}>{t('usageTitle')}</span>
        <span>{t('usageTodayRequests', { count: formatCount(usage?.today.requests ?? 0) })}</span>
        <span>{t('usageTodayInput', { tokens: formatCount(usage?.today.inputTokens ?? 0) })}</span>
        <span>{t('usageTodayOutput', { tokens: formatCount(usage?.today.outputTokens ?? 0) })}</span>
        <span>{t('usageTodayPoints', { points: formatCount(usage?.today.points ?? 0) })}</span>
        <span className={styles.muted} title={t('usageScope')}>{t('usageScope')}</span>
        <Button size='sm' variant='ghost' disabled={busy === 'doctor'} onClick={() => void diagnose()}>
          {t('doctor')}
        </Button>
      </footer>
    </div>
  )
}

/** 策略名的翻译（未知值原样显示，别让卡片因为一个枚举值空白）。 */
function strategyLabel(strategy: string | undefined, t: LoomyPluginCardInjected['t']): string {
  if (strategy === 'balance') return t('strategyBalance')
  if (strategy === 'round_robin') return t('strategyRoundRobin')
  if (strategy === 'lru') return t('strategyLru')
  return strategy ?? ''
}
