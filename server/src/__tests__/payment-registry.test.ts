import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { PAYMENT_PROVIDER_NAMES } from '../modules/recharge/types.js'
import {
  getEnabledProvider,
  getHistoricalProvider,
  getRegisteredProvider,
  listMountedAdapterNames,
  listRegisteredProviderNames,
} from '../modules/payment/providers/registry.js'
import { assertProviderContractShape } from '../modules/payment/providers/contractHarness.js'

const originalRecharge = { ...config.recharge }
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

afterEach(() => {
  Object.assign(config.recharge, originalRecharge)
})

describe('payment provider registry', () => {
  it('mounts every named adapter including historical ones', () => {
    expect(listMountedAdapterNames().sort()).toEqual([...PAYMENT_PROVIDER_NAMES].sort())
    config.recharge.registeredProviders = [...PAYMENT_PROVIDER_NAMES]
    config.recharge.enabledProviders = ['simulator']
    for (const name of PAYMENT_PROVIDER_NAMES) {
      const provider = getRegisteredProvider(name)
      expect(provider, name).toBeDefined()
      assertProviderContractShape(provider!)
      expect(getHistoricalProvider(name).name).toBe(name)
    }
    expect(() => getEnabledProvider('stripe')).toThrow()
    expect(getEnabledProvider('simulator').name).toBe('simulator')
  })

  it('keeps historical adapters loaded after removing them from enabled', () => {
    config.recharge.registeredProviders = ['simulator', 'stripe', 'paypal', 'wechat_pay', 'alipay']
    config.recharge.enabledProviders = ['simulator']
    expect(listRegisteredProviderNames()).toContain('stripe')
    expect(getRegisteredProvider('alipay')?.name).toBe('alipay')
    expect(getHistoricalProvider('wechat_pay').name).toBe('wechat_pay')
  })

  it('keeps server package.json and lockfile payment SDK versions aligned', () => {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'server/package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    const lock = JSON.parse(readFileSync(resolve(repoRoot, 'server/package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string }>
    }
    expect(manifest.dependencies.stripe).toBe('^22.5.0')
    expect(manifest.dependencies['alipay-sdk']).toBe('^4.14.0')
    expect(lock.packages['node_modules/stripe']?.version).toBe('22.5.0')
    expect(lock.packages['node_modules/alipay-sdk']?.version).toBe('4.14.0')
    expect(manifest.dependencies).not.toHaveProperty('@paypal/checkout-server-sdk')
    expect(manifest.dependencies).not.toHaveProperty('wechatpay-node-v3')
  })
})
