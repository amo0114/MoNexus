// Component tests for MerchantCampaignPanel (T-MERCH-FE-002).
// Covers AC-MERCH-011/013–015: every frozen status renders with label/meta/
// timeline, unknown statuses fail closed (non-operable, neutral timeline),
// cancel/retry two-step confirms, filter + pagination callbacks, recoverable
// loading/empty/error states, and a11y.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'vitest-axe'
import { describe, expect, it, vi } from 'vitest'
import type { PromotionCampaignDTO } from '../../types/merchandising'
import MerchantCampaignPanel from './MerchantCampaignPanel'
import {
  CAMPAIGN_STATUS_LABEL,
  CAMPAIGN_STATUS_ORDER,
  PLACEMENT_LABEL,
} from './promotionCopy'
import {
  campaignFixture,
  campaignStatusFixtures,
  unknownStatusCampaignFixture,
} from './promotionFixtures'

function renderPanel(overrides: Partial<Parameters<typeof MerchantCampaignPanel>[0]> = {}) {
  const props = {
    campaigns: [] as PromotionCampaignDTO[],
    total: 0,
    page: 1,
    pageSize: 10,
    statusFilter: 'all' as const,
    loading: false,
    loadError: null as string | null,
    actionError: null as string | null,
    actionBusyId: null as number | null,
    onFilterChange: vi.fn(),
    onPageChange: vi.fn(),
    onRetryLoad: vi.fn(),
    onCancel: vi.fn(),
    onRetryPayment: vi.fn(),
    onDismissActionError: vi.fn(),
    ...overrides,
  }
  const view = render(<MerchantCampaignPanel {...props} />)
  return { ...view, props }
}

describe('MerchantCampaignPanel', () => {
  it('renders every frozen status with its label, meta and timeline', () => {
    const fixtures = campaignStatusFixtures()
    const campaigns = CAMPAIGN_STATUS_ORDER.map((s, i) => ({
      ...fixtures[s],
      id: 1000 + i,
      productName: `商品-${s}`,
    }))
    const { container } = renderPanel({ campaigns })
    const cards = Array.from(container.querySelectorAll('.merch-campaign-card')) as HTMLElement[]

    expect(cards).toHaveLength(8)
    for (const status of CAMPAIGN_STATUS_ORDER) {
      const card = cards.find(
        (c) => c.querySelector('.merch-status-badge')?.textContent === CAMPAIGN_STATUS_LABEL[status],
      )
      expect(card, `no card rendered for ${status}`).toBeDefined()
      const scope = within(card as HTMLElement)
      expect(scope.getByText(`商品-${status}`)).toBeInTheDocument()
      expect(scope.getByText(`${fixtures[status].durationDays} 天`)).toBeInTheDocument()
      expect(scope.getByText(`${fixtures[status].pricePoints} 积分`)).toBeInTheDocument()
      expect(scope.getByText(PLACEMENT_LABEL[fixtures[status].placement])).toBeInTheDocument()
      expect(scope.getByLabelText('推广进度')).toBeInTheDocument()
    }
  })

  it('fails closed for an unknown status: non-operable, neutral timeline, no invented semantics', () => {
    const unknown = unknownStatusCampaignFixture()
    const { container } = renderPanel({ campaigns: [unknown] })
    const card = container.querySelector('.merch-campaign-card') as HTMLElement
    expect(card).not.toBeNull()

    const scope = within(card)
    expect(scope.getByText('未知状态')).toBeInTheDocument()
    expect(scope.getByText('未知状态，暂不可操作。')).toBeInTheDocument()
    expect(scope.queryByRole('button', { name: '取消申请' })).not.toBeInTheDocument()
    expect(scope.queryByRole('button', { name: '重试支付' })).not.toBeInTheDocument()
    expect(scope.queryByText('审核通过')).not.toBeInTheDocument()
    expect(scope.getByLabelText('推广进度')).toHaveTextContent('状态未知')
  })

  it('fails closed for an unknown placement instead of rendering an empty label', () => {
    const campaign = campaignFixture('active', {
      placement: 'future_unknown_placement' as PromotionCampaignDTO['placement'],
    })
    const { container } = renderPanel({ campaigns: [campaign] })
    expect(within(container).getByText('未知推广位')).toBeInTheDocument()
  })

  it('offers cancel only for pending_review via a two-step confirm', async () => {
    const user = userEvent.setup()
    const pending = campaignFixture('pending_review', { id: 9001 })
    const onCancel = vi.fn()
    renderPanel({ campaigns: [pending], onCancel })

    await user.click(screen.getByRole('button', { name: '取消申请' }))
    expect(screen.getByText('确认取消申请？取消不会扣积分。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '确认取消' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledWith(pending)
  })

  it('offers retry payment only for payment_failed via a two-step confirm', async () => {
    const user = userEvent.setup()
    const failed = campaignFixture('payment_failed', { id: 9002 })
    const onRetryPayment = vi.fn()
    renderPanel({ campaigns: [failed], onRetryPayment })

    await user.click(screen.getByRole('button', { name: '重试支付' }))
    expect(screen.getByText('确认重试支付？将按已批准的 100 积分扣款。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '确认重试' }))
    expect(onRetryPayment).toHaveBeenCalledTimes(1)
    expect(onRetryPayment).toHaveBeenCalledWith(failed)
  })

  it('does not offer cancel/retry for non-actionable statuses', () => {
    const active = campaignFixture('active', { id: 9003 })
    renderPanel({ campaigns: [active] })
    expect(screen.queryByRole('button', { name: '取消申请' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试支付' })).not.toBeInTheDocument()
  })

  it('filter chips call onFilterChange with the frozen status and expose pressed state', async () => {
    const user = userEvent.setup()
    const onFilterChange = vi.fn()
    const firstView = renderPanel({ onFilterChange, statusFilter: 'all' })

    expect(screen.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '待审核' })).toHaveAttribute('aria-pressed', 'false')

    await user.click(screen.getByRole('button', { name: '待审核' }))
    expect(onFilterChange).toHaveBeenCalledWith('pending_review')

    firstView.unmount()
    const { props } = renderPanel({ statusFilter: 'active' })
    expect(props.onFilterChange).toBeDefined()
    expect(screen.getByRole('button', { name: '展示中' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('pagination calls onPageChange and disables at the bounds', async () => {
    const user = userEvent.setup()
    const onPageChange = vi.fn()
    const firstView = renderPanel({
      campaigns: [campaignFixture('active', { id: 9004 })],
      total: 25,
      page: 2,
      pageSize: 10,
      onPageChange,
    })

    await user.click(screen.getByRole('button', { name: '上一页' }))
    expect(onPageChange).toHaveBeenCalledWith(1)
    await user.click(screen.getByRole('button', { name: '下一页' }))
    expect(onPageChange).toHaveBeenCalledWith(3)

    firstView.unmount()
    const onPageChange2 = vi.fn()
    renderPanel({ total: 25, page: 1, pageSize: 10, onPageChange: onPageChange2 })
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled()
  })

  it('renders recoverable loading, empty and error states', async () => {
    const user = userEvent.setup()

    const loading = renderPanel({ loading: true })
    expect(loading.getByText('加载中…')).toBeInTheDocument()
    loading.unmount()

    const empty = renderPanel({ campaigns: [], total: 0 })
    expect(empty.getByText('没有符合条件的推广申请。')).toBeInTheDocument()
    empty.unmount()

    const onRetryLoad = vi.fn()
    const error = renderPanel({ loadError: '网络异常，请检查网络后重试。', onRetryLoad })
    expect(error.getByText('网络异常，请检查网络后重试。')).toBeInTheDocument()
    await user.click(error.getByRole('button', { name: '重新加载' }))
    expect(onRetryLoad).toHaveBeenCalledTimes(1)
    error.unmount()
  })

  it('is accessible with no axe violations', async () => {
    const fixtures = campaignStatusFixtures()
    const campaigns = CAMPAIGN_STATUS_ORDER.map((s, i) => ({ ...fixtures[s], id: 2000 + i }))
    const { container } = renderPanel({ campaigns })
    expect(await axe(container, { rules: { 'color-contrast': { enabled: false } } })).toHaveNoViolations()
  })
})
