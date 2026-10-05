import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import ProductDetailMobile from './ProductDetailMobile'
import ProductDetailDesktop from './ProductDetailDesktop'
import type { Product } from '../../pages/ProductDetailPage'

const createProductWithOffers = (offerCount = 6): Product => ({
  id: 101,
  name: '超级加速服务 VIP 专线超长名称用于测试截断效果',
  description: '全平台支持，高速低延迟',
  type: '网络服务',
  icon: 'zap',
  imageUrl: '',
  price: 100,
  stock: 50,
  stockMode: 'limited',
  sales: 120,
  merchant: {
    id: 1,
    name: '极速互联官方自营店',
    logoUrl: '',
    ratingAvg: 4.9,
    ratingCount: 88,
    productCount: 12,
  },
  offers: Array.from({ length: offerCount }, (_, idx) => ({
    id: 1001 + idx,
    name: `套餐 ${String.fromCharCode(65 + idx)} - 30天${idx === 4 ? '（特别尊享版超长规格说明文字）' : ''}`,
    price: (idx + 1) * 50,
    originalPrice: (idx + 1) * 60,
    status: idx === 2 ? 'sold_out' : 'active',
    deliveryMode: idx % 2 === 0 ? 'instant_inventory' : 'manual_service',
    stockMode: 'limited',
    stock: idx === 2 ? 0 : 20,
    sales: 10 * (idx + 1),
    validityDays: (idx + 1) * 30,
  })),
})

describe('ProductDetailPhase3 - Mobile SKU Drawer and Bottom Bar', () => {
  it('renders mobile bottom bar with active offer name, price, shortfall and change button', () => {
    const product = createProductWithOffers(3)
    const onSelectOffer = vi.fn()
    const onRedeem = vi.fn()

    render(
      <MemoryRouter>
        <ProductDetailMobile
          product={product}
          preview={false}
          gallery={<div data-testid="mock-gallery">Gallery</div>}
          share={<button>Share</button>}
          reviews={<div>Reviews</div>}
          template={null}
          activeOffer={product.offers![0]}
          selectedOfferId={product.offers![0].id}
          onSelectOffer={onSelectOffer}
          onRedeem={onRedeem}
          redeemLabel="立即兑换"
          purchaseDisabled={false}
          stockLabel="20"
          stockTitle="库存"
          shortfall={30}
        />
      </MemoryRouter>
    )

    const buyBar = screen.getByTestId('mobile-buy-bar')
    expect(buyBar).toBeInTheDocument()

    // Active offer name displayed in bottom bar
    expect(buyBar.querySelector('.pm-bottom-offer-name')).toHaveTextContent('套餐 A - 30天')
    // Price displayed in bottom bar
    expect(buyBar.querySelector('.pm-bottom-price .odometer')).toHaveAttribute('aria-label', '50 积分')
    // Shortfall badge displayed
    expect(buyBar.querySelector('.pm-bottom-shortfall')).toHaveTextContent('(差30分)')
    // Change button displayed since offers.length > 1
    const changeBtn = screen.getByRole('button', { name: '更换套餐' })
    expect(changeBtn).toBeInTheDocument()
  })

  it('hides change button when product has only 1 offer', () => {
    const product = createProductWithOffers(1)
    render(
      <MemoryRouter>
        <ProductDetailMobile
          product={product}
          preview={false}
          gallery={<div>Gallery</div>}
          share={<button>Share</button>}
          reviews={<div>Reviews</div>}
          template={null}
          activeOffer={product.offers![0]}
          selectedOfferId={product.offers![0].id}
          onSelectOffer={vi.fn()}
          onRedeem={vi.fn()}
          redeemLabel="立即兑换"
          purchaseDisabled={false}
          stockLabel="20"
          stockTitle="库存"
          shortfall={0}
        />
      </MemoryRouter>
    )

    expect(screen.queryByRole('button', { name: '更换套餐' })).toBeNull()
  })

  it('opens SKU drawer when clicking change button and allows selecting offers', () => {
    const product = createProductWithOffers(4)
    const onSelectOffer = vi.fn()
    const onRedeem = vi.fn()

    render(
      <MemoryRouter>
        <ProductDetailMobile
          product={product}
          preview={false}
          gallery={<div>Gallery</div>}
          share={<button>Share</button>}
          reviews={<div>Reviews</div>}
          template={null}
          activeOffer={product.offers![0]}
          selectedOfferId={product.offers![0].id}
          onSelectOffer={onSelectOffer}
          onRedeem={onRedeem}
          redeemLabel="立即兑换"
          purchaseDisabled={false}
          stockLabel="20"
          stockTitle="库存"
          shortfall={50}
        />
      </MemoryRouter>
    )

    // Initially drawer is closed
    expect(screen.queryByTestId('mobile-sku-sheet-list')).toBeNull()

    // Click change button
    const changeBtn = screen.getByRole('button', { name: '更换套餐' })
    fireEvent.click(changeBtn)

    // Drawer is now open
    const sheetList = screen.getByTestId('mobile-sku-sheet-list')
    expect(sheetList).toBeInTheDocument()

    // Offer A is selected
    const optionA = screen.getByTestId('mobile-sku-sheet-option-1001')
    expect(optionA).toHaveAttribute('aria-pressed', 'true')
    expect(optionA).toHaveClass('pm-sku-sheet-item-selected')

    // Offer C is sold out (status: 'sold_out', stock: 0)
    const optionC = screen.getByTestId('mobile-sku-sheet-option-1003')
    expect(optionC).toBeDisabled()
    expect(optionC).toHaveClass('pm-sku-sheet-item-disabled')
    expect(optionC).toHaveTextContent('已售罄')

    // Click offer B to switch
    const optionB = screen.getByTestId('mobile-sku-sheet-option-1002')
    fireEvent.click(optionB)
    expect(onSelectOffer).toHaveBeenCalledWith(1002)

    // Shortfall shown in drawer footer
    expect(screen.getByText('还差 50 积分')).toBeInTheDocument()

    // Click confirm in drawer
    const confirmBtn = screen.getByRole('button', { name: '立即兑换' })
    fireEvent.click(confirmBtn)
    expect(onRedeem).toHaveBeenCalledTimes(1)
  })
})

describe('ProductDetailPhase3 - Desktop Offers Collapse', () => {
  it('renders all offers without collapse toggle when offers <= 4', () => {
    const product = createProductWithOffers(4)
    render(
      <MemoryRouter>
        <ProductDetailDesktop
          product={product}
          preview={false}
          gallery={<div>Gallery</div>}
          share={<button>Share</button>}
          reviews={<div>Reviews</div>}
          template={null}
          activeOffer={product.offers![0]}
          selectedOfferId={product.offers![0].id}
          onSelectOffer={vi.fn()}
          onRedeem={vi.fn()}
          redeemLabel="立即兑换"
          purchaseDisabled={false}
          stockLabel="20"
          stockTitle="库存"
          shortfall={0}
        />
      </MemoryRouter>
    )

    const selector = screen.getByTestId('sku-selector')
    expect(selector.children.length).toBe(4)
    expect(screen.queryByTestId('desktop-offers-toggle')).toBeNull()
  })

  it('collapses offers when offers > 4, allowing expand and re-collapse', () => {
    const product = createProductWithOffers(6)
    const onSelectOffer = vi.fn()

    render(
      <MemoryRouter>
        <ProductDetailDesktop
          product={product}
          preview={false}
          gallery={<div>Gallery</div>}
          share={<button>Share</button>}
          reviews={<div>Reviews</div>}
          template={null}
          activeOffer={product.offers![0]}
          selectedOfferId={product.offers![0].id}
          onSelectOffer={onSelectOffer}
          onRedeem={vi.fn()}
          redeemLabel="立即兑换"
          purchaseDisabled={false}
          stockLabel="20"
          stockTitle="库存"
          shortfall={0}
        />
      </MemoryRouter>
    )

    const selector = screen.getByTestId('sku-selector')
    // In collapsed state, exactly 4 offers are rendered
    expect(selector.children.length).toBe(4)

    // Toggle button is present with count
    const toggleBtn = screen.getByTestId('desktop-offers-toggle')
    expect(toggleBtn).toBeInTheDocument()
    expect(toggleBtn).toHaveTextContent('展开更多套餐 (共 6 种可选)')
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false')

    // Click toggle to expand
    fireEvent.click(toggleBtn)
    expect(selector.children.length).toBe(6)
    expect(toggleBtn).toHaveTextContent('收起部分套餐')
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true')

    // Click toggle to collapse again
    fireEvent.click(toggleBtn)
    expect(selector.children.length).toBe(4)
    expect(toggleBtn).toHaveTextContent('展开更多套餐 (共 6 种可选)')
  })

  it('guarantees currently selected offer is visible in collapsed view even if index >= 4', () => {
    const product = createProductWithOffers(6)
    // Select the 6th offer (index 5, id 1006)
    const selectedOffer = product.offers![5]

    render(
      <MemoryRouter>
        <ProductDetailDesktop
          product={product}
          preview={false}
          gallery={<div>Gallery</div>}
          share={<button>Share</button>}
          reviews={<div>Reviews</div>}
          template={null}
          activeOffer={selectedOffer}
          selectedOfferId={selectedOffer.id}
          onSelectOffer={vi.fn()}
          onRedeem={vi.fn()}
          redeemLabel="立即兑换"
          purchaseDisabled={false}
          stockLabel="20"
          stockTitle="库存"
          shortfall={0}
        />
      </MemoryRouter>
    )

    // Collapsed: exactly 4 offers rendered
    const selector = screen.getByTestId('sku-selector')
    expect(selector.children.length).toBe(4)

    // The 6th offer (id 1006) must be present in DOM despite being collapsed
    const option1006 = screen.getByTestId('sku-option-1006')
    expect(option1006).toBeInTheDocument()
    expect(option1006).toHaveAttribute('aria-pressed', 'true')
  })

  it('renders fallback when product has no offers', () => {
    const product = createProductWithOffers(0)
    render(
      <MemoryRouter>
        <ProductDetailDesktop
          product={product}
          preview={false}
          gallery={<div>Gallery</div>}
          share={<button>Share</button>}
          reviews={<div>Reviews</div>}
          template={null}
          activeOffer={undefined}
          selectedOfferId={undefined}
          onSelectOffer={vi.fn()}
          onRedeem={vi.fn()}
          redeemLabel="立即兑换"
          purchaseDisabled={true}
          stockLabel="0"
          stockTitle="库存"
          shortfall={0}
        />
      </MemoryRouter>
    )

    expect(screen.getByText('暂无可售套餐')).toBeInTheDocument()
    expect(screen.queryByTestId('desktop-offers-toggle')).toBeNull()
  })
})

describe('ProductDetailPhase3 - Edge Cases & Modes', () => {
  it('handles sold-out offers by disabling buttons and displaying sold-out indicators', () => {
    const product = createProductWithOffers(2)
    // Make first offer sold out
    product.offers![0].status = 'sold_out'
    product.offers![0].stock = 0

    render(
      <MemoryRouter>
        <ProductDetailMobile
          product={product}
          preview={false}
          gallery={<div>Gallery</div>}
          share={<button>Share</button>}
          reviews={<div>Reviews</div>}
          template={null}
          activeOffer={product.offers![0]}
          selectedOfferId={product.offers![0].id}
          onSelectOffer={vi.fn()}
          onRedeem={vi.fn()}
          redeemLabel="暂时售罄"
          purchaseDisabled={true}
          stockLabel="0"
          stockTitle="库存"
          shortfall={0}
        />
      </MemoryRouter>
    )

    const buyBarCta = screen.getByTestId('mobile-buy-bar-cta')
    expect(buyBarCta).toBeDisabled()
    expect(buyBarCta).toHaveTextContent('暂时售罄')
  })

  it('correctly handles preview mode with CNY currency and preview store actions', () => {
    const product = createProductWithOffers(3)
    render(
      <MemoryRouter>
        <ProductDetailMobile
          product={product}
          preview={true}
          gallery={<div>Gallery</div>}
          share={<button>Share</button>}
          reviews={<div>Reviews</div>}
          template={null}
          activeOffer={product.offers![0]}
          selectedOfferId={product.offers![0].id}
          onSelectOffer={vi.fn()}
          onRedeem={vi.fn()}
          redeemLabel="立即购买"
          purchaseDisabled={false}
          stockLabel="充足"
          stockTitle="库存"
          shortfall={0}
        />
      </MemoryRouter>
    )

    const buyBar = screen.getByTestId('mobile-buy-bar')
    // In preview mode, bottom bar has "店铺" button
    expect(buyBar).toHaveTextContent('店铺')
    expect(buyBar).toHaveTextContent('立即购买')
  })
})

describe('ProductDetailMobile - Horizontal Tab Switching & Touch Gestures', () => {
  beforeAll(() => {
    window.scrollTo = vi.fn()
  })
  const createTestProduct = (): Product => ({
    id: 102,
    name: '测试商品名称',
    description: '测试商品基础描述信息',
    type: '网络服务',
    icon: 'zap',
    imageUrl: '',
    price: 150,
    stock: 10,
    stockMode: 'limited',
    sales: 80,
    ratingAvg: 4.8,
    ratingCount: 36,
    merchant: {
      id: 1,
      name: '测试商家',
      logoUrl: '',
      ratingAvg: 4.8,
      ratingCount: 36,
      productCount: 5,
    },
    details: {
      usageInstructions: '测试使用说明流程文字',
      purchaseNotes: '测试购买须知注意事项',
      faq: [
        { question: '支持哪些操作系统？', answer: '支持所有主流操作系统。' },
      ],
      afterSalesInstructions: '售后支持说明',
    },
    offers: [
      {
        id: 2001,
        name: '套餐一',
        price: 150,
        status: 'active',
        stock: 10,
        stockMode: 'limited',
      },
    ],
  })

  it('renders tab bar with 4 tabs and initially mounts only details section', () => {
    const product = createTestProduct()
    render(
      <MemoryRouter>
        <ProductDetailMobile
          product={product}
          preview={false}
          gallery={<div>Gallery</div>}
          share={<button>Share</button>}
          reviews={<div data-testid="test-reviews">用户评价内容组件</div>}
          template={null}
          activeOffer={product.offers![0]}
          selectedOfferId={product.offers![0].id}
          onSelectOffer={vi.fn()}
          onRedeem={vi.fn()}
          redeemLabel="立即兑换"
          purchaseDisabled={false}
          stockLabel="10"
          stockTitle="库存"
          shortfall={0}
        />
      </MemoryRouter>
    )

    const tabNav = screen.getByTestId('product-section-nav')
    expect(tabNav).toBeInTheDocument()

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(4)
    expect(tabs[0]).toHaveTextContent('商品详情')
    expect(tabs[1]).toHaveTextContent('使用说明')
    expect(tabs[2]).toHaveTextContent('常见问题')
    expect(tabs[3]).toHaveTextContent('用户评价')

    // Initial tab: details is active
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false')

    // Details panel is rendered
    const detailsPanel = screen.getByRole('tabpanel', { name: '商品详情' })
    expect(detailsPanel).toBeInTheDocument()
    expect(detailsPanel.querySelector('h2')).toHaveTextContent('商品介绍')

    // Other panels are NOT rendered (saving DOM depth and vertical scrolling)
    expect(screen.queryByText('测试使用说明流程文字')).not.toBeInTheDocument()
    expect(screen.queryByText('支持哪些操作系统？')).not.toBeInTheDocument()
    expect(screen.queryByTestId('test-reviews')).not.toBeInTheDocument()
    expect(tabNav).not.toHaveAttribute('data-stuck')
  })

  it('updates data-stuck attribute on tab bar when scrolled to sentinel threshold', async () => {
    const product = createTestProduct()
    const { container } = render(
      <MemoryRouter>
        <ProductDetailMobile
          product={product}
          preview={false}
          gallery={<div>Gallery</div>}
          share={<button>Share</button>}
          reviews={<div data-testid="test-reviews">用户评价内容组件</div>}
          template={null}
          onSelectOffer={vi.fn()}
          onRedeem={vi.fn()}
          redeemLabel="立即兑换"
          purchaseDisabled={false}
          stockLabel="10"
          stockTitle="库存"
          shortfall={0}
        />
      </MemoryRouter>
    )

    const tabNav = screen.getByTestId('product-section-nav')
    const sentinel = container.querySelector('.pm-tabs-sentinel')
    expect(sentinel).toBeInTheDocument()
    expect(tabNav).not.toHaveAttribute('data-stuck')

    vi.spyOn(sentinel as Element, 'getBoundingClientRect').mockReturnValue({
      top: 50,
      bottom: 50,
      left: 0,
      right: 375,
      width: 375,
      height: 0,
      x: 0,
      y: 50,
      toJSON: () => {},
    })

    await act(async () => {
      fireEvent.scroll(window)
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })

    expect(tabNav).toHaveAttribute('data-stuck', 'true')

    // Simulate scrolling back down (sentinel position above navbar threshold)
    vi.spyOn(sentinel as Element, 'getBoundingClientRect').mockReturnValue({
      top: 150,
      bottom: 150,
      left: 0,
      right: 375,
      width: 375,
      height: 0,
      x: 0,
      y: 150,
      toJSON: () => {},
    })

    await act(async () => {
      fireEvent.scroll(window)
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })

    expect(tabNav).not.toHaveAttribute('data-stuck')
  })

  it('switches between tabs upon clicking with directional slide classes', () => {
    const product = createTestProduct()
    render(
      <MemoryRouter>
        <ProductDetailMobile
          product={product}
          preview={false}
          gallery={<div>Gallery</div>}
          share={<button>Share</button>}
          reviews={<div data-testid="test-reviews">用户评价内容组件</div>}
          template={null}
          activeOffer={product.offers![0]}
          selectedOfferId={product.offers![0].id}
          onSelectOffer={vi.fn()}
          onRedeem={vi.fn()}
          redeemLabel="立即兑换"
          purchaseDisabled={false}
          stockLabel="10"
          stockTitle="库存"
          shortfall={0}
        />
      </MemoryRouter>
    )

    const tabs = screen.getAllByRole('tab')

    // Click "使用说明" (index 0 -> 1 = forward)
    fireEvent.click(tabs[1])
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false')

    const usagePanel = screen.getByRole('tabpanel', { name: '使用说明' })
    expect(usagePanel).toBeInTheDocument()
    expect(usagePanel).toHaveClass('pm-tab-panel-enter-forward')
    expect(screen.getByText('测试使用说明流程文字')).toBeInTheDocument()
    expect(screen.queryByRole('tabpanel', { name: '商品详情' })).not.toBeInTheDocument()

    // Click "常见问题" (index 1 -> 2 = forward)
    fireEvent.click(tabs[2])
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true')
    const faqPanel = screen.getByRole('tabpanel', { name: '常见问题' })
    expect(faqPanel).toBeInTheDocument()
    expect(screen.getByText('支持哪些操作系统？')).toBeInTheDocument()
    expect(screen.queryByText('测试使用说明流程文字')).not.toBeInTheDocument()

    // Click "商品详情" (index 2 -> 0 = backward)
    fireEvent.click(tabs[0])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    const backDetailsPanel = screen.getByRole('tabpanel', { name: '商品详情' })
    expect(backDetailsPanel).toBeInTheDocument()
    expect(backDetailsPanel).toHaveClass('pm-tab-panel-enter-backward')
  })

  it('switches to reviews tab when rating summary button is clicked', () => {
    const product = createTestProduct()
    render(
      <MemoryRouter>
        <ProductDetailMobile
          product={product}
          preview={false}
          gallery={<div>Gallery</div>}
          share={<button>Share</button>}
          reviews={<div data-testid="test-reviews">用户评价内容组件</div>}
          template={null}
          activeOffer={product.offers![0]}
          selectedOfferId={product.offers![0].id}
          onSelectOffer={vi.fn()}
          onRedeem={vi.fn()}
          redeemLabel="立即兑换"
          purchaseDisabled={false}
          stockLabel="10"
          stockTitle="库存"
          shortfall={0}
        />
      </MemoryRouter>
    )

    const ratingBtn = screen.getByTestId('rating-summary')
    fireEvent.click(ratingBtn)

    const reviewsTab = screen.getByRole('tab', { name: '用户评价' })
    expect(reviewsTab).toHaveAttribute('aria-selected', 'true')

    const reviewsPanel = screen.getByRole('tabpanel', { name: '用户评价' })
    expect(reviewsPanel).toBeInTheDocument()
    expect(screen.getByTestId('test-reviews')).toBeInTheDocument()
  })

  it('supports keyboard navigation across tabs (ArrowRight / ArrowLeft / Home / End)', () => {
    const product = createTestProduct()
    render(
      <MemoryRouter>
        <ProductDetailMobile
          product={product}
          preview={false}
          gallery={<div>Gallery</div>}
          share={<button>Share</button>}
          reviews={<div data-testid="test-reviews">用户评价内容组件</div>}
          template={null}
          activeOffer={product.offers![0]}
          selectedOfferId={product.offers![0].id}
          onSelectOffer={vi.fn()}
          onRedeem={vi.fn()}
          redeemLabel="立即兑换"
          purchaseDisabled={false}
          stockLabel="10"
          stockTitle="库存"
          shortfall={0}
        />
      </MemoryRouter>
    )

    const tabs = screen.getAllByRole('tab')
    tabs[0].focus()

    // Press ArrowRight -> moves to usage (index 1)
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' })
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')

    // Press ArrowRight -> moves to faq (index 2)
    fireEvent.keyDown(tabs[1], { key: 'ArrowRight' })
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true')

    // Press ArrowLeft -> moves back to usage (index 1)
    fireEvent.keyDown(tabs[2], { key: 'ArrowLeft' })
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')

    // Press End -> moves to reviews (index 3)
    fireEvent.keyDown(tabs[1], { key: 'End' })
    expect(tabs[3]).toHaveAttribute('aria-selected', 'true')

    // Press Home -> moves to details (index 0)
    fireEvent.keyDown(tabs[3], { key: 'Home' })
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('supports touch swipe left and right between tabs', () => {
    const product = createTestProduct()
    render(
      <MemoryRouter>
        <ProductDetailMobile
          product={product}
          preview={false}
          gallery={<div>Gallery</div>}
          share={<button>Share</button>}
          reviews={<div data-testid="test-reviews">用户评价内容组件</div>}
          template={null}
          activeOffer={product.offers![0]}
          selectedOfferId={product.offers![0].id}
          onSelectOffer={vi.fn()}
          onRedeem={vi.fn()}
          redeemLabel="立即兑换"
          purchaseDisabled={false}
          stockLabel="10"
          stockTitle="库存"
          shortfall={0}
        />
      </MemoryRouter>
    )

    const tabs = screen.getAllByRole('tab')
    const panelsContainer = document.querySelector('.pm-tab-panels')!
    expect(panelsContainer).toBeInTheDocument()

    // Swipe left (finger moves from x: 200 to x: 100, deltaX = -100) -> advances to usage (index 1)
    fireEvent.touchStart(panelsContainer, {
      touches: [{ clientX: 200, clientY: 100 }],
    })
    fireEvent.touchEnd(panelsContainer, {
      changedTouches: [{ clientX: 100, clientY: 102 }],
    })

    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: '使用说明' })).toBeInTheDocument()

    // Swipe right (finger moves from x: 100 to x: 200, deltaX = +100) -> returns to details (index 0)
    fireEvent.touchStart(panelsContainer, {
      touches: [{ clientX: 100, clientY: 100 }],
    })
    fireEvent.touchEnd(panelsContainer, {
      changedTouches: [{ clientX: 200, clientY: 98 }],
    })

    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: '商品详情' })).toBeInTheDocument()
  })
})

describe('ProductDetail - Merchant Byline and FAQ Pipeline Hub', () => {
  it('renders merchant byline in desktop purchase panel', () => {
    const product = createProductWithOffers(2)
    render(
      <MemoryRouter>
        <ProductDetailDesktop
          product={product}
          preview={false}
          gallery={<div>Gallery</div>}
          share={<button>Share</button>}
          reviews={<div>Reviews</div>}
          template={null}
          activeOffer={product.offers![0]}
          selectedOfferId={product.offers![0].id}
          onSelectOffer={vi.fn()}
          onRedeem={vi.fn()}
          redeemLabel="立即兑换"
          purchaseDisabled={false}
          stockLabel="20"
          stockTitle="库存"
          shortfall={0}
        />
      </MemoryRouter>
    )

    const merchantSection = screen.getByRole('region', { name: '商家信息' })
    // Merchant name and badges
    expect(merchantSection).toHaveTextContent('极速互联官方自营店')
    expect(merchantSection).toHaveTextContent('商家服务')

    // Contact button
    expect(screen.getByRole('button', { name: '联系客服' })).toBeInTheDocument()
  })

  it('renders fulfillment pipeline card, fallback FAQs and contact card when product has no custom FAQs', () => {
    const product = createProductWithOffers(2)
    product.details = {
      highlights: [],
      usageInstructions: '',
      purchaseNotes: '',
      afterSalesInstructions: '',
      faq: [],
    }

    render(
      <MemoryRouter>
        <ProductDetailDesktop
          product={product}
          preview={false}
          gallery={<div>Gallery</div>}
          share={<button>Share</button>}
          reviews={<div>Reviews</div>}
          template={null}
          activeOffer={product.offers![0]}
          selectedOfferId={product.offers![0].id}
          onSelectOffer={vi.fn()}
          onRedeem={vi.fn()}
          redeemLabel="立即兑换"
          purchaseDisabled={false}
          stockLabel="20"
          stockTitle="库存"
          shortfall={0}
        />
      </MemoryRouter>
    )

    // Switch to FAQ tab
    const faqTab = screen.getByRole('tab', { name: '常见问题' })
    fireEvent.click(faqTab)

    // Pipeline card is rendered
    expect(screen.getByText('数字资产履约全流程')).toBeInTheDocument()
    expect(screen.getByText('自动直发引擎运行中')).toBeInTheDocument()

    // Fallback digital FAQs are rendered
    expect(screen.getByText('兑换或购买后，如何获取卡密/服务凭据？')).toBeInTheDocument()
    expect(screen.getByText('如果卡密无法使用、提示失效或激活异常怎么办？')).toBeInTheDocument()
    expect(screen.getByText('虚拟商品兑换后是否支持退款或退换？')).toBeInTheDocument()

    // Contact card is displayed
    expect(screen.getByText('仍有关于本商品的其他疑问？')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '联系在线客服' })).toBeInTheDocument()
  })

  it('renders custom avatar and opens MerchantHoverCard with titles and badge wall on click', () => {
    const product = createProductWithOffers(2)
    product.merchant = {
      id: 99,
      name: '星际网络旗舰店',
      logoUrl: 'https://example.com/avatar.png',
      title: '钻石自营旗舰店',
      badges: ['🏆 5年老店', '⚡ 秒级履约', '💎 平台金牌'],
      ratingAvg: 4.95,
      sales: 8848,
      responseTime: '< 2分钟',
    }

    render(
      <MemoryRouter>
        <ProductDetailDesktop
          product={product}
          preview={false}
          gallery={<div>Gallery</div>}
          share={<button>Share</button>}
          reviews={<div>Reviews</div>}
          template={null}
          activeOffer={product.offers![0]}
          selectedOfferId={product.offers![0].id}
          onSelectOffer={vi.fn()}
          onRedeem={vi.fn()}
          redeemLabel="立即兑换"
          purchaseDisabled={false}
          stockLabel="20"
          stockTitle="库存"
          shortfall={0}
        />
      </MemoryRouter>
    )

    // Trigger in byline displays custom title and avatar image
    const trigger = screen.getByRole('button', { name: /星际网络旗舰店/ })
    expect(trigger).toHaveTextContent('钻石自营旗舰店')
    const avatarImg = trigger.querySelector('img')
    expect(avatarImg).toHaveAttribute('src', 'https://example.com/avatar.png')

    // Click trigger to open hover card dialog
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: '星际网络旗舰店商家名片' })
    expect(dialog).toBeInTheDocument()

    // Badge wall
    expect(dialog).toHaveTextContent('5年老店')
    expect(dialog).toHaveTextContent('秒级履约')
    expect(dialog).toHaveTextContent('平台金牌')

    // Metrics
    expect(dialog).toHaveTextContent('8,848+')
    expect(dialog).toHaveTextContent('< 2分钟')
  })

  it('renders smart back button and breadcrumb navigation in desktop view', () => {
    const product = createProductWithOffers(2)
    render(
      <MemoryRouter>
        <ProductDetailDesktop
          product={product}
          preview={false}
          gallery={<div>Gallery</div>}
          share={<button>Share</button>}
          reviews={<div>Reviews</div>}
          template={null}
          activeOffer={product.offers![0]}
          selectedOfferId={product.offers![0].id}
          onSelectOffer={vi.fn()}
          onRedeem={vi.fn()}
          redeemLabel="立即兑换"
          purchaseDisabled={false}
          stockLabel="20"
          stockTitle="库存"
          shortfall={0}
        />
      </MemoryRouter>
    )

    const backBtn = screen.getByRole('button', { name: '返回上一页' })
    expect(backBtn).toBeInTheDocument()
    expect(backBtn).toHaveTextContent('返回')

    const breadcrumbNav = screen.getByRole('navigation', { name: '面包屑导航' })
    expect(breadcrumbNav).toBeInTheDocument()
    expect(breadcrumbNav).toHaveTextContent('首页')
    expect(breadcrumbNav).toHaveTextContent(product.type)
  })
})



describe('Product detail keyboard navigation', () => {
  const props = () => {
    const product = createProductWithOffers(2)
    return {
      product, preview: false, gallery: <div>Gallery</div>, share: <button>Share</button>,
      reviews: <div>Reviews</div>, template: null, activeOffer: product.offers![0],
      selectedOfferId: product.offers![0].id, onSelectOffer: vi.fn(), onRedeem: vi.fn(),
      redeemLabel: '立即兑换', purchaseDisabled: false, stockLabel: '20', stockTitle: '库存', shortfall: 0,
    }
  }

  it('moves desktop focus, selection and panel with arrow and boundary keys', () => {
    render(<MemoryRouter><ProductDetailDesktop {...props()} /></MemoryRouter>)
    const tabs = screen.getAllByRole('tab')
    tabs[0].focus()
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' })
    expect(tabs[1]).toHaveFocus()
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', tabs[1].id)
    fireEvent.keyDown(tabs[1], { key: 'End' })
    expect(tabs.at(-1)).toHaveFocus()
    fireEvent.keyDown(tabs.at(-1)!, { key: 'ArrowRight' })
    expect(tabs[0]).toHaveFocus()
    fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' })
    expect(tabs.at(-1)).toHaveFocus()
    fireEvent.keyDown(tabs.at(-1)!, { key: 'Home' })
    expect(tabs[0]).toHaveFocus()
  })

  it('returns focus to the mobile change button when Escape closes its drawer', async () => {
    render(<MemoryRouter><ProductDetailMobile {...props()} /></MemoryRouter>)
    const trigger = screen.getByRole('button', { name: '更换套餐' })
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await vi.waitFor(() => expect(trigger).toHaveFocus())
    expect(screen.queryByTestId('mobile-sku-sheet-list')).toBeNull()
  })
})
