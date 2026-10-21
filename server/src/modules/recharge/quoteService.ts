import { prisma } from '../../lib/prisma.js'
import { config } from '../../config/index.js'
import { listEnabledProviders } from '../payment/providers/registry.js'
import type { AmountSource, PaymentProviderName } from './types.js'
import { serializeAmountMinor } from './money.js'
import { assertCurrencyEnabled, assertRechargeAcceptsNewOrders, assertRechargeNotRestricted, isAdminSandboxMode, assertAdminSandboxActor, assertAdminSandboxSelection } from './gates.js'
import { assertAmountAllowed, effectiveAmountBounds, getActivePricePolicy, priceAmount, type ActivePricePolicy } from './policy.js'
import { remainingLimits } from './limits.js'
import { resolveLimitPeriods } from './periods.js'
import { asProviderName, resolveCapabilities } from './providerSelection.js'

export const QUOTE_TTL_MS = 10 * 60 * 1000

const PROVIDER_PAYMENT_METHODS: Readonly<Record<PaymentProviderName, readonly string[]>> = {
  simulator: ['card', 'redirect', 'qr_code', 'form_post'],
  stripe: ['card'],
  paypal: ['redirect'],
  wechat_pay: ['native'],
  alipay: ['wap', 'page'],
  vmqfox: ['wechat', 'alipay'],
}

export async function getRechargeConfig(userId: number, currencyRaw: string, role: string) {
  assertRechargeAcceptsNewOrders()
  assertAdminSandboxActor(role)
  assertCurrencyEnabled(currencyRaw)
  const currency = currencyRaw
  const policy = await getActivePricePolicy(currency, isAdminSandboxMode())
  const now = new Date()
  const periods = resolveLimitPeriods(now, policy.limitTimeZone)
  const remaining = await remainingLimits(
    userId,
    currency,
    policy.dailyLimitMinor,
    policy.monthlyLimitMinor,
    periods.day,
    periods.month,
    prisma,
  )
  const providers = []
  for (const adapter of listEnabledProviders()) {
    const methods = []
    const probeMethods = isAdminSandboxMode() ? ['card'] : PROVIDER_PAYMENT_METHODS[adapter.name]
    for (const paymentMethod of probeMethods) {
      try {
        const resolved = await resolveCapabilities({
          providerName: adapter.name,
          currency,
          paymentMethod,
        })
        methods.push({
          paymentMethod,
          actionTypes: [...resolved.capabilities.actionTypes],
          supportsBuyerApprovalCapture: resolved.capabilities.supportsBuyerApprovalCapture,
          minimumAmountMinor: serializeAmountMinor(resolved.capabilities.minimumAmountMinor),
          maximumAmountMinor: resolved.capabilities.maximumAmountMinor == null
            ? null
            : serializeAmountMinor(resolved.capabilities.maximumAmountMinor),
        })
      } catch {
        // Combination is not offered for this currency.
      }
    }
    if (methods.length > 0) {
      providers.push({ provider: adapter.name, paymentMethods: methods })
    }
  }
  const sandboxBalance = isAdminSandboxMode()
    ? (await prisma.pointAccount.findUnique({ where: { userId }, select: { sandboxBalance: true } }))?.sandboxBalance ?? 0
    : undefined
  return {
    currency,
    mode: config.recharge.mode,
    pricePolicyId: policy.id,
    pricePolicyCode: policy.code,
    minAmountMinor: serializeAmountMinor(policy.minAmountMinor),
    maxAmountMinor: serializeAmountMinor(policy.maxAmountMinor),
    amountStepMinor: serializeAmountMinor(policy.amountStepMinor),
    dailyLimitMinor: serializeAmountMinor(policy.dailyLimitMinor),
    monthlyLimitMinor: serializeAmountMinor(policy.monthlyLimitMinor),
    dailyRemainingMinor: serializeAmountMinor(remaining.dailyRemainingMinor),
    monthlyRemainingMinor: serializeAmountMinor(remaining.monthlyRemainingMinor),
    suggestedAmounts: policy.suggestedAmounts.map(item => ({
      amountMinor: serializeAmountMinor(item.amountMinor),
      sortOrder: item.sortOrder,
    })),
    providers,
    ...(sandboxBalance !== undefined ? { sandboxBalance } : {}),
  }
}

export async function createQuote(userId: number, input: {
  currency: string
  amountMinor: bigint
  amountSource: AmountSource
  provider: string
  paymentMethod: string
}, role: string) {
  assertRechargeAcceptsNewOrders()
  assertAdminSandboxActor(role)
  assertAdminSandboxSelection(input)
  assertCurrencyEnabled(input.currency)
  await assertRechargeNotRestricted(userId)
  const currency = input.currency
  const providerName = asProviderName(input.provider)
  const policy = await getActivePricePolicy(currency, isAdminSandboxMode())
  const resolved = await resolveCapabilities({
    providerName,
    currency,
    paymentMethod: input.paymentMethod,
  })
  const bounds = effectiveAmountBounds(
    currency,
    policy,
    resolved.capabilities.minimumAmountMinor,
    resolved.capabilities.maximumAmountMinor,
  )
  assertAmountAllowed({
    amountMinor: input.amountMinor,
    amountSource: input.amountSource,
    bounds,
    stepMinor: policy.amountStepMinor,
    suggestedAmounts: policy.suggestedAmounts.map(item => item.amountMinor),
  })
  const priced = priceAmount(policy, input.amountMinor)
  const expiresAt = new Date(Date.now() + QUOTE_TTL_MS)
  const quote = await prisma.rechargeQuote.create({
    data: {
      userId,
      pricePolicyId: policy.id,
      provider: providerName,
      paymentMethod: input.paymentMethod,
      providerAccountKey: resolved.accountKey,
      capabilityVersion: resolved.capabilities.capabilityVersion,
      capabilityDigest: resolved.capabilities.capabilityDigest,
      currency,
      amountMinor: input.amountMinor,
      effectiveMinAmountMinor: bounds.minAmountMinor,
      effectiveMaxAmountMinor: bounds.maxAmountMinor,
      basePoints: priced.basePoints,
      bonusPoints: priced.bonusPoints,
      totalPoints: priced.totalPoints,
      amountSource: input.amountSource,
      adminSandbox: isAdminSandboxMode(),
      expiresAt,
    },
  })
  return serializeQuote(quote, policy)
}

function serializeQuote(quote: {
  id: string
  currency: string
  amountMinor: bigint
  basePoints: bigint
  bonusPoints: bigint
  totalPoints: bigint
  pricePolicyId: string
  provider: string
  paymentMethod: string
  effectiveMinAmountMinor: bigint
  effectiveMaxAmountMinor: bigint
  expiresAt: Date
}, policy: Pick<ActivePricePolicy, 'code'>) {
  return {
    quoteId: quote.id,
    currency: quote.currency,
    amountMinor: serializeAmountMinor(quote.amountMinor),
    basePoints: serializeAmountMinor(quote.basePoints),
    bonusPoints: serializeAmountMinor(quote.bonusPoints),
    totalPoints: serializeAmountMinor(quote.totalPoints),
    pricePolicyId: quote.pricePolicyId,
    pricePolicyCode: policy.code,
    provider: quote.provider,
    paymentMethod: quote.paymentMethod,
    effectiveMinAmountMinor: serializeAmountMinor(quote.effectiveMinAmountMinor),
    effectiveMaxAmountMinor: serializeAmountMinor(quote.effectiveMaxAmountMinor),
    expiresAt: quote.expiresAt.toISOString(),
  }
}
