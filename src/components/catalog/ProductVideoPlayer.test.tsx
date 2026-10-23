import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProductVideoPlayer from './ProductVideoPlayer'
import ProductDetailGallery from './productDetail/ProductDetailGallery'
import { useAuthStore } from '../../stores/authStore'
import { getProductVideoPlayback } from '../../api/productVideos'
vi.mock('../../api/productVideos', () => ({ getProductVideoPlayback: vi.fn(), previewProductVideo: vi.fn() }))
const ticket = { videoAssetId: 'asset', playbackUrl: '/private-video', posterUrl: '/private-poster', expiresAt: new Date(Date.now() + 180_000).toISOString() }
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getProductVideoPlayback).mockReset()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
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
  it('autoplays muted only when opted in and falls back to an icon when the browser refuses', async () => {
    vi.mocked(getProductVideoPlayback).mockResolvedValue(ticket)
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('Blocked', 'NotAllowedError'))
    const { container } = render(<ProductVideoPlayer autoPlay productId={1} assetId="asset" />)
    await screen.findByLabelText('商品展示视频')
    const fallback = await screen.findByRole('button', { name: '播放商品视频' })
    expect(fallback.textContent).toBe('')
    expect(container.querySelector('video')!.muted).toBe(true)
    fireEvent.click(fallback)
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2))
    expect(getProductVideoPlayback).toHaveBeenCalledTimes(1)
    fireEvent.play(container.querySelector('video')!)
    expect(screen.queryByRole('button', { name: '播放商品视频' })).toBeNull()
  })
  it('loads in view, pauses offscreen, and respects an explicit pause when returning', async () => {
    let intersect!: (visible: boolean) => void
    const disconnect = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = visible => callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      }
      observe() {}
      disconnect = disconnect
    })
    try {
      vi.mocked(getProductVideoPlayback).mockResolvedValue(ticket)
      const { container, unmount } = render(<ProductVideoPlayer autoPlay productId={1} assetId="asset" />)
      expect(getProductVideoPlayback).not.toHaveBeenCalled()
      act(() => intersect(true))
      await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1))
      const element = container.querySelector('video')!
      Object.defineProperty(element, 'paused', { configurable: true, value: false })
      // Simulate the browser's queued pause event arriving after scroll-back.
      vi.mocked(HTMLMediaElement.prototype.pause).mockImplementation(() => {})
      act(() => intersect(false))
      expect(element.pause).toHaveBeenCalled()
      act(() => intersect(true))
      await waitFor(() => expect(element.play).toHaveBeenCalledTimes(2))
      fireEvent.pause(element) // delayed programmatic event
      fireEvent.pause(element) // explicit user pause
      act(() => intersect(false))
      act(() => intersect(true))
      expect(element.play).toHaveBeenCalledTimes(2)
      unmount()
      expect(disconnect).toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })
  it('pauses in a hidden tab, resumes on return, and does not restart an ended video', async () => {
    vi.mocked(getProductVideoPlayback).mockResolvedValue(ticket)
    const { container } = render(<ProductVideoPlayer autoPlay productId={1} assetId="asset" />)
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1))
    const element = container.querySelector('video')!
    Object.defineProperty(element, 'paused', { configurable: true, value: false })
    vi.mocked(HTMLMediaElement.prototype.pause).mockImplementation(function (this: HTMLMediaElement) { fireEvent.pause(this) })
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    function change(state: DocumentVisibilityState) {
      visibility.mockReturnValue(state)
      fireEvent(document, new Event('visibilitychange'))
    }
    try {
      change('hidden')
      expect(element.pause).toHaveBeenCalled()
      change('visible')
      await waitFor(() => expect(element.play).toHaveBeenCalledTimes(2))
      fireEvent.ended(element)
      change('hidden'); change('visible')
      expect(element.play).toHaveBeenCalledTimes(2)
    } finally { visibility.mockRestore() }
  })
  it('resumes at the previous position after a successful expired-ticket renewal', async () => {
    vi.mocked(getProductVideoPlayback).mockResolvedValueOnce({ ...ticket, expiresAt: '2000-01-01' })
      .mockResolvedValueOnce({ ...ticket, playbackUrl: '/renewed-video' })
    const { container } = render(<ProductVideoPlayer autoPlay productId={1} assetId="asset" />)
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1))
    const old = container.querySelector('video')!
    old.currentTime = 12
    Object.defineProperty(old, 'error', { value: { code: 2 } })
    fireEvent.pause(old) // a media failure is not the visitor pressing Pause
    fireEvent.error(old)
    await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', '/renewed-video'))
    const renewed = container.querySelector('video')!
    fireEvent.loadedMetadata(renewed)
    expect(renewed.currentTime).toBe(12)
    expect(old.getAttribute('src')).toBeNull()
    expect(renewed.play).toHaveBeenCalledTimes(2)
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
    await screen.findByLabelText('商品展示视频')
    fireEvent.click(screen.getByRole('button', { name: '查看第 1 张图片' }))
    expect(show).toHaveBeenCalledWith(0)
    expect(screen.queryByLabelText('商品展示视频')).toBeNull()
  })
})
