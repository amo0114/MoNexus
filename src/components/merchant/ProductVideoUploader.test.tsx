import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import ProductVideoUploader from './ProductVideoUploader'
import { uploadProductVideo, listProductVideoJobs } from '../../api/productVideos'
vi.mock('../../api/productVideos', () => ({ uploadProductVideo: vi.fn(), listProductVideoJobs: vi.fn() }))
vi.mock('../catalog/ProductVideoPlayer', () => ({ default: () => <div>预览</div> }))
beforeEach(() => { vi.mocked(uploadProductVideo).mockReset(); vi.mocked(listProductVideoJobs).mockResolvedValue([]) })
it('shows real transfer vs validation progress and keeps the previous asset after replacement fails', async () => {
  let reject!: (err: Error) => void
  vi.mocked(uploadProductVideo).mockImplementation((_file, progress) => { progress(100); return new Promise((_r, no) => { reject = no }) })
  const change = vi.fn(); const busy = vi.fn()
  render(<ProductVideoUploader value={{ assetId: 'old', durationMs: 1000, width: 320, height: 240, hasAudio: false }} onChange={change} onBusyChange={busy} />)
  fireEvent.change(screen.getByLabelText('选择商品视频'), { target: { files: [new File(['bytes'], 'clip.mp4', { type: 'video/mp4' })] } })
  expect(screen.getByRole('status')).toHaveTextContent('正在保存原片')
  reject(new Error('network failed'))
  await screen.findByRole('alert')
  expect(change).not.toHaveBeenCalled()
  expect(screen.getByText('预览')).toBeInTheDocument()
  await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false))
  fireEvent.click(screen.getByRole('button', { name: /移除视频/ }))
  expect(change).toHaveBeenCalledWith(null)
})
it('rejects oversized input before sending bytes', () => {
  render(<ProductVideoUploader onChange={vi.fn()} />)
  const file = new File(['x'], 'large.mp4'); Object.defineProperty(file, 'size', { value: 90 * 1024 * 1024 + 1 })
  fireEvent.change(screen.getByLabelText('选择商品视频'), { target: { files: [file] } })
  expect(uploadProductVideo).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('90 MiB')
})

it('recovers a completed upload without replacing the previous video until selected', async () => {
  const next = { assetId: 'recovered', durationMs: 1000, width: 320, height: 240, hasAudio: false }
  vi.mocked(listProductVideoJobs).mockResolvedValue([{ assetId: next.assetId, status: 'ready', error: null, video: next }])
  const change = vi.fn()
  render(<ProductVideoUploader onChange={change} />)
  await screen.findByRole('button', { name: '使用此视频（保存后生效）' })
  expect(change).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '使用此视频（保存后生效）' }))
  expect(change).toHaveBeenCalledWith(next)
})
