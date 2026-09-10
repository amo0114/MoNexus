import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import LivePreviewSandbox, { type LivePreviewProductData } from './LivePreviewSandbox'

const MOCK_PRODUCT: LivePreviewProductData = {
  name: '开发者 API 高速连接套餐',
  price: '199',
  originalPrice: '299',
  description: '专为高性能模型调用打造的全球低延迟网关服务',
  richDescription: '<p>本服务包含全球 20+ 边缘节点加速，具备企业级 SLA 保障。</p>',
  images: ['https://assets.nexus.local/gateway.webp', 'https://assets.nexus.local/gateway-2.webp'],
  categoryName: '开发者服务',
  templateName: '订阅节点',
  deliveryMode: 'instant_inventory',
  offers: [
    { id: 1, name: '月卡标准版', price: '199', originalPrice: '299', validityDays: 30 },
    { id: 2, name: '季卡优惠版', price: '499', originalPrice: '899', validityDays: 90 },
  ],
  details: {
    specs: [
      { label: '支持协议', value: 'HTTP/2, WebSocket' },
      { label: '并发限制', value: '100 QPS' },
    ],
  },
}

describe('LivePreviewSandbox', () => {
  it('renders read-only sandbox badge, header-first meta, 4:3 cover, and price', () => {
    render(<LivePreviewSandbox product={MOCK_PRODUCT} />)

    expect(screen.getByTestId('live-preview-sandbox')).toBeInTheDocument()
    expect(screen.getByTestId('sandbox-readonly-badge')).toHaveTextContent('只读沙盒')

    // Header-First meta
    expect(screen.getByTestId('sandbox-product-name')).toHaveTextContent('开发者 API 高速连接套餐')
    expect(screen.getByTestId('sandbox-product-desc')).toHaveTextContent('专为高性能模型调用打造的全球低延迟网关服务')
    expect(screen.getByText('开发者服务')).toBeInTheDocument()
    expect(screen.getByText('订阅节点')).toBeInTheDocument()

    // 4:3 cover frame
    const coverFrame = screen.getByTestId('sandbox-cover-frame')
    expect(coverFrame).toHaveClass('aspect-[4/3]')
    const coverImg = screen.getByTestId('sandbox-cover-image')
    expect(coverImg).toHaveAttribute('src', 'https://assets.nexus.local/gateway.webp')

    // Price
    expect(screen.getByTestId('sandbox-price')).toHaveTextContent('199')
    expect(screen.getByText('299 积分')).toBeInTheDocument()
  })

  it('renders disabled preview CTA and prevents any click action', () => {
    render(<LivePreviewSandbox product={MOCK_PRODUCT} />)

    const cta = screen.getByTestId('sandbox-preview-cta')
    expect(cta).toBeDisabled()
    expect(cta).toHaveTextContent('立即兑换 (沙盒只读)')
  })

  it('switches offers and updates displayed price and validity', () => {
    const onSelect = vi.fn()
    render(<LivePreviewSandbox product={MOCK_PRODUCT} onSelectOffer={onSelect} />)

    expect(screen.getByTestId('sandbox-price')).toHaveTextContent('199')
    expect(screen.getByText('30 天有效')).toBeInTheDocument()

    // Switch to offer 2
    fireEvent.click(screen.getByTestId('sandbox-offer-1'))
    expect(onSelect).toHaveBeenCalledWith(1)
    expect(screen.getByTestId('sandbox-price')).toHaveTextContent('499')
    expect(screen.getByText('90 天有效')).toBeInTheDocument()
  })

  it('renders specs and sanitized rich text description', () => {
    render(<LivePreviewSandbox product={MOCK_PRODUCT} />)

    expect(screen.getByText('支持协议')).toBeInTheDocument()
    expect(screen.getByText('HTTP/2, WebSocket')).toBeInTheDocument()
    expect(screen.getByTestId('sandbox-rich-description')).toHaveTextContent('本服务包含全球 20+ 边缘节点加速')
  })

  it('gracefully renders fallback when no images or offers are provided', () => {
    const minimalProduct: LivePreviewProductData = {
      name: '极简测试商品',
      price: '50',
    }
    render(<LivePreviewSandbox product={minimalProduct} />)

    expect(screen.getByText('尚未添加封面图')).toBeInTheDocument()
    expect(screen.getByTestId('sandbox-price')).toHaveTextContent('50')
    expect(screen.queryByTestId('sandbox-offer-list')).not.toBeInTheDocument()
  })
})
