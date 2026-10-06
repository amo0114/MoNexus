// R09a — CampaignDetailDialog unit card. Pins the extracted read-only detail
// contract independently of the page: the open/close ownership (page holds the
// target), the full snapshot/timeline/audit DOM surface, the null-rendered
// placeholders, and the safe date formatter behaviour that must stay identical
// to the page table's rendering.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AdminPromotionCampaignDTO } from '../../../types/merchandising'
import CampaignDetailDialog, {
  type CampaignDetailDialogProps,
} from './CampaignDetailDialog'

const campaign: AdminPromotionCampaignDTO = {
  id: 502,
  merchantId: 9002,
  productId: 7002,
  packageId: 62,
  packageCodeSnapshot: 'PKG-CATEGORY-TOP-30',
  placementSnapshot: 'category_sponsored',
  durationDaysSnapshot: 30,
  pricePointsSnapshot: 1200,
  status: 'active',
  requestedStartAt: '2026-03-01T00:00:00.000Z',
  startsAt: '2026-03-02T00:00:00.000Z',
  endsAt: '2026-04-01T00:00:00.000Z',
  reviewedByUserId: 4242,
  reviewedAt: '2026-02-28T10:00:00.000Z',
  reviewReason: '符合上架规范',
  cancelledByUserId: 4343,
  cancellationReason: '商家申请撤下',
  chargedPoints: 1200,
  refundedPoints: 300,
  createdAt: '2026-02-10T09:00:00.000Z',
  updatedAt: '2026-02-11T09:00:00.000Z',
}

function renderDetail(overrides: Partial<CampaignDetailDialogProps> = {}) {
  const props: CampaignDetailDialogProps = {
    campaign: null,
    onOpenChange: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  const view = render(<CampaignDetailDialog {...props} />)
  return { props, view }
}

describe('CampaignDetailDialog', () => {
  it('renders nothing while the target is null', () => {
    renderDetail()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders the full snapshot, timeline and audit trail for the target', () => {
    renderDetail({ campaign })
    const dialog = screen.getByRole('dialog', { name: '推广活动详情' })
    expect(dialog).toBeInTheDocument()
    expect(
      screen.getByText('活动 #502 完整快照、时间线与审核信息'),
    ).toBeInTheDocument()

    // snapshot block
    expect(screen.getByText('#502')).toBeInTheDocument()
    expect(screen.getByText('展示中')).toBeInTheDocument()
    expect(screen.getByText('9002')).toBeInTheDocument()
    expect(screen.getByText('7002')).toBeInTheDocument()
    expect(screen.getByText('PKG-CATEGORY-TOP-30 (ID 62)')).toBeInTheDocument()
    expect(screen.getByText('分类推广位')).toBeInTheDocument()
    expect(screen.getByText('30 天')).toBeInTheDocument()
    // 快照价格 and 已扣积分 both carry 1200 积分
    expect(screen.getAllByText('1200 积分')).toHaveLength(2)
    expect(screen.getByText('300 积分')).toBeInTheDocument()

    // audit trail (R8 traceability)
    expect(screen.getByText('4242')).toBeInTheDocument()
    expect(screen.getByText('4343')).toBeInTheDocument()
    expect(screen.getByText('符合上架规范')).toBeInTheDocument()
    expect(screen.getByText('商家申请撤下')).toBeInTheDocument()

    // createdAt / updatedAt keep their machine-readable dateTime
    expect(
      dialog.querySelector('time[datetime="2026-02-10T09:00:00.000Z"]'),
    ).not.toBeNull()
    expect(
      dialog.querySelector('time[datetime="2026-02-11T09:00:00.000Z"]'),
    ).not.toBeNull()
  })

  it('renders — for every absent nullable field', () => {
    renderDetail({
      campaign: {
        ...campaign,
        requestedStartAt: null,
        startsAt: null,
        endsAt: null,
        reviewedByUserId: null,
        reviewedAt: null,
        reviewReason: null,
        cancelledByUserId: null,
        cancellationReason: null,
      },
    })
    // 审核人 ID / 审核时间 / 审核意见 / 取消人 ID / 取消原因 + 申请开始/实际开始/实际结束
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(8)
  })

  it('shows an unparseable timestamp verbatim instead of Invalid Date', () => {
    renderDetail({ campaign: { ...campaign, startsAt: 'not-a-date' } })
    expect(screen.getByText('not-a-date')).toBeInTheDocument()
    expect(screen.queryByText('Invalid Date')).toBeNull()
  })

  it('falls back to the raw status / placement value when unmapped', () => {
    renderDetail({
      campaign: {
        ...campaign,
        // deliberate out-of-enum values: the detail must never blank them out
        status: 'legacy_status' as AdminPromotionCampaignDTO['status'],
        placementSnapshot:
          'legacy_placement' as AdminPromotionCampaignDTO['placementSnapshot'],
      },
    })
    expect(screen.getByText('legacy_status')).toBeInTheDocument()
    expect(screen.getByText('legacy_placement')).toBeInTheDocument()
  })

  it('关闭 asks the page to clear the target and never closes itself', () => {
    const { props } = renderDetail({ campaign })
    // The shared DialogContent also ships an aria-label="关闭" X button, so the
    // footer action is selected by its own class.
    const closeButton = document.querySelector(
      'button.btn-secondary',
    ) as HTMLButtonElement
    expect(closeButton).not.toBeNull()
    expect(closeButton).toHaveTextContent('关闭')
    fireEvent.click(closeButton)
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onOpenChange).not.toHaveBeenCalled()
  })

  it('moves focus into the dialog content on open (modal focus behaviour)', () => {
    renderDetail({ campaign })
    const dialog = screen.getByRole('dialog', { name: '推广活动详情' })
    expect(dialog.contains(document.activeElement)).toBe(true)
  })
})
