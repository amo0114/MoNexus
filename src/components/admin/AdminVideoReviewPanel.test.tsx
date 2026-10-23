import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import AdminVideoReviewPanel from './AdminVideoReviewPanel'
import { listVideoReviews, reviewProductVideo } from '../../api/productVideos'
vi.mock('../../api/productVideos', () => ({ listVideoReviews: vi.fn(), reviewProductVideo: vi.fn() }))
vi.mock('../catalog/ProductVideoPlayer', () => ({ default: () => <div>私有视频预览</div> }))
const row = { assetId: 'video-a', durationMs: 1000, width: 320, height: 240, hasAudio: true, moderation: 'pending', moderationVersion: 7, product: { id: 8, name: '仅会员商品', visibility: 'members_only' } }
beforeEach(() => { vi.mocked(listVideoReviews).mockReset().mockResolvedValue({ items: [row], total: 1, page: 1, pageSize: 50 }); vi.mocked(reviewProductVideo).mockReset().mockResolvedValue(row) })
it('requires picture and audio attestation, and submits the exact asset/product/review version', async () => {
  render(<AdminVideoReviewPanel />)
  fireEvent.click(screen.getByRole('button', { name: '视频内容审核（含仅登录商品）' }))
  fireEvent.click(await screen.findByRole('button', { name: '仅会员商品 · 待审核' }))
  const approve = screen.getByRole('button', { name: '批准视频内容' })
  expect(approve).toBeDisabled()
  fireEvent.click(screen.getByLabelText('我已完整观看视频'))
  expect(approve).toBeDisabled()
  fireEvent.click(screen.getByLabelText('我已听完音频'))
  fireEvent.click(approve)
  await waitFor(() => expect(reviewProductVideo).toHaveBeenCalledWith('video-a', { productId: 8, expectedVersion: 7, action: 'approve', watched: true, listened: true }))
})
it('drops the selected preview after a stale-review conflict and reloads the queue', async () => {
  vi.mocked(reviewProductVideo).mockRejectedValue({ response: { status: 409, data: { error: { message: '视频已更新' } } } })
  render(<AdminVideoReviewPanel />)
  fireEvent.click(screen.getByRole('button', { name: '视频内容审核（含仅登录商品）' }))
  fireEvent.click(await screen.findByRole('button', { name: '仅会员商品 · 待审核' }))
  const reject = screen.getByRole('button', { name: '拒绝或撤销视频' })
  expect(reject).toBeDisabled()
  fireEvent.change(screen.getByLabelText('拒绝或撤销原因'), { target: { value: '不适合展示' } })
  fireEvent.click(reject)
  await screen.findByRole('alert')
  expect(screen.queryByText('私有视频预览')).not.toBeInTheDocument()
  expect(listVideoReviews).toHaveBeenCalledTimes(2)
})

it('pages through reviewed history and resets pagination when the status changes', async () => {
  vi.mocked(listVideoReviews).mockResolvedValue({ items: [row], total: 120, page: 1, pageSize: 50 })
  render(<AdminVideoReviewPanel />)
  fireEvent.click(screen.getByRole('button', { name: '视频内容审核（含仅登录商品）' }))
  await screen.findByRole('button', { name: '仅会员商品 · 待审核' })
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await waitFor(() => expect(listVideoReviews).toHaveBeenLastCalledWith(expect.any(AbortSignal), 'pending', 2))
  fireEvent.change(screen.getByLabelText('视频审核状态'), { target: { value: 'approved' } })
  await waitFor(() => expect(listVideoReviews).toHaveBeenLastCalledWith(expect.any(AbortSignal), 'approved', 1))
})
