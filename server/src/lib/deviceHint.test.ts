import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEVICE_LABEL,
  isKnownDeviceLabel,
  normalizeStoredDeviceLabel,
  parseDeviceHint,
  sessionDeviceLabel,
} from './deviceHint.js'

describe('bounded linear User-Agent parser (deviceHint)', () => {
  it('recognizes desktop, mobile, in-app, WebView, ChromeOS, and HarmonyOS agents', () => {
    expect(parseDeviceHint('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36')).toBe('Chrome · macOS')
    expect(parseDeviceHint('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1')).toBe('Safari · iOS')
    expect(parseDeviceHint('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 EdgiOS/124.0.0.0 Mobile/15E148 Safari/605.1.15')).toBe('Edge · iOS')
    expect(parseDeviceHint('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36 EdgA/124.0.0.0')).toBe('Edge · Android')
    expect(parseDeviceHint('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 FxiOS/124.0 Mobile/15E148 Safari/605.1.15')).toBe('Firefox · iOS')
    expect(parseDeviceHint('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.48(0x1800302c)')).toBe('WeChat · iOS')
    expect(parseDeviceHint('Mozilla/5.0 (Linux; Android 14; V2309A) AppleWebKit/537.36 MQQBrowser/14.0 Chrome/116.0 Mobile Safari/537.36')).toBe('QQ · Android')
    expect(parseDeviceHint('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 QQ/9.0.30')).toBe('QQ · iOS')
    expect(parseDeviceHint('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148')).toBe('WebView · iOS')
    expect(parseDeviceHint('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36')).toBe('Chrome · ChromeOS')
    expect(parseDeviceHint('Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 ArkWeb/4.1.6.1 Mobile Chrome/114.0 Safari/537.36')).toBe('Chrome · HarmonyOS')
    expect(parseDeviceHint('Mozilla/5.0 (Linux; HarmonyOS 4.2; ALN-AL00) AppleWebKit/537.36 Chrome/114.0 Safari/537.36')).toBe('Chrome · HarmonyOS')
  })

  it('does not misclassify Microsoft substring as ChromeOS', () => {
    expect(parseDeviceHint('Microsoft-CryptoAPI/10.0')).toBeNull()
    expect(parseDeviceHint('Mozilla/5.0 (Windows NT 10.0; Microsoft Edge) Edg/131.0')).toBe('Edge · Windows')
  })

  it('returns null from parseDeviceHint and Chinese fallback from sessionDeviceLabel when both browser and platform are unknown', () => {
    for (const input of [null, undefined, '', '   ', 'CustomAgent/1.0', 'curl/8.7.1']) {
      expect(parseDeviceHint(input)).toBeNull()
      expect(sessionDeviceLabel(input)).toBe(DEFAULT_DEVICE_LABEL)
    }
  })

  it('truncates oversized UAs to 512 UTF-8 bytes and avoids regex backtracking', () => {
    const padding = 'Version/1 '.repeat(10_000)
    const start = performance.now()
    const result = parseDeviceHint(`${padding}Chrome/131.0 (Macintosh)`)
    const elapsedMs = performance.now() - start

    // Tokens past 512 UTF-8 bytes are ignored and execution stays sub-millisecond/bounded.
    expect(result).toBeNull()
    expect(elapsedMs).toBeLessThan(50)

    // Multi-byte UTF-8 boundary and surrogate pairs do not corrupt or throw.
    const multiByte = `${'汉'.repeat(200)} Chrome/131.0`
    expect(parseDeviceHint(multiByte)).toBeNull()
    expect(parseDeviceHint(`${' '.repeat(500_000)}Chrome/131.0`)).toBeNull()
    expect(parseDeviceHint(`${'😀'.repeat(260)}Chrome/131.0`)).toBeNull()

    // Single-pass Safari check matches exact Version/<non-space>...Safari/ ordering.
    expect(parseDeviceHint('Mozilla/5.0 (Macintosh; Intel Mac OS X) Version/17.0 Safari/605.1.15')).toBe('Safari · macOS')
    expect(parseDeviceHint('Mozilla/5.0 (Macintosh; Intel Mac OS X) Version/ Safari/605.1.15')).toBe('Unknown browser · macOS')
    expect(parseDeviceHint('Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/605.1.15 Version/17.0')).toBe('Unknown browser · macOS')
  })

  it('recognizes whitelisted labels and makes normalizeStoredDeviceLabel strictly idempotent', () => {
    for (const label of [DEFAULT_DEVICE_LABEL, 'Chrome · macOS', 'WeChat · iOS', 'WebView · iOS', 'Firefox · Unknown device']) {
      expect(isKnownDeviceLabel(label)).toBe(true)
      expect(normalizeStoredDeviceLabel(label)).toBe(label)
    }
    expect(isKnownDeviceLabel('Unknown browser · Unknown device')).toBe(false)
    expect(isKnownDeviceLabel('Mozilla/5.0 (Macintosh) Chrome/131.0')).toBe(false)

    const once = normalizeStoredDeviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/131.0')
    expect(once).toBe('Chrome · macOS')
    expect(normalizeStoredDeviceLabel(once)).toBe(once)

    const fallbackOnce = normalizeStoredDeviceLabel('legacy-unknown-agent')
    expect(fallbackOnce).toBe(DEFAULT_DEVICE_LABEL)
    expect(normalizeStoredDeviceLabel(fallbackOnce)).toBe(fallbackOnce)
  })
})
