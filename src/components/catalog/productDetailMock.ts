import type { Product } from '../../pages/ProductDetailPage'
import type { ReviewItem } from '../../api/reviews'

export const PRODUCT_MOCK_ASSETS = '/assets/mock/product-detail'

// Explicit design-preview fixture. Never used for a real checkout.
export const referenceProduct: Product = {
  id: -1,
  name: 'Aster Link 传奇凤凰套餐',
  description: '高速稳定的全球网络服务，覆盖多个优质节点，满足你在日常上网、办公、娱乐等场景下的使用需求。',
  type: '网络服务',
  icon: 'globe',
  imageUrl: `${PRODUCT_MOCK_ASSETS}/hero.png`,
  images: ['hero', 'thumb-video', 'thumb-app', 'thumb-map', 'thumb-landscape', 'thumb-more'].map(
    (name) => `${PRODUCT_MOCK_ASSETS}/${name}.png`
  ),
  price: 29,
  stock: 999,
  stockMode: 'unlimited',
  sales: 6721,
  ratingAvg: 4.9,
  ratingCount: 1283,
  merchant: {
    id: -1,
    name: '墨缘精选商家',
    title: '官方认证金牌店铺',
    badges: ['平台认证', '秒级履约', '全额存管', '优质商户'],
    ratingAvg: 4.9,
    sales: 6721,
    responseTime: '< 3分钟',
    verified: true,
  },
  details: {
    highlights: ['全球优质线路', '多平台支持', '高速稳定', '隐私安全'],
    usageInstructions:
      '1. 选择适合自己的套餐。\n2. 完成购买后，在订单详情中查看订阅信息。\n3. 将订阅导入对应设备的客户端，即可开始使用。',
    purchaseNotes: '请根据使用时长选择套餐；具体服务范围以商品说明为准。',
    afterSalesInstructions: '如遇使用问题，请联系商家客服，或通过平台申请售后协助。',
    faq: [
      { question: '支持哪些设备？', answer: '支持 Windows、macOS、iOS 和 Android，按设备选择对应客户端。' },
      { question: '购买后在哪里查看订阅？', answer: '在个人中心的订单详情中查看交付内容和使用说明。' },
      { question: '遇到问题如何联系客服？', answer: '点击页面中的“联系客服”，查看客服联系方式。' },
    ],
  },
  offers: [
    { id: -11, name: '月付', price: 29, originalPrice: null, validityDays: 30 },
    { id: -12, name: '季付', price: 79, originalPrice: 87, validityDays: 90 },
    { id: -13, name: '年付', price: 299, originalPrice: 348, validityDays: 365 },
  ].map((offer) => ({
    ...offer,
    status: 'active',
    deliveryMode: 'instant_inventory',
    stockMode: 'unlimited',
    stock: 999,
  })),
}

export const referenceRelated = [
  { id: 'basic', name: 'Aster Link 基础套餐', price: 19, rating: '4.8', sales: '3,241' },
  { id: 'pro', name: '全球加速 Pro', price: 89, rating: '4.9', sales: '1,032' },
  { id: 'gaming', name: '轻量游戏专线', price: 39, rating: '4.7', sales: '978' },
]

export const referenceReviews: ReviewItem[] = [
  {
    id: -1,
    displayName: '晨间旅人',
    rating: 5,
    comment: '订阅导入很方便，电脑和手机都可以使用。',
    createdAt: '2026-10-01T08:00:00Z',
    editedAt: null,
  },
  {
    id: -2,
    displayName: '山间来信',
    rating: 5,
    comment: '使用说明清楚，客服回复也很及时。',
    createdAt: '2026-09-29T08:00:00Z',
    editedAt: null,
  },
  {
    id: -3,
    displayName: '小岛',
    rating: 4,
    comment: '先选了月付体验，日常使用比较顺畅。',
    createdAt: '2026-09-26T08:00:00Z',
    editedAt: null,
  },
]
