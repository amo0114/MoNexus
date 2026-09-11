import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG_ERROR_CODES } from '../../types/catalog'
import { useAppStore } from '../../stores/appStore'
import ProductSharePanel, { buildProductShareCopy } from './ProductSharePanel'

const mocks = vi.hoisted(() => ({
  createProductShareLink: vi.fn(),
}))

vi.mock('../../api/shareLink', () => ({
  createProductShareLink: mocks.createProductShareLink,
}))

const SHORT_URL = 'https://s.example/Ab3x9'
const CREATING_HINT = '链接正在准备，请稍后重试'

function apiError(status: number, code: string, message: string) {
  const err = new Error(message) as Error & {
    response: { status: number; data: { error: { code: string; message: string } } }
  }
  err.response = { status, data: { error: { code, message } } }
  return err
}

function renderPanel(
  overrides: Partial<{
    copyMode: 'public' | 'members_only'
    productName: string
    offerName: string | null
    points: number | null
  }> = {},
) {
  const onClose = vi.fn()
  render(
    <ProductSharePanel
      open
      onClose={onClose}
      productId={42}
      copyMode={overrides.copyMode ?? 'public'}
      productName={overrides.productName ?? '测试商品'}
      offerName={overrides.offerName === undefined ? '进阶套餐' : overrides.offerName}
      points={overrides.points === undefined ? 360 : overrides.points}
    />,
  )
  return { onClose }
}

function toastMessages() {
  return useAppStore.getState().toasts.map((toast) => toast.message)
}

describe('ProductSharePanel (spec §6.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [], islandNotice: null, modalDepth: 0 })
    mocks.createProductShareLink.mockResolvedValue({
      productId: 42,
      url: SHORT_URL,
      reused: true,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('copies public share text with offer name and integer points', async () => {
    renderPanel()
    expect(await screen.findByTestId('product-share-url')).toHaveTextContent(SHORT_URL)

    fireEvent.click(screen.getByTestId('product-share-copy-text'))
    const expected = buildProductShareCopy({
      mode: 'public',
      productName: '测试商品',
      offerName: '进阶套餐',
      points: 360,
      shortUrl: SHORT_URL,
    })
    expect(expected).toBe(`在 MoNexus 看看「测试商品」\n进阶套餐 · 360 积分\n${SHORT_URL}`)

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expected)
    })
    expect(toastMessages()).toContain('分享文案已复制')
    expect(screen.getByTestId('product-share-panel')).not.toHaveTextContent('官方保证')
    expect(screen.getByTestId('product-share-panel')).not.toHaveTextContent('全网最低')
    expect(screen.getByTestId('product-share-panel')).not.toHaveTextContent('限时抢购')
    expect(screen.getByTestId('product-share-panel')).not.toHaveTextContent('永久有效')
  })

  it('uses the no-offer public second line and copies URL only for 复制链接', async () => {
    renderPanel({ offerName: null, points: 120 })
    expect(await screen.findByTestId('product-share-url')).toHaveTextContent(SHORT_URL)
    fireEvent.click(screen.getByTestId('product-share-copy-link'))
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SHORT_URL)
    })
    expect(toastMessages()).toContain('链接已复制')

    vi.mocked(navigator.clipboard.writeText).mockClear()
    useAppStore.setState({ toasts: [] })
    fireEvent.click(screen.getByTestId('product-share-copy-text'))
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        `在 MoNexus 看看「测试商品」\n查看商品详情与可选套餐\n${SHORT_URL}`,
      )
    })
  })

  it('uses members_only copy even when the logged-in sharer has the product name', async () => {
    renderPanel({
      copyMode: 'members_only',
      productName: '会员内部商品',
      offerName: '机密套餐',
      points: 999,
    })
    expect(await screen.findByTestId('product-share-url')).toHaveTextContent(SHORT_URL)
    fireEvent.click(screen.getByTestId('product-share-copy-text'))
    const expected = `与你分享一件 MoNexus 商品，登录后查看详情。\n${SHORT_URL}`
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expected)
    })
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0] as string
    expect(copied).not.toContain('会员内部商品')
    expect(copied).not.toContain('机密套餐')
    expect(copied).not.toContain('999')
    expect(screen.getByTestId('product-share-panel')).not.toHaveTextContent('会员内部商品')
  })

  it('does not claim copy success when clipboard writeText rejects', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('denied'))
    renderPanel()
    expect(await screen.findByTestId('product-share-url')).toHaveTextContent(SHORT_URL)
    fireEvent.click(screen.getByTestId('product-share-copy-link'))

    expect(await screen.findByText('请长按或选中后复制')).toBeInTheDocument()
    const fallback = screen.getByTestId('product-share-manual-copy')
    expect(fallback).toHaveValue(SHORT_URL)
    expect(toastMessages()).not.toContain('链接已复制')
    expect(toastMessages()).not.toContain('分享文案已复制')
  })

  it('shows SHARE_LINK_CREATING copy once and does not poll', async () => {
    mocks.createProductShareLink.mockRejectedValue(
      apiError(409, CATALOG_ERROR_CODES.SHARE_LINK_CREATING, CREATING_HINT),
    )
    renderPanel()

    expect(await screen.findByTestId('product-share-status')).toHaveTextContent(
      '链接正在准备，请稍后重试',
    )
    expect(toastMessages()).toContain('链接正在准备，请稍后重试')
    expect(screen.getByTestId('product-share-copy-link')).toBeDisabled()
    expect(screen.queryByTestId('product-share-url')).not.toBeInTheDocument()

    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(mocks.createProductShareLink).toHaveBeenCalledTimes(1)
    expect(mocks.createProductShareLink).toHaveBeenCalledWith(42)
  })

  it('opens with 分享暂未开放 on SHARE_LINK_UNAVAILABLE and never copies a long domain', async () => {
    mocks.createProductShareLink.mockRejectedValue(
      apiError(503, CATALOG_ERROR_CODES.SHARE_LINK_UNAVAILABLE, '分享暂未开放'),
    )
    renderPanel({ productName: '测试商品' })

    expect(await screen.findByTestId('product-share-status')).toHaveTextContent('分享暂未开放')
    expect(screen.getByTestId('product-share-copy-link')).toBeDisabled()
    expect(screen.queryByTestId('product-share-url')).not.toBeInTheDocument()
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    expect(screen.getByTestId('product-share-panel').textContent).not.toMatch(/https?:\/\/(?!s\.example)/)
  })

  it('does not leak the product name when share-link returns 403', async () => {
    mocks.createProductShareLink.mockRejectedValue(
      apiError(403, CATALOG_ERROR_CODES.PRODUCT_LOGIN_REQUIRED, '登录后查看商品'),
    )
    renderPanel({ copyMode: 'public', productName: '不该泄漏的名称' })

    expect(await screen.findByTestId('product-share-status')).toHaveTextContent('登录后查看商品')
    expect(screen.getByTestId('product-share-panel')).not.toHaveTextContent('不该泄漏的名称')
    expect(screen.getByTestId('product-share-copy-text')).toBeDisabled()
  })
})
