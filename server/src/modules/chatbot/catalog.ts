import { badRequest } from '../../lib/httpError.js'
import { listProducts, getProductDetail } from '../products/service.js'
import type { AvailabilityStatus } from '../products/publicAvailability.js'

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
 *    `availability.status` 是网站卡片、推荐、详情共用的三态（见 products/publicAvailability.ts，
 *    综合本站套餐配置、真实库存与 Faka 快照）；`stock` / `stockMode` 只用于可售时的数量文案。
 *    若在机器人侧重算，多 Plan / 混合规格商品会与网站不一致。
 *
 * 3. **只读，不支持下单。** 机器人负责发现，成交回网站。下单涉及积分扣除与
 *    库存占用，聊天窗口内无法二次确认，风险高于收益。
 */

export interface BotProductSummary {
  id: number
  name: string
  price: number
  /** 展示用库存文案：'不限' | 数字 | '查看套餐' | '暂不可售' | '待确认'。口径与网站卡片一致。 */
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
 * 由 service 投影后的可售字段生成展示文案，与网站商品卡片同口径：
 * 可售性只看 `availability.status`；Faka 商品的 fakaCapacity 只是某个代表 Plan 的快照，
 * 多 Plan / 混合套餐时不能当整件商品的名额，因此可售时提示去网站查看套餐。
 */
function toStockLabel(item: {
  stock?: number | null
  stockMode?: string | null
  fakaCapacity?: unknown
  availability: { status: AvailabilityStatus }
}): { label: string; soldOut: boolean } {
  if (item.availability.status === 'unavailable') return { label: '暂不可售', soldOut: true }
  if (item.availability.status === 'unknown') return { label: '待确认', soldOut: false }
  if (item.fakaCapacity) return { label: '查看套餐', soldOut: false }
  if (item.stockMode === 'unlimited') return { label: '不限', soldOut: false }
  return { label: String(item.stock ?? 0), soldOut: false }
}

/** service 投影后的条目形状（只列本文件用到的字段）。 */
interface SerializedListItem {
  id: number
  name?: string | null
  price?: number | null
  stock?: number | null
  stockMode?: string | null
  ratingAvg?: number | null
  fakaCapacity?: unknown
  availability: { status: AvailabilityStatus }
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
 * 关键词搜索。空关键词返回默认列表，让用户在不
 * 知道买什么时也有东西可看。
 *
 * ⚠️ audience 必须是 'member' 而非 'guest'。
 *
 * 平台上绝大多数商品的 visibility 是默认值 `members_only`（实测 830 个
 * active 商品里有 759 个），而 `publicVisibilityWhere('guest')` 会加上
 * `visibility: 'public'` 过滤——等于滤掉 91% 的商品，用户搜索时几乎
 * 什么都看不到。
 *
 * 用 'member' 是合理的：调用方在路由层已通过 HMAC 校验，且这些命令面向
 * 已绑定站内账号的用户；商品本身对登录用户可见，机器人代其查询与网站在
 * 登录态下浏览的口径一致。
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
    audience: 'member',
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

/** 商品详情。同 searchProducts，用 'member' 视角以覆盖 members_only 商品。 */
export async function productDetail(params: {
  id: unknown
  baseUrl: string
}): Promise<BotProductDetail | null> {
  const id = Number(params.id)
  if (!Number.isInteger(id) || id < 1) throw badRequest('商品编号不合法')

  const detail = (await getProductDetail(id, 'member')) as unknown as
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
