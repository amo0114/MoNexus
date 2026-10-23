import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminGuestReviewDialog from './AdminGuestReviewDialog'
import * as adminApi from '../../../api/admin'
import { useAppStore } from '../../../stores/appStore'
import { previewProductVideo } from '../../../api/productVideos'

vi.mock('../../../api/productVideos', () => ({ previewProductVideo: vi.fn(), getProductVideoPlayback: vi.fn() }))

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
    promoVideo: null,
    ...overrides,
  }
}

describe('AdminGuestReviewDialog (SPEC-CATALOG-VIS-001 §4.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
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

  it('previews the video bound to the reviewed revision, releases it on conflict and reloads the new asset', async () => {
    const video = { moderation: 'approved', assetId: 'video-a', durationMs: 1000, width: 320, height: 240, hasAudio: true }
    vi.mocked(adminApi.getAdminGuestEligibility)
      .mockResolvedValueOnce(view({ promoVideo: video }))
      .mockResolvedValueOnce(view({ publicContentRevision: 3, version: 2, promoVideo: { ...video, assetId: 'video-b' } }))
    vi.mocked(previewProductVideo).mockResolvedValue({
      videoAssetId: 'video-a', playbackUrl: '/private-video-a', posterUrl: '/private-poster-a', expiresAt: new Date(Date.now() + 180_000).toISOString(),
    })
    vi.mocked(adminApi.applyAdminGuestEligibility).mockRejectedValueOnce({ response: { status: 409 } })
    render(<AdminGuestReviewDialog product={product()} onClose={() => {}} onChanged={() => {}} />)

    expect(await screen.findByTestId('admin-guest-review-video-version')).toHaveTextContent('v2 · 视频 video-a')
    expect(screen.getByText(/请打开播放器声音/)).toBeInTheDocument()
    expect(previewProductVideo).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /播放商品视频/ }))
    const element = await screen.findByLabelText('商品展示视频')
    expect(previewProductVideo).toHaveBeenCalledWith('admin', 'video-a', expect.any(AbortSignal))
    expect(element).toHaveAttribute('controls')
    fireEvent.click(screen.getByTestId('admin-guest-review-approve'))

    await waitFor(() => expect(screen.getByTestId('admin-guest-review-video-version')).toHaveTextContent('v3 · 视频 video-b'))
    expect(element).not.toHaveAttribute('src')
    expect(screen.queryByLabelText('商品展示视频')).toBeNull()
    expect(previewProductVideo).toHaveBeenCalledTimes(1)
  })

  it('ignores a late review response after the selected product changes', async () => {
    let resolveOld!: (value: adminApi.GuestEligibilityView) => void
    vi.mocked(adminApi.getAdminGuestEligibility)
      .mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce(view({ productId: 78, publicContentRevision: 8, version: 4 }))
    vi.mocked(adminApi.applyAdminGuestEligibility).mockResolvedValue(view({ productId: 78 }))
    const { rerender } = render(<AdminGuestReviewDialog product={product()} onClose={() => {}} onChanged={() => {}} />)
    rerender(<AdminGuestReviewDialog product={{ ...product(), id: 78 }} onClose={() => {}} onChanged={() => {}} />)
    await screen.findByText(/内容版本 v8/)
    await act(async () => resolveOld(view({ promoVideo: { assetId: 'old-video', durationMs: 1000, width: 320, height: 240, hasAudio: false } })))
    expect(screen.queryByTestId('admin-guest-review-video-version')).toBeNull()
    fireEvent.click(screen.getByTestId('admin-guest-review-approve'))
    await waitFor(() => expect(adminApi.applyAdminGuestEligibility).toHaveBeenCalledWith(78, {
      action: 'approve', expectedPublicContentRevision: 8, expectedEligibilityVersion: 4,
    }))
  })
})
