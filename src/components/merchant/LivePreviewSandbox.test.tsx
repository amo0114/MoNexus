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
    highlights: ['全球 20+ 边缘节点加速', '企业级 99.9% SLA 保证'],
    usageInstructions: '兑换后即时发放授权密钥，在 API Header 中携带 Bearer Token 即可。',
    purchaseNotes: '本商品为虚拟开发者服务，购买前请确认支持您的网络环境。',
    afterSalesInstructions: '支持 7 天内出现无法连通故障全额退回积分。',
    faq: [
      { question: '支持哪些请求协议？', answer: '全面支持 HTTP/2、HTTP/3 及 WebSocket 流式长连接。' },
      { question: '并发配额超限如何处理？', answer: '超出 QPS 阈值将返回 429 状态码，可升级为企业专线。' },
    ],
  },
}

describe('LivePreviewSandbox', () => {
  it('renders read-only sandbox badge, header-first meta before cover, and price with original price', () => {
    render(<LivePreviewSandbox product={MOCK_PRODUCT} />)

    expect(screen.getByTestId('live-preview-sandbox')).toBeInTheDocument()
    expect(screen.getByTestId('sandbox-readonly-badge')).toHaveTextContent('只读沙盒')

    // Header-First SPU hierarchy: meta must appear BEFORE 4:3 cover frame in DOM
    const headerMeta = screen.getByTestId('sandbox-header-meta')
    const coverFrame = screen.getByTestId('sandbox-cover-frame')
    expect(headerMeta.compareDocumentPosition(coverFrame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Header-First meta content
    expect(screen.getByTestId('sandbox-product-name')).toHaveTextContent('开发者 API 高速连接套餐')
    expect(screen.getByTestId('sandbox-product-desc')).toHaveTextContent('专为高性能模型调用打造的全球低延迟网关服务')
    expect(screen.getByText('开发者服务')).toBeInTheDocument()
    expect(screen.getByText('订阅节点')).toBeInTheDocument()

    // 4:3 cover frame
    expect(coverFrame).toHaveClass('aspect-[4/3]')
    const coverImg = screen.getByTestId('sandbox-cover-image')
    expect(coverImg).toHaveAttribute('src', 'https://assets.nexus.local/gateway.webp')

    // Price & original price
    expect(screen.getByTestId('sandbox-price')).toHaveTextContent('199')
    expect(screen.getByTestId('sandbox-original-price')).toHaveTextContent('299 积分')
    expect(screen.getByTestId('sandbox-validity-days')).toHaveTextContent('30 天有效')
  })

  it('renders disabled preview CTA and prevents any click action', () => {
    render(<LivePreviewSandbox product={MOCK_PRODUCT} />)

    const cta = screen.getByTestId('sandbox-preview-cta')
    expect(cta).toBeDisabled()
    expect(cta).toHaveTextContent('立即兑换 (沙盒只读)')
  })

  it('switches offers and updates displayed price, original price, and validity days', () => {
    const onSelect = vi.fn()
    render(<LivePreviewSandbox product={MOCK_PRODUCT} onSelectOffer={onSelect} />)

    expect(screen.getByTestId('sandbox-price')).toHaveTextContent('199')
    expect(screen.getByTestId('sandbox-original-price')).toHaveTextContent('299 积分')
    expect(screen.getByTestId('sandbox-validity-days')).toHaveTextContent('30 天有效')

    // Switch to offer 2
    fireEvent.click(screen.getByTestId('sandbox-offer-1'))
    expect(onSelect).toHaveBeenCalledWith(1)
    expect(screen.getByTestId('sandbox-price')).toHaveTextContent('499')
    expect(screen.getByTestId('sandbox-original-price')).toHaveTextContent('899 积分')
    expect(screen.getByTestId('sandbox-validity-days')).toHaveTextContent('90 天有效')
  })

  it('renders real ProductDetails sections (highlights, richDescription, usageInstructions, purchaseNotes, afterSales, faq)', () => {
    render(<LivePreviewSandbox product={MOCK_PRODUCT} />)

    // Highlights
    expect(screen.getByTestId('sandbox-highlights')).toBeInTheDocument()
    expect(screen.getByText('全球 20+ 边缘节点加速')).toBeInTheDocument()
    expect(screen.getByText('企业级 99.9% SLA 保证')).toBeInTheDocument()

    // Rich description
    expect(screen.getByTestId('sandbox-rich-description')).toHaveTextContent('本服务包含全球 20+ 边缘节点加速')

    // Usage instructions
    expect(screen.getByTestId('sandbox-usage-instructions')).toBeInTheDocument()
    expect(screen.getByText(/兑换后即时发放授权密钥/)).toBeInTheDocument()

    // Purchase notes
    expect(screen.getByTestId('sandbox-purchase-notes')).toBeInTheDocument()
    expect(screen.getByText(/本商品为虚拟开发者服务/)).toBeInTheDocument()

    // After sales
    expect(screen.getByTestId('sandbox-after-sales')).toBeInTheDocument()
    expect(screen.getByText(/支持 7 天内出现无法连通故障全额退回积分/)).toBeInTheDocument()

    // FAQ
    expect(screen.getByTestId('sandbox-faq')).toBeInTheDocument()
    expect(screen.getByText('支持哪些请求协议？')).toBeInTheDocument()
    expect(screen.getByText(/全面支持 HTTP\/2、HTTP\/3/)).toBeInTheDocument()
  })

  it('gracefully renders fallback when no images or offers or details are provided', () => {
    const minimalProduct: LivePreviewProductData = {
      name: '极简测试商品',
      price: '50',
    }
    render(<LivePreviewSandbox product={minimalProduct} />)

    expect(screen.getByText('尚未添加封面图')).toBeInTheDocument()
    expect(screen.getByTestId('sandbox-price')).toHaveTextContent('50')
    expect(screen.queryByTestId('sandbox-original-price')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sandbox-validity-days')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sandbox-offer-list')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sandbox-details-section')).not.toBeInTheDocument()
  })
})
