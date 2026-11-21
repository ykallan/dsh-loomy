import { describe, expect, it } from 'vitest'
import { en, zh, type LoomySettingsKey } from '../src/client/locales.ts'

/**
 * 文案表：`zh` 是键的权威，`en` 必须与它一一对应。
 *
 * 漏一条不是「英文里少个词」——宿主的 `locale.bind` 在缺键时会直接显示键名，
 * 卡片上就会出现 `accountSetPassword` 这种字符串。
 */

const zhKeys = Object.keys(zh).sort()
const enKeys = Object.keys(en).sort()

describe('locales', () => {
  it('has the same keys in both languages', () => {
    expect(enKeys).toEqual(zhKeys)
  })

  it('has no empty strings', () => {
    for (const [key, value] of Object.entries(zh)) expect(value, `zh.${key}`).not.toBe('')
    for (const [key, value] of Object.entries(en)) expect(value, `en.${key}`).not.toBe('')
  })

  it('uses the same placeholders in both languages', () => {
    const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
    for (const key of zhKeys) {
      expect(placeholders(en[key as keyof LoomySettingsKey]), key).toEqual(
        placeholders(zh[key as keyof LoomySettingsKey]),
      )
    }
  })

  it('names the provider consistently', () => {
    expect(zh.dockProvider).toBe('Loomy')
    expect(en.dockProvider).toBe('Loomy')
    expect(zh.tabLabel).toBe('Loomy')
  })
})
