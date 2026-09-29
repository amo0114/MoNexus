import { badRequest } from '../../lib/httpError.js'
import { listProducts, getProductDetail } from '../products/service.js'

/**
 * SPEC-CHAT-BOT-001 —— 机器人侧商品查询（只读）。
 *
 * 三条设计约束：
 *
 * 1. **复用网站的 service，不另写查询。** 商品可见性（members_only、商家状态、
 *    归档）、售罄判定、Xboard 名额探测都是业务规则；另写一套迟早与网站漂移。
 *    「机器人说有货、网站说已抢光」是最糟的用户体验。这里只做字段**投影**。
 *
 * 2. **可售状态直接取 service 的投影结果，不重新解释原始字段。**
 *    `serializePublicProductListItem` 返回的 `stock` / `stockMode` 已经是综合了
 *    offers 与 inventory 计数的权威值（见 service.ts 的 computePublicAvailability），
 *    前端也用它。若在机器人侧重算，混合规格商品会与网站不一致。
 *
 * 3. **只读，不支持下单。** 机器人负责发现，成交回网站。下单涉及积分扣除与
 *    库存占用，聊天窗口内无法二次确认，风险高于收益。
 */

export interface BotProductSummary {
  id: number
  name: string
  price: number
  /** 展示用库存文案：'不限' | '已抢光' | 数字。口径与前端一致。 */
  stockLabel: string
  soldOut: boolean
  merchantName: string | null
  categoryLabel: string | null
  ratingAvg: number
  url: string
}

export interface BotProductDetail extends BotProductSummary {
  description: string | null
  imageUrl: string | null
  sales: number
}

const MAX_KEYWORD_LENGTH = 40
const PAGE_SIZE = 8

function normalizeKeyword(raw: unknown): string {
  const q = String(raw ?? '').trim()
  if (q.length > MAX_KEYWORD_LENGTH) {
    throw badRequest(`关键词过长（最多 ${MAX_KEYWORD_LENGTH} 字）`)
  }
  return q
}

function normalizePage(raw: unknown): number {
  const n = Number(raw ?? 1)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(Math.floor(n), 20)
}

/**
 * 由 service 投影后的可售字段生成展示文案。
 *
 * Xboard 名额（fakaCapacity.remaining）优先：FakaBridge 商品的真实可售量在
 * 外部套餐上，本地 stock 对它没有意义。
 */
function toStockLabel(item: {
  stock?: number | null
  stockMode?: string | null
  fakaCapacity?: { remaining?: number | null } | null
}): { label: string; soldOut: boolean } {
  const fakaRemaining = item.fakaCapacity?.remaining
  if (typeof fakaRemaining === 'number') {
    return fakaRemaining > 0
      ? { label: String(fakaRemaining), soldOut: false }
      : { label: '已抢光', soldOut: true }
  }

  if (item.stockMode === 'unlimited') return { label: '不限', soldOut: false }

  const stock = item.stock ?? 0
  return stock > 0
    ? { label: String(stock), soldOut: false }
    : { label: '已抢光', soldOut: true }
}

/** service 投影后的条目形状（只列本文件用到的字段）。 */
interface SerializedListItem {
  id: number
  name?: string | null
  price?: number | null
  stock?: number | null
  stockMode?: string | null
  ratingAvg?: number | null
  fakaCapacity?: { remaining?: number | null } | null
  merchant?: { name?: string | null } | null
  category?: { label?: string | null } | null
}

function projectSummary(item: SerializedListItem, baseUrl: string): BotProductSummary {
  const { label, soldOut } = toStockLabel(item)
  return {
    id: item.id,
    name: item.name ?? `商品 ${item.id}`,
    price: item.price ?? 0,
    stockLabel: label,
    soldOut,
    merchantName: item.merchant?.name ?? null,
    categoryLabel: item.category?.label ?? null,
    ratingAvg: Number(item.ratingAvg ?? 0),
    url: `${baseUrl}/product/${item.id}`,
  }
}

export interface BotSearchResult {
  items: BotProductSummary[]
  page: number
  /** 游标分页：service 返回 nextCursor 表示还有下一页。 */
  hasMore: boolean
}

/**
 * 关键词搜索。空关键词返回默认列表（与网站首页口径一致），让用户在不
 * 知道买什么时也有东西可看。
 */
export async function searchProducts(params: {
  keyword?: unknown
  page?: unknown
  baseUrl: string
}): Promise<BotSearchResult> {
  const keyword = normalizeKeyword(params.keyword)
  const page = normalizePage(params.page)

  const result = await listProducts({
    query: keyword || undefined,
    page,
    pageSize: PAGE_SIZE,
    audience: 'guest',
  })

  const items = (result.items as unknown as SerializedListItem[]).map(item =>
    projectSummary(item, params.baseUrl)
  )

  return {
    items,
    page,
    hasMore: Boolean((result as { nextCursor?: string | null }).nextCursor),
  }
}

/** 商品详情。使用 guest 视角，与网站未登录访问一致。 */
export async function productDetail(params: {
  id: unknown
  baseUrl: string
}): Promise<BotProductDetail | null> {
  const id = Number(params.id)
  if (!Number.isInteger(id) || id < 1) throw badRequest('商品编号不合法')

  const detail = (await getProductDetail(id, 'guest')) as unknown as
    | (SerializedListItem & {
        description?: string | null
        images?: string[] | null
        sales?: number | null
      })
    | null
  if (!detail) return null

  const summary = projectSummary(detail, params.baseUrl)
  const images = Array.isArray(detail.images) ? detail.images : []

  return {
    ...summary,
    description: detail.description ?? null,
    imageUrl: images.length > 0 ? images[0] : null,
    sales: detail.sales ?? 0,
  }
}
