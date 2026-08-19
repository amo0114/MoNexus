import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { RechargeConfig, RechargeOrder, RechargeQuote } from '../api/recharge'
import { useAuthStore } from '../stores/authStore'

const {
  getRechargeConfig,
  createRechargeQuote,
  createRechargeOrder,
  getRechargeOrder,
  completeRechargeOrder,
  listRechargeOrders,
  fetchMeWithRoleHealing,
  submitFormPost,
  goToRedirect,
} = vi.hoisted(() => ({
  getRechargeConfig: vi.fn(),
  createRechargeQuote: vi.fn(),
  createRechargeOrder: vi.fn(),
  getRechargeOrder: vi.fn(),
  completeRechargeOrder: vi.fn(),
  listRechargeOrders: vi.fn(),
  fetchMeWithRoleHealing: vi.fn(),
  submitFormPost: vi.fn(),
  goToRedirect: vi.fn(),
}))

vi.mock('../api/recharge', () => ({
  getRechargeConfig,
  createRechargeQuote,
  createRechargeOrder,
  getRechargeOrder,
  completeRechargeOrder,
  listRechargeOrders,
  cancelRechargeOrder: vi.fn(),
  requestRechargeRefund: vi.fn(),
}))

vi.mock('../api/auth', () => ({
  fetchMeWithRoleHealing,
}))

vi.mock('./recharge/paymentActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./recharge/paymentActions')>()
  return { ...actual, submitFormPost, goToRedirect }
})

import RechargePage from './RechargePage'

const ORDER_ID = '11111111-1111-4111-8111-111111111111'

function apiError(code: string, message = code, status = 409) {
  return Object.assign(new Error(message), {
    response: { status, data: { error: { code, message } } },
  })
}

function method(paymentMethod: string, extra?: Partial<RechargeConfig['providers'][0]['paymentMethods'][0]>) {
  return {
    paymentMethod,
    actionTypes: [paymentMethod === 'card' ? 'none' : paymentMethod],
    supportsBuyerApprovalCapture: paymentMethod === 'redirect',
    minimumAmountMinor: '100',
    maximumAmountMinor: null,
    ...extra,
  }
}

function configFor(currency: 'CNY' | 'USD', overrides: Partial<RechargeConfig> = {}): RechargeConfig {
  return {
    currency,
    mode: 'sandbox',
    pricePolicyId: 'policy-1',
    pricePolicyCode: `rp-${currency.toLowerCase()}-recharge-v1`,
    minAmountMinor: '100',
    maxAmountMinor: currency === 'CNY' ? '100000' : '50000',
    amountStepMinor: '100',
    dailyLimitMinor: '200000',
    monthlyLimitMinor: '1000000',
    dailyRemainingMinor: '200000',
    monthlyRemainingMinor: '1000000',
    suggestedAmounts: [
      { amountMinor: '1000', sortOrder: 1 },
      { amountMinor: '100000', sortOrder: 2 },
    ],
    providers: [
      {
        provider: 'simulator',
        paymentMethods: [method('card'), method('redirect'), method('form_post')],
      },
      {
        provider: 'paypal',
        paymentMethods: [method('redirect', { supportsBuyerApprovalCapture: true })],
      },
      {
        provider: 'alipay',
        paymentMethods: [method('form_post')],
      },
    ],
    ...overrides,
  }
}

function quote(amountMinor: string, currency: string): RechargeQuote {
  return {
    quoteId: 'quote-1',
    currency,
    amountMinor,
    basePoints: amountMinor,
    bonusPoints: '0',
    totalPoints: amountMinor,
    pricePolicyId: 'policy-1',
    pricePolicyCode: 'rp',
    provider: 'simulator',
    paymentMethod: 'card',
    effectiveMinAmountMinor: '100',
    effectiveMaxAmountMinor: '100000',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
}

function order(status: string, extra: Partial<RechargeOrder> = {}): RechargeOrder {
  return {
    orderId: ORDER_ID,
    status,
    currency: 'CNY',
    amountMinor: '1000',
    basePoints: '1000',
    bonusPoints: '0',
    totalPoints: '1000',
    provider: 'paypal',
    paymentMethod: 'redirect',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    paidAt: status === 'credited' || status === 'paid' ? new Date().toISOString() : null,
    creditedAt: status === 'credited' ? new Date().toISOString() : null,
    cancelledAt: null,
    createdAt: new Date().toISOString(),
    action: { type: 'none' },
    paymentIntent: { id: 'pi', status: 'processing' },
    activeAttempt: { id: 'att', status: 'requires_action', providerPaymentId: 'pp-1' },
    ...extra,
  }
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/recharge" element={<RechargePage />} />
      </Routes>
    </MemoryRouter>,
  )
}

async function readyCheckout() {
  expect(await screen.findByTestId('recharge-checkout')).toBeInTheDocument()
}

describe('RechargePage', () => {
  beforeEach(() => {
    sessionStorage.clear()
    useAuthStore.setState({
      user: {
        id: 1,
        email: 'user@test.local',
        role: 'user',
        status: 'active',
        points: 500,
        merchant: null,
      },
      accessToken: 'token',
      isLoggedIn: true,
    })
    getRechargeConfig.mockImplementation(async (currency: string) => configFor(currency as 'CNY' | 'USD'))
    createRechargeQuote.mockImplementation(async (body: { amountMinor: string; currency: string }) =>
      quote(body.amountMinor, body.currency),
    )
    createRechargeOrder.mockReset()
    getRechargeOrder.mockReset()
    completeRechargeOrder.mockReset()
    listRechargeOrders.mockResolvedValue({ page: 1, pageSize: 50, total: 0, items: [] })
    fetchMeWithRoleHealing.mockResolvedValue({
      id: 1,
      email: 'user@test.local',
      role: 'user',
      status: 'active',
      points: 1500,
      merchant: null,
    })
    submitFormPost.mockReset()
    goToRedirect.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('rejects CNY 0.01 and 0.10, and submits 1.00 when the server min is ¥1.00', async () => {
    const user = userEvent.setup()
    renderAt('/recharge')
    await readyCheckout()
    const input = screen.getByTestId('recharge-amount-custom')

    await user.clear(input)
    await user.type(input, '0.01')
    expect(await screen.findByTestId('recharge-amount-error')).toHaveTextContent('最低金额')
    expect(screen.getByTestId('recharge-pay')).toBeDisabled()

    await user.clear(input)
    await user.type(input, '0.10')
    expect(await screen.findByTestId('recharge-amount-error')).toHaveTextContent('最低金额')
    expect(screen.getByTestId('recharge-pay')).toBeDisabled()

    await user.clear(input)
    await user.type(input, '1.00')
    await waitFor(() => expect(createRechargeQuote).toHaveBeenCalledWith(expect.objectContaining({
      currency: 'CNY',
      amountMinor: '100',
      amountSource: 'custom',
    })))
    await waitFor(() => expect(screen.getByTestId('recharge-pay')).not.toBeDisabled())
  })

  it('applies the same custom-amount rules to USD on a narrow and wide layout', async () => {
    const user = userEvent.setup()
    renderAt('/recharge')
    await readyCheckout()
    await user.click(screen.getByRole('button', { name: 'USD' }))
    const input = screen.getByTestId('recharge-amount-custom')
    expect(input.className).toMatch(/w-full/)
    expect(input.className).toMatch(/min-w-0/)

    await user.type(input, '0.01')
    expect(await screen.findByTestId('recharge-amount-error')).toHaveTextContent('最低金额')
    await user.clear(input)
    await user.type(input, '0.10')
    expect(await screen.findByTestId('recharge-amount-error')).toHaveTextContent('最低金额')
    await user.clear(input)
    await user.type(input, '1.00')
    await waitFor(() => expect(createRechargeQuote).toHaveBeenCalledWith(expect.objectContaining({
      currency: 'USD',
      amountMinor: '100',
    })))
    await waitFor(() => expect(screen.getByTestId('recharge-pay')).not.toBeDisabled())
  })

  it('shows quote loading, expired, and changed states', async () => {
    const user = userEvent.setup()
    let finishQuote: ((value: RechargeQuote) => void) | undefined
    createRechargeQuote.mockImplementation(
      () => new Promise<RechargeQuote>((resolve) => {
        finishQuote = resolve
      }),
    )
    renderAt('/recharge')
    await readyCheckout()
    await user.type(screen.getByTestId('recharge-amount-custom'), '1.00')
    expect(await screen.findByText('正在报价…')).toBeInTheDocument()
    await waitFor(() => expect(createRechargeQuote).toHaveBeenCalled())
    finishQuote?.(quote('100', 'CNY'))
    await waitFor(() => expect(screen.queryByText('正在报价…')).not.toBeInTheDocument())

    createRechargeQuote.mockResolvedValue({
      ...quote('100', 'CNY'),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    await user.clear(screen.getByTestId('recharge-amount-custom'))
    await user.type(screen.getByTestId('recharge-amount-custom'), '10.00')
    expect(await screen.findByTestId('recharge-quote-expired')).toHaveTextContent('报价已过期')

    createRechargeQuote.mockResolvedValue(quote('1000', 'CNY'))
    await user.clear(screen.getByTestId('recharge-amount-custom'))
    await user.type(screen.getByTestId('recharge-amount-custom'), '10.00')
    await waitFor(() => expect(screen.getByTestId('recharge-pay')).not.toBeDisabled())
    createRechargeOrder.mockRejectedValue(apiError('RECHARGE_QUOTE_CHANGED', '报价已变化'))
    await user.click(screen.getByTestId('recharge-pay'))
    expect(await screen.findByTestId('recharge-quote-changed')).toBeInTheDocument()
  })

  it('keeps a redirect return in 确认中 until the local order is credited', async () => {
    getRechargeOrder.mockResolvedValue(order('pending_payment'))
    completeRechargeOrder.mockResolvedValue(order('pending_payment'))
    renderAt(`/recharge?order=${ORDER_ID}&success=1`)
    expect(await screen.findByTestId('recharge-result-status')).toHaveTextContent('确认中')
    expect(screen.queryByText('已到账')).not.toBeInTheDocument()
    await waitFor(() => expect(completeRechargeOrder).toHaveBeenCalled())

    getRechargeOrder.mockResolvedValue(order('credited'))
    await waitFor(() => expect(screen.getByTestId('recharge-result-status')).toHaveTextContent('已到账'), { timeout: 4000 })
    await waitFor(() => expect(fetchMeWithRoleHealing).toHaveBeenCalled())
  })

  it('calls complete after PayPal approval return but does not treat the URL as payment evidence', async () => {
    getRechargeOrder.mockResolvedValue(order('pending_payment', { provider: 'paypal', paymentMethod: 'redirect' }))
    completeRechargeOrder.mockResolvedValue(order('pending_payment', { provider: 'paypal' }))
    renderAt(`/recharge?order=${ORDER_ID}&success=true&PayerID=PAYER123&token=EC-1`)
    await waitFor(() => expect(completeRechargeOrder).toHaveBeenCalledWith(ORDER_ID, expect.any(String)))
    expect(await screen.findByTestId('recharge-result-status')).toHaveTextContent('确认中')
    expect(screen.queryByText('已到账')).not.toBeInTheDocument()
  })

  it('submits Alipay form_post from structured actionUrl/method/fields', async () => {
    const user = userEvent.setup()
    createRechargeOrder.mockResolvedValue(order('pending_payment', {
      provider: 'alipay',
      paymentMethod: 'form_post',
      action: {
        type: 'form_post',
        actionUrl: 'https://openapi.alipay.com/gateway.do',
        method: 'POST',
        fields: { out_trade_no: 'ord-1', sign: 'abc' },
      },
    }))
    renderAt('/recharge')
    await readyCheckout()
    await user.click(screen.getByRole('button', { name: '支付宝 · 表单支付' }))
    await user.type(screen.getByTestId('recharge-amount-custom'), '10.00')
    await waitFor(() => expect(screen.getByTestId('recharge-pay')).not.toBeDisabled())
    await user.click(screen.getByTestId('recharge-pay'))
    await waitFor(() => expect(submitFormPost).toHaveBeenCalledWith({
      type: 'form_post',
      actionUrl: 'https://openapi.alipay.com/gateway.do',
      method: 'POST',
      fields: { out_trade_no: 'ord-1', sign: 'abc' },
    }))
    expect(goToRedirect).not.toHaveBeenCalled()
  })

  it('renders a disabled recharge state', async () => {
    getRechargeConfig.mockRejectedValue(apiError('RECHARGE_DISABLED', 'disabled', 404))
    renderAt('/recharge')
    expect(await screen.findByTestId('recharge-disabled')).toBeInTheDocument()
  })

  it('renders no-provider, failed, and refund states', async () => {
    getRechargeConfig.mockImplementation(async (currency: string) =>
      configFor(currency as 'CNY' | 'USD', { providers: [] }),
    )
    renderAt('/recharge')
    expect(await screen.findByTestId('recharge-no-provider')).toBeInTheDocument()
    expect(screen.getByTestId('recharge-pay')).toBeDisabled()
    cleanup()

    getRechargeOrder.mockResolvedValue(order('failed'))
    renderAt(`/recharge?order=${ORDER_ID}`)
    expect(await screen.findByTestId('recharge-failed')).toBeInTheDocument()
    expect(screen.getByTestId('recharge-result-status')).toHaveTextContent('失败')
    cleanup()

    getRechargeOrder.mockResolvedValue(order('refund_pending'))
    renderAt(`/recharge?order=${ORDER_ID}`)
    expect(await screen.findByTestId('recharge-refund-pending')).toBeInTheDocument()
    cleanup()

    getRechargeOrder.mockResolvedValue(order('refunded'))
    renderAt(`/recharge?order=${ORDER_ID}`)
    expect(await screen.findByTestId('recharge-refunded')).toBeInTheDocument()
    expect(screen.getByTestId('recharge-result-status')).toHaveTextContent('已退款')
  })

  it('does not clip suggested amount buttons', async () => {
    renderAt('/recharge')
    await readyCheckout()
    const button = screen.getByTestId('recharge-suggested-100000')
    expect(button).toHaveTextContent('¥1,000.00')
    expect(button.className).toMatch(/whitespace-nowrap/)
    expect(button.className).toMatch(/overflow-visible/)
    expect(button.className).not.toMatch(/truncate/)
    expect(button.className).toMatch(/min-w-0/)
  })
})
