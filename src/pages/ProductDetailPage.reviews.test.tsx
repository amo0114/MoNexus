import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import type { ReviewItem } from '../api/reviews'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'

const { apiGet, reviewResponse } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  reviewResponse: vi.fn(),
}))

vi.mock('../api/client', () => ({
  default: { get: apiGet, post: vi.fn(), patch: vi.fn() },
}))

import ProductDetailPage from './ProductDetailPage'

function review(id: number): ReviewItem {
  return {
    id,
    rating: 5,
    comment: `评价内容 ${id}`,
    displayName: `买家 ${id}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    editedAt: null,
  }
}

function page(items: ReviewItem[], total = items.length) {
  return { data: { items, total, pageSize: 20 } }
}

function Navigation() {
  const navigate = useNavigate()
  return <button onClick={() => navigate('/product/43')}>查看下一商品</button>
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/product/42']}>
      <Navigation />
      <Routes>
        <Route path="/product/:id" element={<ProductDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ProductDetailPage review recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reviewResponse.mockReset().mockResolvedValue(page([]))
    useAppStore.setState({ toasts: [], islandNotice: null, modalDepth: 0 })
    useAuthStore.setState({ user: null, accessToken: null, isLoggedIn: false })
    apiGet.mockImplementation((url: string, options?: { params?: { page?: number } }) => {
      const reviews = url.match(/^\/products\/(\d+)\/reviews$/)
      if (reviews) return reviewResponse(Number(reviews[1]), options?.params?.page)
      const recommendations = url.match(/^\/products\/(\d+)\/recommendations$/)
      if (recommendations) return Promise.resolve({ data: { productId: Number(recommendations[1]), items: [] } })
      const detail = url.match(/^\/products\/(\d+)$/)
      if (detail) return Promise.resolve({ data: {
        id: Number(detail[1]), name: `商品 ${detail[1]}`, description: '', type: '充值卡密',
        icon: 'box', imageUrl: '', price: 100, stock: 10, sales: 0, merchant: null,
      } })
      if (url === '/product-templates') return Promise.resolve({ data: { templates: [] } })
      return Promise.reject(new Error(`Unexpected GET ${url}`))
    })
  })

  it('distinguishes an initial request failure from no reviews and recovers on retry', async () => {
    reviewResponse
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page([review(1)]))
    renderPage()

    const reviews = await screen.findByTestId('review-list')
    expect(await within(reviews).findByRole('alert')).toHaveTextContent('评价加载失败')
    expect(within(reviews).queryByText('暂无评价')).not.toBeInTheDocument()
    fireEvent.click(within(reviews).getByRole('button', { name: '重试' }))

    expect(await within(reviews).findByText('评价内容 1')).toBeInTheDocument()
    expect(within(reviews).queryByRole('alert')).not.toBeInTheDocument()
    expect(reviewResponse.mock.calls).toEqual([[42, 1], [42, 1]])
  })

  it('preserves existing reviews and retries the failed page before continuing pagination', async () => {
    reviewResponse
      .mockResolvedValueOnce(page([review(1)], 3))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page([review(2)], 3))
      .mockResolvedValueOnce(page([review(3)], 3))
    renderPage()

    const reviews = await screen.findByTestId('review-list')
    await within(reviews).findByText('评价内容 1')
    fireEvent.click(within(reviews).getByRole('button', { name: '加载更多' }))
    await within(reviews).findByRole('alert')
    expect(within(reviews).getByText('评价内容 1')).toBeInTheDocument()
    expect(within(reviews).queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument()

    fireEvent.click(within(reviews).getByRole('button', { name: '重试' }))
    await within(reviews).findByText('评价内容 2')
    expect(within(reviews).getAllByText('评价内容 1')).toHaveLength(1)
    fireEvent.click(within(reviews).getByRole('button', { name: '加载更多' }))
    await within(reviews).findByText('评价内容 3')
    expect(reviewResponse.mock.calls).toEqual([[42, 1], [42, 2], [42, 2], [42, 3]])
    expect(within(reviews).queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument()
  })

  it('ignores a late failure from the previous product after navigation', async () => {
    let rejectPrevious!: (reason: Error) => void
    reviewResponse.mockImplementationOnce(() => new Promise((_, reject) => { rejectPrevious = reject }))
    renderPage()
    await waitFor(() => expect(reviewResponse).toHaveBeenCalledWith(42, 1))

    fireEvent.click(screen.getByRole('button', { name: '查看下一商品' }))
    await waitFor(() => expect(reviewResponse).toHaveBeenCalledWith(43, 1))
    await screen.findByText('暂无评价')
    await act(async () => rejectPrevious(new Error('late network failure')))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(screen.getByText('暂无评价')).toBeInTheDocument()
  })
  it('does not skip a pending page when load more is clicked again', async () => {
    let resolveSecond!: (value: ReturnType<typeof page>) => void
    reviewResponse.mockResolvedValueOnce(page([review(1)], 3))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve }))
      .mockResolvedValueOnce(page([review(3)], 3))
    renderPage()
    const reviews = await screen.findByTestId('review-list')
    await within(reviews).findByText('评价内容 1')
    fireEvent.click(within(reviews).getByRole('button', { name: '加载更多' }))
    const loading = within(reviews).getByRole('button', { name: '加载中…' })
    expect(loading).toBeDisabled()
    fireEvent.click(loading)
    expect(reviewResponse.mock.calls).toEqual([[42, 1], [42, 2]])
    await act(async () => resolveSecond(page([review(2)], 3)))
    await within(reviews).findByText('评价内容 2')
    fireEvent.click(within(reviews).getByRole('button', { name: '加载更多' }))
    await within(reviews).findByText('评价内容 3')
    expect(within(reviews).getByText('评价内容 2')).toBeInTheDocument()
  })

})
