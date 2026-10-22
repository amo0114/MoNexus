import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminGuestReviewDialog from './AdminGuestReviewDialog'
import * as adminApi from '../../../api/admin'
import { useAppStore } from '../../../stores/appStore'

vi.mock('../../../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../../../api/admin')>('../../../api/admin')
  return {
    ...actual,
    getAdminGuestEligibility: vi.fn(),
    applyAdminGuestEligibility: vi.fn(),
  }
})

function product(state: adminApi.AdminGuestReview['state'] = 'pending'): adminApi.AdminProductListItem {
  return {
    id: 77,
    name: '公开审核商品',
    type: '礼品卡',
    price: 100,
    stock: 10,
    status: 'active',
    merchantId: 3,
    offers: [],
    visibility: 'public',
    guestReview: { state, publicContentRevision: 2, eligibilityVersion: 1, reasonCode: null },
  }
}

function view(overrides: Partial<adminApi.GuestEligibilityView> = {}): adminApi.GuestEligibilityView {
  return {
    productId: 77,
    publicContentRevision: 2,
    decision: 'pending',
    reviewedRevision: 1,
    version: 1,
    reasonCode: 'content_changed',
    guestVisible: false,
    ...overrides,
  }
}

describe('AdminGuestReviewDialog (SPEC-CATALOG-VIS-001 §4.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [] })
  })

  it('approves with the versions read when the dialog opened', async () => {
    vi.mocked(adminApi.getAdminGuestEligibility).mockResolvedValue(view())
    vi.mocked(adminApi.applyAdminGuestEligibility).mockResolvedValue(view({ decision: 'approved' }))
    const onChanged = vi.fn()
    const onClose = vi.fn()

    render(<AdminGuestReviewDialog product={product()} onClose={onClose} onChanged={onChanged} />)
    fireEvent.click(await screen.findByTestId('admin-guest-review-approve'))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(adminApi.applyAdminGuestEligibility).toHaveBeenCalledWith(77, {
      action: 'approve',
      expectedPublicContentRevision: 2,
      expectedEligibilityVersion: 1,
    })
    expect(onChanged).toHaveBeenCalled()
  })

  it('rejects with the fixed reason code', async () => {
    vi.mocked(adminApi.getAdminGuestEligibility).mockResolvedValue(view())
    vi.mocked(adminApi.applyAdminGuestEligibility).mockResolvedValue(view({ decision: 'denied' }))

    render(<AdminGuestReviewDialog product={product()} onClose={() => {}} onChanged={() => {}} />)
    fireEvent.click(await screen.findByTestId('admin-guest-review-reject'))

    await waitFor(() =>
      expect(adminApi.applyAdminGuestEligibility).toHaveBeenCalledWith(77, {
        action: 'reject',
        expectedPublicContentRevision: 2,
        expectedEligibilityVersion: 1,
        reasonCode: 'rejected',
      }),
    )
  })

  it('offers only revoke for a currently approved product', async () => {
    vi.mocked(adminApi.getAdminGuestEligibility).mockResolvedValue(
      view({ decision: 'approved', reviewedRevision: 2, version: 3, guestVisible: true }),
    )

    render(<AdminGuestReviewDialog product={product('approved')} onClose={() => {}} onChanged={() => {}} />)

    expect(await screen.findByTestId('admin-guest-review-revoke')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-guest-review-approve')).not.toBeInTheDocument()
    expect(screen.queryByTestId('admin-guest-review-reject')).not.toBeInTheDocument()
  })

  it('on 409 shows the conflict, reloads versions and retries with the new ones', async () => {
    vi.mocked(adminApi.getAdminGuestEligibility)
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view({ publicContentRevision: 3, version: 2 }))
    vi.mocked(adminApi.applyAdminGuestEligibility)
      .mockRejectedValueOnce({
        response: { status: 409, data: { error: { code: 'PRODUCT_CONTENT_CHANGED', message: '商品公开内容已更新，请刷新后重新审核' } } },
      })
      .mockResolvedValueOnce(view({ decision: 'approved' }))
    const onChanged = vi.fn()
    const onClose = vi.fn()

    render(<AdminGuestReviewDialog product={product()} onClose={onClose} onChanged={onChanged} />)
    fireEvent.click(await screen.findByTestId('admin-guest-review-approve'))

    expect(await screen.findByTestId('admin-guest-review-conflict')).toHaveTextContent('商品公开内容已更新')
    expect(onClose).not.toHaveBeenCalled()
    expect(onChanged).toHaveBeenCalledTimes(1)
    await screen.findByText(/内容版本 v3/)

    fireEvent.click(screen.getByTestId('admin-guest-review-approve'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(adminApi.applyAdminGuestEligibility).toHaveBeenLastCalledWith(77, {
      action: 'approve',
      expectedPublicContentRevision: 3,
      expectedEligibilityVersion: 2,
    })
  })

  it('does not offer approval for a members_only product', async () => {
    vi.mocked(adminApi.getAdminGuestEligibility).mockResolvedValue(view({ decision: null, version: 0 }))

    render(<AdminGuestReviewDialog product={product('members_only')} onClose={() => {}} onChanged={() => {}} />)

    expect(await screen.findByText(/先将商品改为游客可浏览/)).toBeInTheDocument()
    await waitFor(() => expect(adminApi.getAdminGuestEligibility).toHaveBeenCalled())
    expect(screen.queryByTestId('admin-guest-review-approve')).not.toBeInTheDocument()
    expect(screen.queryByTestId('admin-guest-review-reject')).not.toBeInTheDocument()
  })
})
