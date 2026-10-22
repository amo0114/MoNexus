import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProductVideoPlayer from './ProductVideoPlayer'
import ProductDetailGallery from './productDetail/ProductDetailGallery'
import { useAuthStore } from '../../stores/authStore'
import { getProductVideoPlayback } from '../../api/productVideos'
vi.mock('../../api/productVideos', () => ({ getProductVideoPlayback: vi.fn(), previewProductVideo: vi.fn() }))
const ticket = { videoAssetId: 'asset', playbackUrl: '/private-video', posterUrl: '/private-poster', expiresAt: new Date(Date.now() + 180_000).toISOString() }
beforeEach(() => {
  vi.mocked(getProductVideoPlayback).mockReset()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})
describe('private product video lifecycle', () => {
  it('does not fetch a ticket or set video src until click, then uses native inline controls', async () => {
    vi.mocked(getProductVideoPlayback).mockResolvedValue(ticket)
    const { container } = render(<ProductVideoPlayer productId={1} assetId="asset" cover="/cover.png" />)
    expect(getProductVideoPlayback).not.toHaveBeenCalled()
    expect(container.querySelector('video')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /播放商品视频/ }))
    await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', '/private-video'))
    expect(container.querySelector('video')).toHaveAttribute('preload', 'none')
    expect(container.querySelector('video')).toHaveAttribute('playsinline')
  })
  it('aborts and ignores a late ticket on identity change, and clears already rendered src', async () => {
    let resolve!: (value: typeof ticket) => void
    vi.mocked(getProductVideoPlayback).mockImplementation(() => new Promise(r => { resolve = r }))
    const { container } = render(<ProductVideoPlayer productId={1} assetId="asset" />)
    fireEvent.click(screen.getByRole('button', { name: /播放商品视频/ }))
    act(() => useAuthStore.setState(s => ({ authEpoch: s.authEpoch + 1 })))
    await act(async () => { resolve(ticket) })
    expect(container.querySelector('video')).toBeNull()
    vi.mocked(getProductVideoPlayback).mockResolvedValue(ticket)
    fireEvent.click(screen.getByRole('button', { name: /播放商品视频/ }))
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull())
    const element = container.querySelector('video')!
    act(() => useAuthStore.setState(s => ({ authEpoch: s.authEpoch + 1 })))
    expect(element.getAttribute('src')).toBeNull()
    expect(container.querySelector('video')).toBeNull()
  })
  it('renews expired credentials only once and falls back on denial', async () => {
    vi.mocked(getProductVideoPlayback).mockResolvedValueOnce({ ...ticket, expiresAt: '2000-01-01' }).mockRejectedValueOnce(new Error('revoked'))
    const { container } = render(<ProductVideoPlayer productId={1} assetId="asset" />)
    fireEvent.click(screen.getByRole('button', { name: /播放商品视频/ }))
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull())
    fireEvent.error(container.querySelector('video')!)
    await screen.findByRole('button', { name: /暂不可播放/ })
    expect(getProductVideoPlayback).toHaveBeenCalledTimes(2)
  })
  it('keeps the image index separate and destroys video when switching to an image', async () => {
    vi.mocked(getProductVideoPlayback).mockResolvedValue(ticket)
    const show = vi.fn()
    render(<ProductDetailGallery productName="示例" productId={1} promoVideo={{ assetId: 'asset', durationMs: 1000, width: 320, height: 240, hasAudio: false }}
      images={['/image.png']} activeImage={0} preview={false} isDesktopViewport onShowImage={show} onMove={vi.fn()} onOpenLightbox={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /播放商品视频/ }))
    await screen.findByLabelText('商品展示视频')
    fireEvent.click(screen.getByRole('button', { name: '查看第 1 张图片' }))
    expect(show).toHaveBeenCalledWith(0)
    expect(screen.queryByLabelText('商品展示视频')).toBeNull()
  })
})
