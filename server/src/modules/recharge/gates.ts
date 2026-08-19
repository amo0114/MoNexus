import { config } from '../../config/index.js'
import {
  forbidden,
  paymentProviderUnavailable,
  rechargeCurrencyDisabled,
  rechargeDisabled,
  rechargeUnavailable,
} from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'
import type { PaymentProviderName, RechargeCurrency } from './types.js'

export function assertRechargeAcceptsNewOrders() {
  if (config.recharge.mode === 'disabled') {
    throw rechargeDisabled()
  }
  if (!config.recharge.acceptNewOrders) {
    throw rechargeUnavailable()
  }
}

export function assertCurrencyEnabled(currency: string): asserts currency is RechargeCurrency {
  if (!(config.recharge.enabledCurrencies as readonly string[]).includes(currency)) {
    throw rechargeCurrencyDisabled()
  }
}

export function assertProviderEnabled(name: PaymentProviderName) {
  if (!config.recharge.enabledProviders.includes(name)) {
    throw paymentProviderUnavailable()
  }
}

export function providerEnvironment(): 'sandbox' | 'live' {
  return config.recharge.mode === 'live' ? 'live' : 'sandbox'
}

export async function assertRechargeNotRestricted(userId: number) {
  const restriction = await prisma.accountRestriction.findFirst({
    where: { userId, status: 'active', blocksRecharge: true },
    select: { id: true },
  })
  if (restriction) {
    throw forbidden('当前账户暂不可充值')
  }
}
