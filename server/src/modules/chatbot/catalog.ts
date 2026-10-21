import { badRequest, HttpError } from '../../lib/httpError.js'
import { listProducts, getProductDetail } from '../products/service.js'
import type { AvailabilityStatus } from '../products/publicAvailability.js'
import type { ProductAudience } from '../products/visibility.js'
import { PROJECTION_ERROR_CODES } from '../merchandising/publicProjection.js'

/**
 * SPEC-CHAT-BOT-001 / BOT-1 —— 机器人侧商品查询（只读）。
 *
 * 四条设计约束：
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
 *
 * 4. **视角由 audience 参数决定，本文件不自行假设身份。**
 *    历史实现固定传 `'member'`，理由是「HMAC 校验通过 ⇒ 面向已绑定用户」——
 *    这个推理是错的：HMAC 只证明请求来自受信机器人服务，不证明消息发送者
 *    是谁。任何能敲 `/搜索` 的 QQ 用户（含整个群）都拿到了 members_only
 *    商品的名称、价格、库存、商家、分类、描述。现在 audience 由
 *    chatbot/audience.ts 依据「私聊 + 已绑定 + 账号正常」判定，缺字段、
 *    群聊、未绑定、账号异常一律 guest（见 docs/specs/product-guest-visibility-ai-moderation.md §5）。
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
  /**
   * 调用方带来的游标与当前视角/筛选不匹配（PRODUCT_CURSOR_EXPIRED）。
   * 这是**可预期结果**而非服务异常：游标里钉着 filterHash，其中包含 audience，
   * 所以「member 时期翻到第 2 页，掉绑定后继续翻」必然不匹配。此时返回空列表
   * + 该标记，让机器人提示「请重新搜索」，而不是弹「服务异常」。
   */
  cursorExpired?: true
}

/**
 * 关键词搜索。空关键词返回默认列表，让用户在不
 * 知道买什么时也有东西可看。
 *
 * ⚠️ audience 由调用方按请求者身份传入（见 chatbot/audience.ts）。
 * 未绑定/群聊/缺字段必须传 'guest'；只有「私聊 + 已绑定 + 账号正常」才传
 * 'member'。不要在这里改回固定 'member'——那会重新打开 BOT-1 关掉的泄露路径。
 *
 * 关于覆盖面：guest 会带上 `visibility: 'public'` 过滤，所以 members_only
 * 商品不会出现在结果里。这是刻意的：这些商品只对登录用户可见，而机器人
 * 侧的请求者尚未证明自己是谁。受限商品的存在、数量、名称都不能出现在
 * 响应里，因此空结果是正常输出，不是错误。
 */
export async function searchProducts(params: {
  keyword?: unknown
  page?: unknown
  baseUrl: string
  audience: ProductAudience
  /** 上游传递的游标；与 audience 绑定，跨视角复用会失效。 */
  cursor?: unknown
}): Promise<BotSearchResult> {
  const keyword = normalizeKeyword(params.keyword)
  const page = normalizePage(params.page)
  const cursor = typeof params.cursor === 'string' && params.cursor ? params.cursor : undefined

  let result: Awaited<ReturnType<typeof listProducts>>
  try {
    result = await listProducts({
      query: keyword || undefined,
      page,
      pageSize: PAGE_SIZE,
      audience: params.audience,
      cursor,
    })
  } catch (err) {
    // 游标过期是契约的一部分（D-MERCH-07），不是服务故障。
    // 只收敛这一个可识别 code；其他错误（DB、缓存、探测）继续上抛。
    //
    // 用 String(err.code) 比较：PRODUCT_CURSOR_EXPIRED 是 merchandising
    // adapter 的错误码，属于共享 ErrorCode union 的超集（见 publicProjection.ts），
    // 直接与字面量比较会被 TS 判为无交集。
    if (err instanceof HttpError && String(err.code) === PROJECTION_ERROR_CODES.EXPIRED) {
      return { items: [], page, hasMore: false, cursorExpired: true }
    }
    throw err
  }

  const items = (result.items as unknown as SerializedListItem[]).map(item =>
    projectSummary(item, params.baseUrl)
  )

  return {
    items,
    page,
    hasMore: Boolean((result as { nextCursor?: string | null }).nextCursor),
  }
}

/**
 * 商品详情。
 *
 * 返回三种可区分的结果，调用方据此给出不同文案：
 *
 *   { kind: 'found' }         —— 当前视角可见，带完整投影
 *   { kind: 'not_found' }     —— 不存在 / 已归档 / 商家停用 / 草稿（原 404 契约）
 *   { kind: 'login_required' }—— 商品存在但仅登录可见，403 PRODUCT_LOGIN_REQUIRED
 *
 * 为什么把 403 单列出来而不是并进 404：用户拿到的编号是真实存在的商品，
 * 告诉他「不存在」会让他在群友面前被误导着反复重试。但「仅登录可见」
 * 这个结果本身**不得携带任何商品字段**（名称、价格、库存、商家、分类、
 * 图片、描述、ID 都不给）——只回答「这里有东西，但你得先登录」。
 *
 * ⚠️ 与仓库「不属于你的资源返回 404 而非 403」的通用原则的偏差是有意的：
 * 该原则防的是**枚举**，而这里的 403 结果不随商品是否存在而变化——只要
 * 是 members_only 且视角为 guest 就返回同一固定结构，不存在区分度泄露。
 */
export type BotProductDetailResult =
  | { kind: 'found'; product: BotProductDetail }
  | { kind: 'not_found' }
  | { kind: 'login_required' }

export async function productDetail(params: {
  id: unknown
  baseUrl: string
  audience: ProductAudience
}): Promise<BotProductDetailResult> {
  const id = Number(params.id)
  if (!Number.isInteger(id) || id < 1) throw badRequest('商品编号不合法')

  let detail: Awaited<ReturnType<typeof getProductDetail>>
  try {
    detail = await getProductDetail(id, params.audience)
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status === 404) return { kind: 'not_found' }
      if (err.status === 403 && err.code === 'PRODUCT_LOGIN_REQUIRED') {
        return { kind: 'login_required' }
      }
    }
    throw err
  }

  const row = detail as unknown as
    | (SerializedListItem & {
        description?: string | null
        images?: string[] | null
        sales?: number | null
      })
    | null
  if (!row) return { kind: 'not_found' }

  const summary = projectSummary(row, params.baseUrl)
  const images = Array.isArray(row.images) ? row.images : []

  return {
    kind: 'found',
    product: {
      ...summary,
      description: row.description ?? null,
      imageUrl: images.length > 0 ? images[0] : null,
      sales: row.sales ?? 0,
    },
  }
}
