import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AdminPricePolicy } from '../../../api/adminRecharge'

const {
  listAdminPricePolicies,
  createAdminPricePolicy,
  activateAdminPricePolicy,
} = vi.hoisted(() => ({
  listAdminPricePolicies: vi.fn(),
  createAdminPricePolicy: vi.fn(),
  activateAdminPricePolicy: vi.fn(),
}))

vi.mock('../../../api/adminRecharge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/adminRecharge')>()
  return {
    ...actual,
    listAdminPricePolicies,
    createAdminPricePolicy,
    activateAdminPricePolicy,
  }
})

import AdminPricePolicies from './AdminPricePolicies'
import { RP_CNY_VMQFOX_V1_CREATE_EXAMPLE } from '../../../api/adminRecharge'

function policy(overrides: Partial<AdminPricePolicy> = {}): AdminPricePolicy {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    code: 'rp-cny-vmqfox-v1',
    version: 1,
    currency: 'CNY',
    adminSandbox: false,
    status: 'draft',
    currencyScale: 2,
    pointsNumerator: '1',
    pointsDenominator: '1',
    roundingMode: 'HALF_EVEN',
    minAmountMinor: '100',
    maxAmountMinor: '100000',
    amountStepMinor: '100',
    dailyLimitMinor: '200000',
    monthlyLimitMinor: '1000000',
    limitTimeZone: 'Asia/Shanghai',
    bonusRuleVersion: null,
    suggestedAmounts: RP_CNY_VMQFOX_V1_CREATE_EXAMPLE.suggestedAmounts,
    effectiveAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('AdminPricePolicies', () => {
  beforeEach(() => {
    listAdminPricePolicies.mockReset()
    createAdminPricePolicy.mockReset()
    activateAdminPricePolicy.mockReset()
    listAdminPricePolicies.mockResolvedValue({ page: 1, pageSize: 50, total: 0, items: [] })
  })

  it('lists production policies and creates a draft from the VMQFox example', async () => {
    const created = policy()
    createAdminPricePolicy.mockResolvedValue(created)
    listAdminPricePolicies
      .mockResolvedValueOnce({ page: 1, pageSize: 50, total: 0, items: [] })
      .mockResolvedValueOnce({ page: 1, pageSize: 50, total: 1, items: [created] })
    render(<AdminPricePolicies />)
    expect(await screen.findByTestId('admin-price-policies')).toBeInTheDocument()
    await waitFor(() => expect(listAdminPricePolicies).toHaveBeenCalledWith(expect.objectContaining({ adminSandbox: false })))

    fireEvent.click(screen.getByTestId('admin-price-policy-create'))
    fireEvent.click(screen.getByTestId('admin-price-policy-fill-example'))
    fireEvent.click(screen.getByTestId('admin-price-policy-submit'))
    await waitFor(() => expect(createAdminPricePolicy).toHaveBeenCalledWith(expect.objectContaining({
      ...RP_CNY_VMQFOX_V1_CREATE_EXAMPLE,
      adminSandbox: false,
    })))
    expect(await screen.findByTestId('admin-price-policy-row-rp-cny-vmqfox-v1')).toBeInTheDocument()
    expect(screen.getByText('草稿')).toBeInTheDocument()
  })

  it('activates a draft policy after confirmation', async () => {
    const draft = policy()
    listAdminPricePolicies.mockResolvedValue({ page: 1, pageSize: 50, total: 1, items: [draft] })
    activateAdminPricePolicy.mockResolvedValue({ ...draft, status: 'active' })
    render(<AdminPricePolicies />)
    fireEvent.click(await screen.findByTestId('admin-price-policy-activate-rp-cny-vmqfox-v1'))
    fireEvent.click(screen.getByRole('button', { name: '确认激活' }))
    await waitFor(() => expect(activateAdminPricePolicy).toHaveBeenCalledWith(draft.id))
  })
})
