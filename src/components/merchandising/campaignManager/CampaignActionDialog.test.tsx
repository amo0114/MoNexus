// R09a — CampaignActionDialog unit card. Covers the extracted confirm Dialog
// contract independently of the page: per-action field visibility, exact copy
// inheritance, role=alert slots, busy disablement, and the controlled
// callbacks the page wires to its dispatch / idempotency / double-submit guard.
//
// The page-level card (AdminPromotionCampaignManager.test.tsx) still covers the
// end-to-end mutation behaviour (adapter calls, keys, refresh); this card pins
// the component boundary so a future edit cannot silently drop a field, an id,
// an ARIA role or the reason length cap.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AdminPromotionCampaignDTO } from '../../../types/merchandising'
import CampaignActionDialog, {
  type CampaignActionDialogProps,
} from './CampaignActionDialog'
import { MAX_REASON_LENGTH } from './types'

const baseCampaign: AdminPromotionCampaignDTO = {
  id: 501,
  merchantId: 9001,
  productId: 7001,
  packageId: 61,
  packageCodeSnapshot: 'PKG-STORE-HOME-30',
  placementSnapshot: 'store_home_sponsored',
  durationDaysSnapshot: 30,
  pricePointsSnapshot: 1200,
  status: 'pending_review',
  requestedStartAt: '2026-03-01T00:00:00.000Z',
  startsAt: null,
  endsAt: null,
  reviewedByUserId: null,
  reviewedAt: null,
  reviewReason: null,
  cancelledByUserId: null,
  cancellationReason: null,
  chargedPoints: 600,
  refundedPoints: 0,
  createdAt: '2026-02-10T09:00:00.000Z',
  updatedAt: '2026-02-11T09:00:00.000Z',
}

function renderDialog(overrides: Partial<CampaignActionDialogProps> = {}) {
  const props: CampaignActionDialogProps = {
    dialog: null,
    reason: '',
    points: '0',
    fieldError: null,
    submitError: null,
    busy: false,
    onOpenChange: vi.fn(),
    onReasonChange: vi.fn(),
    onPointsChange: vi.fn(),
    onCancel: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  }
  const view = render(<CampaignActionDialog {...props} />)
  return { props, view }
}

describe('CampaignActionDialog', () => {
  it('renders no dialog while the target is null', () => {
    renderDialog()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('approve: confirm-only title/description with no reason and no points input', () => {
    renderDialog({
      dialog: { action: { kind: 'approve' }, campaign: baseCampaign },
    })
    const dialog = screen.getByRole('dialog', { name: '批准推广活动' })
    expect(
      screen.getByText('确认批准活动 501 的推广申请？批准后将按套餐价格扣款。'),
    ).toBeInTheDocument()
    expect(document.getElementById('admin-campaign-action-reason')).toBeNull()
    expect(document.getElementById('admin-campaign-action-points')).toBeNull()
    expect(screen.getByRole('button', { name: '确认' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    expect(dialog).toBeInTheDocument()
  })

  it('reject: reason textarea keeps its id, rows, cap and exact placeholder', () => {
    renderDialog({
      dialog: { action: { kind: 'reject' }, campaign: baseCampaign },
    })
    const textarea = document.getElementById(
      'admin-campaign-action-reason',
    ) as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    expect(textarea.tagName).toBe('TEXTAREA')
    expect(textarea.rows).toBe(3)
    expect(textarea.maxLength).toBe(MAX_REASON_LENGTH)
    expect(textarea.placeholder).toBe('请输入拒绝原因（不超过 500 字）')
    // the label target association is preserved
    expect(screen.getByLabelText('原因')).toBe(textarea)
    expect(document.getElementById('admin-campaign-action-points')).toBeNull()
  })

  it('cancel on scheduled: optional reason only, never the points input', () => {
    renderDialog({
      dialog: {
        action: { kind: 'cancel' },
        campaign: { ...baseCampaign, status: 'scheduled' },
      },
    })
    expect(screen.getByLabelText('取消原因（可选）')).toBeInTheDocument()
    expect(document.getElementById('admin-campaign-action-points')).toBeNull()
    expect(
      screen.getByText('确认取消活动 501？取消将全额自动退回已扣积分。'),
    ).toBeInTheDocument()
  })

  it('cancel on active: reason + points with the exact charged-points hint', () => {
    renderDialog({
      dialog: {
        action: { kind: 'cancel' },
        campaign: { ...baseCampaign, status: 'active' },
      },
    })
    const points = document.getElementById(
      'admin-campaign-action-points',
    ) as HTMLInputElement
    expect(points).not.toBeNull()
    expect(points.type).toBe('text')
    expect(points.inputMode).toBe('numeric')
    expect(points.placeholder).toBe('0')
    expect(screen.getByLabelText('退款积分')).toBe(points)
    expect(
      screen.getByText('已扣积分 600，退款积分必须在 0 到 600 之间。'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        '确认取消活动 501 的推广？取消将按下方退款积分进行一次退款调整，不可再次调整。',
      ),
    ).toBeInTheDocument()
  })

  it('refund-adjustment: reason + points and the one-time copy', () => {
    renderDialog({
      dialog: {
        action: { kind: 'refund-adjustment' },
        campaign: { ...baseCampaign, status: 'active' },
      },
    })
    expect(screen.getByLabelText('原因')).toBeInTheDocument()
    expect(screen.getByLabelText('退款积分')).toBeInTheDocument()
    expect(
      screen.getByText('为活动 501 设置一次性退款调整决定，提交后不可修改。'),
    ).toBeInTheDocument()
  })

  it('pause / resume keep their exact confirm copy', () => {
    const { view } = renderDialog({
      dialog: { action: { kind: 'pause' }, campaign: baseCampaign },
    })
    expect(
      screen.getByText(
        '确认暂停活动 501 的推广？暂停期间仍占用该展位，暂停时间不顺延。',
      ),
    ).toBeInTheDocument()
    view.unmount()

    renderDialog({
      dialog: { action: { kind: 'resume' }, campaign: baseCampaign },
    })
    expect(screen.getByText('确认恢复活动 501 的推广？')).toBeInTheDocument()
  })

  it('renders both error slots as role=alert in field-then-submit order', () => {
    renderDialog({
      dialog: { action: { kind: 'reject' }, campaign: baseCampaign },
      fieldError: '请输入拒绝原因',
      submitError: '拒绝失败，请稍后重试。',
    })
    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(2)
    expect(alerts[0]).toHaveTextContent('请输入拒绝原因')
    expect(alerts[1]).toHaveTextContent('拒绝失败，请稍后重试。')
  })

  it('busy disables every control and swaps 确认 for a spinner', () => {
    renderDialog({
      dialog: { action: { kind: 'cancel' }, campaign: { ...baseCampaign, status: 'active' } },
      busy: true,
    })
    // While busy the primary button renders the spinner instead of the 确认
    // label, so it is selected by its own class rather than by accessible name.
    const confirmButton = document.querySelector(
      'button.btn-primary',
    ) as HTMLButtonElement
    expect(confirmButton).not.toBeNull()
    expect(confirmButton.querySelector('svg.animate-spin')).not.toBeNull()
    expect(confirmButton).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    expect(screen.getByLabelText('取消原因（可选）')).toBeDisabled()
    expect(screen.getByLabelText('退款积分')).toBeDisabled()
  })

  it('forwards reason / points edits so the page keeps the single source of truth', () => {
    const { props } = renderDialog({
      dialog: {
        action: { kind: 'refund-adjustment' },
        campaign: { ...baseCampaign, status: 'active' },
      },
    })
    fireEvent.change(screen.getByLabelText('原因'), {
      target: { value: '用户申诉' },
    })
    expect(props.onReasonChange).toHaveBeenCalledWith('用户申诉')
    fireEvent.change(screen.getByLabelText('退款积分'), {
      target: { value: '300' },
    })
    expect(props.onPointsChange).toHaveBeenCalledWith('300')
  })

  it('wires 取消 / 确认 to the page callbacks and never closes on its own', () => {
    const { props } = renderDialog({
      dialog: { action: { kind: 'approve' }, campaign: baseCampaign },
    })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(props.onCancel).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(props.onSubmit).toHaveBeenCalledTimes(1)
    // closing is the page's decision: neither button may flip open state itself
    expect(props.onOpenChange).not.toHaveBeenCalled()
  })

  it('moves focus into the dialog content on open (modal focus behaviour)', () => {
    renderDialog({
      dialog: { action: { kind: 'approve' }, campaign: baseCampaign },
    })
    const dialog = screen.getByRole('dialog', { name: '批准推广活动' })
    expect(dialog.contains(document.activeElement)).toBe(true)
  })
})
