import { createHash } from 'node:crypto'

export function syntheticRef(label: string): string {
  return createHash('sha256').update(`monexus-d02-synthetic:${label}`).digest('hex')
}

const subscriptionPrices = ['300', '500', '800', '1000', '1200', '1201', '1500', '1800', '2000', '2500', '3000', '3333']
const subscriptionCosts = ['80', '120', '200', '280', '400', '410', '500', null, '700', '900', '1100', '1500']

export function buildSyntheticSmallInput() {
  const offers = [
    ...subscriptionPrices.map((price, index) => ({
      offerRef: syntheticRef(`offer-subscription-${index + 1}`),
      category: 'subscription',
      pricePoints: price,
      ...(subscriptionCosts[index] === null
        ? {}
        : { merchantCostCnyAtomic: subscriptionCosts[index] as string }),
    })),
    {
      offerRef: syntheticRef('offer-digital-1'),
      category: 'digital',
      pricePoints: '99',
    },
    {
      offerRef: syntheticRef('offer-digital-2'),
      category: 'digital',
      pricePoints: '150',
    },
    {
      offerRef: syntheticRef('offer-digital-3'),
      category: 'digital',
      pricePoints: '200',
    },
    {
      offerRef: syntheticRef('offer-rare-1'),
      category: 'rare',
      pricePoints: '9999',
    },
    {
      offerRef: syntheticRef('offer-rare-2'),
      category: 'rare',
      pricePoints: '100',
    },
  ]

  const accounts = [
    { accountRef: syntheticRef('account-high-balance'), balancePoints: '100000000000000000000', frozenPoints: '5000' },
    { accountRef: syntheticRef('account-frozen'), balancePoints: '200', frozenPoints: '1800' },
    { accountRef: syntheticRef('account-zero-spend-1'), balancePoints: '4000', frozenPoints: '0' },
    { accountRef: syntheticRef('account-zero-spend-2'), balancePoints: '50', frozenPoints: '0' },
    { accountRef: syntheticRef('account-active-1'), balancePoints: '800', frozenPoints: '100' },
    { accountRef: syntheticRef('account-active-2'), balancePoints: '1500', frozenPoints: '0' },
    { accountRef: syntheticRef('account-active-3'), balancePoints: '2200', frozenPoints: '200' },
    { accountRef: syntheticRef('account-active-4'), balancePoints: '600', frozenPoints: '0' },
    { accountRef: syntheticRef('account-active-5'), balancePoints: '90', frozenPoints: '10' },
    { accountRef: syntheticRef('account-active-6'), balancePoints: '3100', frozenPoints: '0' },
    { accountRef: syntheticRef('account-active-7'), balancePoints: '0', frozenPoints: '0' },
    { accountRef: syntheticRef('account-active-8'), balancePoints: '18000', frozenPoints: '2000' },
  ]

  const monthlyActivity = [
    {
      month: '2026-01',
      accountRef: syntheticRef('account-high-balance'),
      earnedPoints: '8000',
      spentPoints: '1200',
      expiredPoints: '0',
      refundedPoints: '0',
    },
    {
      month: '2026-01',
      accountRef: syntheticRef('account-frozen'),
      earnedPoints: '400',
      spentPoints: '100',
      expiredPoints: '0',
      refundedPoints: '50',
    },
    {
      month: '2026-01',
      accountRef: syntheticRef('account-zero-spend-1'),
      earnedPoints: '600',
      spentPoints: '0',
      expiredPoints: '0',
      refundedPoints: '0',
    },
    {
      month: '2026-01',
      accountRef: syntheticRef('account-zero-spend-2'),
      earnedPoints: '80',
      spentPoints: '0',
      expiredPoints: '20',
      refundedPoints: '0',
    },
    {
      month: '2026-01',
      accountRef: syntheticRef('account-active-1'),
      earnedPoints: '900',
      spentPoints: '500',
      expiredPoints: '0',
      refundedPoints: '0',
    },
    {
      month: '2026-01',
      accountRef: syntheticRef('account-active-2'),
      earnedPoints: '1100',
      spentPoints: '800',
      expiredPoints: '0',
      refundedPoints: '200',
    },
    {
      month: '2026-01',
      accountRef: syntheticRef('account-active-3'),
      earnedPoints: '700',
      spentPoints: '700',
      expiredPoints: '0',
      refundedPoints: '0',
    },
    {
      month: '2026-01',
      accountRef: syntheticRef('account-active-4'),
      earnedPoints: '500',
      spentPoints: '300',
      expiredPoints: '0',
      refundedPoints: '0',
    },
    {
      month: '2026-01',
      accountRef: syntheticRef('account-active-5'),
      earnedPoints: '200',
      spentPoints: '150',
      expiredPoints: '0',
      refundedPoints: '0',
    },
    {
      month: '2026-01',
      accountRef: syntheticRef('account-active-6'),
      earnedPoints: '1400',
      spentPoints: '1000',
      expiredPoints: '0',
      refundedPoints: '0',
    },
    {
      month: '2026-01',
      accountRef: syntheticRef('account-active-7'),
      earnedPoints: '300',
      spentPoints: '300',
      expiredPoints: '0',
      refundedPoints: '0',
    },
    {
      month: '2026-01',
      accountRef: syntheticRef('account-active-8'),
      earnedPoints: '2500',
      spentPoints: '1800',
      expiredPoints: '0',
      refundedPoints: '0',
    },
    {
      month: '2026-02',
      accountRef: syntheticRef('account-high-balance'),
      earnedPoints: '8000',
      spentPoints: '0',
      expiredPoints: '0',
      refundedPoints: '0',
    },
    {
      month: '2026-02',
      accountRef: syntheticRef('account-active-1'),
      earnedPoints: '900',
      spentPoints: '1200',
      expiredPoints: '0',
      refundedPoints: '0',
    },
    {
      month: '2026-02',
      accountRef: syntheticRef('account-active-2'),
      earnedPoints: '1100',
      spentPoints: '400',
      expiredPoints: '0',
      refundedPoints: '0',
    },
    {
      month: '2026-03',
      accountRef: syntheticRef('account-active-8'),
      earnedPoints: '2500',
      spentPoints: '3333',
      expiredPoints: '0',
      refundedPoints: '100',
    },
  ]

  const orders = [
    {
      orderRef: syntheticRef('order-completed-1'),
      offerRef: syntheticRef('offer-subscription-5'),
      accountRef: syntheticRef('account-active-1'),
      points: '1200',
      status: 'completed',
    },
    {
      orderRef: syntheticRef('order-refunded-1'),
      offerRef: syntheticRef('offer-subscription-6'),
      accountRef: syntheticRef('account-active-2'),
      points: '1201',
      status: 'refunded',
    },
    {
      orderRef: syntheticRef('order-cancelled-1'),
      offerRef: syntheticRef('offer-digital-1'),
      accountRef: syntheticRef('account-active-5'),
      points: '99',
      status: 'cancelled',
    },
  ]

  return {
    schemaVersion: 1,
    period: {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-06-30T23:59:59.999Z',
    },
    offers,
    accounts,
    monthlyActivity,
    orders,
  }
}
