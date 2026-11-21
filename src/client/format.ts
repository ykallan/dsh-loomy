/**
 * 展示层的小格式化函数（纯函数，便于单测）。
 *
 * @module dsh-loomy/client/format
 */

/** `12345` → `12,345`。 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  return Math.floor(value).toLocaleString('en-US')
}

/** `1_048_576` → `1M`、`170_000` → `170K`、`32768` → `32K`。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, '')}M`
  }
  if (value >= 1_000) {
    const thousands = value / 1_000
    return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, '')}K`
  }
  return String(Math.round(value))
}

/** 相对时间：`刚刚` / `3 分钟前` / 具体日期。 */
export function formatWhen(at: number | undefined, now = Date.now()): string {
  if (at === undefined || !Number.isFinite(at) || at <= 0) return '—'
  const delta = now - at
  if (delta < 0) {
    const minutes = Math.max(1, Math.round(-delta / 60_000))
    return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`
  }
  if (delta < 60_000) return '刚刚'
  if (delta < 60 * 60_000) return `${Math.round(delta / 60_000)} 分钟前`
  if (delta < 24 * 60 * 60_000) return `${Math.round(delta / (60 * 60_000))} 小时前`
  return new Date(at).toLocaleDateString()
}

/**
 * 账号的显示名：备注名 → 打码手机号 → 用户 id → 未命名。
 *
 * `phone` 是宿主已经打码过的（`138****0000`），这里不再加工。
 */
export function accountDisplayName(
  account: { label?: string; loginid?: string; userid?: string; id: string },
  fallback: string,
): string {
  return account.label ?? account.loginid ?? account.userid ?? (account.id === '' ? fallback : account.id)
}
