// Component tests for PromotionPackagePicker (T-MERCH-FE-002).
// Covers AC-MERCH-009 (server snapshot only, no price/duration override),
// the no-guarantee disclosure, double-submit guard, idempotency-key retention
// across retryable failures vs regeneration on conflicts, error/empty states,
// and keyboard/a11y.

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'vitest-axe'
import { describe, expect, it, vi } from 'vitest'
import type { PromotionCampaignDTO, PromotionCreatePayload } from '../../types/merchandising'
import PromotionPackagePicker from './PromotionPackagePicker'
import { activePackagesFixture, campaignFixture } from './promotionFixtures'
import { PROMOTION_NO_GUARANTEE } from './promotionCopy'

const products = [
  { id: 42, name: '测试商品' },
  { id: 43, name: '另一商品' },
]

const FORBIDDEN_WORDS = ['平台认证', '官方认证', '平台担保', '质量保证'] as const

function pendingCampaign(): PromotionCampaignDTO {
  return campaignFixture('pending_review', { id: 9001 })
}

/** An onRequest stub with a controllable promise. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeAxiosError(status: number, code?: string) {
  return { response: { status, data: { error: code ? { code } : undefined } } }
}

/** Axios-style network failure: NO response object (httpStatus → null). */
function networkError() {
  return { message: 'Network Error' }
}

describe('PromotionPackagePicker', () => {
  it('renders the no-guarantee disclosure and package price/duration/placement', () => {
    render(
      <PromotionPackagePicker
        packages={activePackagesFixture()}
        products={products}
        onRequest={vi.fn()}
      />,
    )
    expect(screen.getByText(PROMOTION_NO_GUARANTEE)).toBeInTheDocument()
    expect(screen.getByText('首页推广 7 天')).toBeInTheDocument()
    expect(screen.getByText('首页推广位 · 7 天')).toBeInTheDocument()
    expect(screen.getByText('100 积分')).toBeInTheDocument()
    expect(screen.getByText('分类推广 14 天')).toBeInTheDocument()
    expect(screen.getByText('分类推广位 · 14 天')).toBeInTheDocument()
    expect(screen.getByText('180 积分')).toBeInTheDocument()
  })

  it('does not offer inactive packages', () => {
    render(
      <PromotionPackagePicker
        packages={activePackagesFixture()}
        products={products}
        onRequest={vi.fn()}
      />,
    )
    expect(screen.queryByText('已下架套餐')).not.toBeInTheDocument()
    expect(screen.queryByText('999 积分')).not.toBeInTheDocument()
  })

  it('renders a recoverable empty state when no active package exists', () => {
    render(
      <PromotionPackagePicker packages={[]} products={products} onRequest={vi.fn()} />,
    )
    expect(screen.getByText('暂无可购买的推广套餐，请稍后再试。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '提交申请' })).toBeDisabled()
  })

  it('requires product + package before submit', async () => {
    const user = userEvent.setup()
    const onRequest = vi.fn()
    render(<PromotionPackagePicker packages={activePackagesFixture()} products={products} onRequest={onRequest} />)
    const submit = screen.getByRole('button', { name: '提交申请' })
    expect(submit).toBeDisabled()

    // Select package only → still disabled.
    await user.click(screen.getByRole('radio', { name: /首页推广 7 天/ }))
    expect(screen.getByRole('button', { name: '提交申请' })).toBeDisabled()

    // Select product only → disabled.
    await user.selectOptions(screen.getByLabelText('选择商品'), '43')
    expect(screen.getByRole('button', { name: '提交申请' })).toBeEnabled()
  })

  it('submits ONLY the contract fields and an Idempotency-Key', async () => {
    const user = userEvent.setup()
    const onRequest = vi.fn().mockResolvedValue(pendingCampaign())
    render(
      <PromotionPackagePicker
        packages={activePackagesFixture()}
        products={products}
        onRequest={onRequest}
        keyGenerator={() => 'fixed-key-1'}
      />,
    )
    await user.click(screen.getByRole('radio', { name: /首页推广 7 天/ }))
    await user.selectOptions(screen.getByLabelText('选择商品'), '42')
    await user.click(screen.getByRole('button', { name: '提交申请' }))

    await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(1))
    const [payload, key] = onRequest.mock.calls[0] as [PromotionCreatePayload, string]
    expect(key).toBe('fixed-key-1')
    // Exactly the three server-contract fields — no price/duration/placement
    // overrides (MERCH-007 / AC-MERCH-009).
    expect(Object.keys(payload).sort()).toEqual(['packageId', 'productId', 'requestedStartAt'])
    expect(payload).toEqual({ productId: 42, packageId: 7, requestedStartAt: null })
    expect(await screen.findByRole('status')).toHaveTextContent('申请已提交')
  })

  it('sends requestedStartAt as UTC ISO when specified, null when 尽快开始', async () => {
    const user = userEvent.setup()
    const onRequest = vi.fn().mockResolvedValue(pendingCampaign())
    render(
      <PromotionPackagePicker
        packages={activePackagesFixture()}
        products={products}
        onRequest={onRequest}
        keyGenerator={() => 'key-1'}
      />,
    )
    await user.click(screen.getByRole('radio', { name: /首页推广 7 天/ }))
    await user.selectOptions(screen.getByLabelText('选择商品'), '42')

    await user.click(screen.getByRole('checkbox'))
    const startInput = screen.getByLabelText('指定开始时间')
    await user.type(startInput, '2026-08-15T10:00')
    await user.click(screen.getByRole('button', { name: '提交申请' }))
    await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(1))
    const payload = onRequest.mock.calls[0][0] as PromotionCreatePayload
    expect(payload.requestedStartAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('keeps the SAME idempotency key across a retryable network failure', async () => {
    const user = userEvent.setup()
    const onRequest = vi.fn()
    let call = 0
    onRequest.mockImplementation(() => {
      call += 1
      if (call === 1) return Promise.reject(networkError())
      return Promise.resolve(pendingCampaign())
    })
    render(
      <PromotionPackagePicker
        packages={activePackagesFixture()}
        products={products}
        onRequest={onRequest}
        keyGenerator={() => 'same-key'}
      />,
    )
    await user.click(screen.getByRole('radio', { name: /首页推广 7 天/ }))
    await user.selectOptions(screen.getByLabelText('选择商品'), '42')

    await user.click(screen.getByRole('button', { name: '提交申请' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('网络异常')

    // Same payload, no field change → retry must reuse the same key.
    await user.click(screen.getByRole('button', { name: '提交申请' }))
    await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(2))
    expect(onRequest.mock.calls[0][1]).toBe('same-key')
    expect(onRequest.mock.calls[1][1]).toBe('same-key')
  })

  it('regenerates the key after a non-retryable 409 conflict', async () => {
    const user = userEvent.setup()
    const onRequest = vi.fn()
    let generated = 0
    onRequest.mockImplementation(() => Promise.reject(makeAxiosError(409, 'IDEMPOTENCY_KEY_REUSED')))
    render(
      <PromotionPackagePicker
        packages={activePackagesFixture()}
        products={products}
        onRequest={onRequest}
        keyGenerator={() => `gen-${++generated}`}
      />,
    )
    await user.click(screen.getByRole('radio', { name: /首页推广 7 天/ }))
    await user.selectOptions(screen.getByLabelText('选择商品'), '42')

    await user.click(screen.getByRole('button', { name: '提交申请' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('不同的申请内容')

    await user.click(screen.getByRole('button', { name: '提交申请' }))
    await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(2))
    expect(onRequest.mock.calls[0][1]).toBe('gen-1')
    expect(onRequest.mock.calls[1][1]).toBe('gen-2')
    expect(generated).toBe(2)
  })

  it('shows a stable actionable message for insufficient balance and is retryable', async () => {
    const user = userEvent.setup()
    const onRequest = vi.fn()
    let call = 0
    onRequest.mockImplementation(() => {
      call += 1
      if (call === 1) return Promise.reject(makeAxiosError(402))
      return Promise.resolve(pendingCampaign())
    })
    render(
      <PromotionPackagePicker
        packages={activePackagesFixture()}
        products={products}
        onRequest={onRequest}
        keyGenerator={() => 'k-balance'}
      />,
    )
    await user.click(screen.getByRole('radio', { name: /首页推广 7 天/ }))
    await user.selectOptions(screen.getByLabelText('选择商品'), '42')
    await user.click(screen.getByRole('button', { name: '提交申请' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('积分余额不足')
    // retryable → same key reused
    await user.click(screen.getByRole('button', { name: '提交申请' }))
    await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(2))
    expect(onRequest.mock.calls[1][1]).toBe('k-balance')
  })

  it('guards double submission while a request is in flight', async () => {
    const user = userEvent.setup()
    const d = deferred<PromotionCampaignDTO>()
    const onRequest = vi.fn().mockReturnValue(d.promise)
    render(
      <PromotionPackagePicker
        packages={activePackagesFixture()}
        products={products}
        onRequest={onRequest}
        keyGenerator={() => 'k-double'}
      />,
    )
    await user.click(screen.getByRole('radio', { name: /首页推广 7 天/ }))
    await user.selectOptions(screen.getByLabelText('选择商品'), '42')
    await user.click(screen.getByRole('button', { name: '提交申请' }))

    // While in flight the button is disabled and labelled 提交中….
    const submit = await screen.findByRole('button', { name: '提交中…' })
    expect(submit).toBeDisabled()
    await user.click(submit).catch(() => undefined)

    d.resolve(pendingCampaign())
    await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('button', { name: '提交申请' })).toBeEnabled()
  })

  it('is accessible with no axe violations', async () => {
    const { container } = render(
      <PromotionPackagePicker
        packages={activePackagesFixture()}
        products={products}
        onRequest={vi.fn()}
      />,
    )
    expect(await axe(container, { rules: { 'color-contrast': { enabled: false } } })).toHaveNoViolations()
  })

  it('contains no certification/guarantee forbidden words', () => {
    render(
      <PromotionPackagePicker
        packages={activePackagesFixture()}
        products={products}
        onRequest={vi.fn()}
      />,
    )
    const text = document.body.textContent ?? ''
    for (const word of FORBIDDEN_WORDS) {
      expect(text).not.toContain(word)
    }
  })

  it('shows the selected package summary (套餐/展位/时长/价格)', async () => {
    const user = userEvent.setup()
    render(
      <PromotionPackagePicker
        packages={activePackagesFixture()}
        products={products}
        onRequest={vi.fn()}
      />,
    )
    expect(screen.queryByRole('group', { name: '套餐摘要' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: /分类推广 14 天/ }))
    const summary = screen.getByRole('group', { name: '套餐摘要' })
    expect(summary).toHaveTextContent('分类推广 14 天')
    expect(summary).toHaveTextContent('分类推广位')
    expect(summary).toHaveTextContent('14 天')
    expect(summary).toHaveTextContent('180 积分')
  })
})
