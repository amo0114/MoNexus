import type { Prisma } from '@prisma/client'
import { canonicalJson } from './externalCatalog.js'

/**
 * SPEC-CATALOG-VIS-001 §4.4 / §4.5（P1.5-A）——公开内容变更后的准入失效。
 *
 * 语义（与 §4.5.1 状态流转表一致）：
 *
 *   | 当前状态 | 触发 | 结果 |
 *   | 无记录   | 商品首次以 public 保存 | 创建 pending，reviewedRevision 为空 |
 *   | 任意状态 | 展示内容**确实变了** | pending，reviewedRevision 保持原值 |
 *
 * ⚠️ 判定依据是**值有没有变**，不是「字段有没有提交」（P1.5-A 复审修正）：
 * 商家/管理员的编辑表单通常整包提交，若按键存在判定，则「什么都没改就保存」
 * 也会把已批准商品打回待审核、对游客消失。§4.4 的原话是「哪些变化使批准失效」。
 * JSON 字段（details / attributes / images）按归一化后的内容比较，
 * 用仓库既有的 canonicalJson（键顺序无关）。
 *
 * ⚠️ 本模块是全部门禁安全性的**前提**：Prisma where 对游客只做粗筛
 * （存在 decision='approved' 的记录，无法跨表比较版本）。粗筛成立的条件是
 * **每一个展示类写入口都会把 decision 重置为 pending**——这样
 * `decision='approved'` 就等价于「版本匹配」。新增写入口时若漏接本模块，
 * 粗筛会放行「已批准但内容已改」的商品。新增 offer / product 写入前先 grep
 * 本文件的调用点，逐条判定是否属于展示类。
 */

/** 商品侧触发失效的展示字段（§4.4 第一段）。价格、库存、销量、评分不在其中。 */
export const PUBLIC_CONTENT_PRODUCT_FIELDS = [
  'name',
  'description',
  'richDescription',
  'details',
  'attributes',
  'categoryId',
  'type',
  'icon',
  'imageUrl',
  'images',
  'templateKey',
  'templateVersion',
  // visibility 单独处理（§4.4 第二段），见 PUBLIC_CONTENT_VISIBILITY_FIELD。
] as const

/**
 * 套餐侧触发失效的展示字段（§4.4「套餐名称/说明，以及新增或启用未审核套餐」）。
 *
 * 刻意**不含** price / stock / stockMode / deliveryMode / fixedContent*：
 * 它们是交易或履约配置，§4.4 明确价格与库存不触发；交付内容也不是游客看到的
 * 展示文案。含 status 是因为「启用未审核套餐」必须失效。
 */
export const PUBLIC_CONTENT_OFFER_FIELDS = [
  'name',
  // Offer 模型没有独立的 description 列（见 schema.prisma）：套餐的说明性
  // 文案承载在 attributes（P4b 交付字段模板的 label 等）里，因此这里列
  // attributes 而不是 description。
  'attributes',
  'status',
] as const

const VISIBILITY_FIELD = 'visibility'

/** JSON 字段按归一化内容比较，避免键顺序不同被误判为变更。 */
const JSON_FIELDS = new Set(['details', 'attributes', 'images'])

export type PublicContentField =
  | (typeof PUBLIC_CONTENT_PRODUCT_FIELDS)[number]
  | (typeof PUBLIC_CONTENT_OFFER_FIELDS)[number]
  | typeof VISIBILITY_FIELD

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 两个值在「展示内容」意义上是否等价。
 *
 * - JSON 字段：用 canonicalJson 归一化后比较（键顺序无关）；
 * - Date：按时间戳比较（Prisma 可能给出 Date 或 ISO 串）；
 * - 其余：严格相等（null 与 undefined 视为等价，避免「清空 vs 未设」误判）。
 */
export function publicContentValuesEqual(field: string, left: unknown, right: unknown): boolean {
  const leftEmpty = left === null || left === undefined
  const rightEmpty = right === null || right === undefined
  if (leftEmpty || rightEmpty) return leftEmpty && rightEmpty

  if (JSON_FIELDS.has(field)) {
    try {
      return canonicalJson(left) === canonicalJson(right)
    } catch {
      // 不可序列化的值（理论上不该出现）：保守判为「变了」，宁可多失效一次。
      return false
    }
  }

  if (left instanceof Date || right instanceof Date) {
    const l = left instanceof Date ? left.getTime() : new Date(String(left)).getTime()
    const r = right instanceof Date ? right.getTime() : new Date(String(right)).getTime()
    return l === r
  }

  return left === right
}

/**
 * 在**已持有商品行锁**的事务内，判断这次写入是否真的改变了商品的公开展示内容。
 *
 * 与旧版 `touchesPublicContent(data)` 的区别：那个只看 `data` 里有没有这个键，
 * 整包提交时无改动保存也会返回 true。这里读出当前行逐字段比较。
 *
 * @param data 即将写入的字段（Prisma update 的 data）
 */
export async function productPublicContentChanged(
  tx: Prisma.TransactionClient,
  productId: number,
  data: Record<string, unknown>,
): Promise<boolean> {
  const candidateFields = [
    ...PUBLIC_CONTENT_PRODUCT_FIELDS,
    VISIBILITY_FIELD,
  ].filter(field => Object.prototype.hasOwnProperty.call(data, field))

  if (candidateFields.length === 0) return false

  // 只取需要的列；用 select 逐字段列出，避免把整行读进内存。
  const select: Record<string, true> = {}
  for (const field of candidateFields) select[field] = true

  const current = await tx.product.findUnique({
    where: { id: productId },
    select: select as Prisma.ProductSelect,
  })
  if (!current) return false

  for (const field of candidateFields) {
    const currentValue = (current as Record<string, unknown>)[field]
    const nextValue = data[field]
    // Prisma 的原子操作（如 { increment: 1 }）不是字面值：视为「变了」，
    // 因为无法在不执行的情况下得知结果。当前展示字段不会用这种写法，
    // 出现即为新调用方的信号。
    if (isPlainObject(nextValue) && !JSON_FIELDS.has(field)) {
      const keys = Object.keys(nextValue)
      if (keys.some(key => ['increment', 'decrement', 'multiply', 'divide', 'set'].includes(key))) {
        return true
      }
    }
    if (!publicContentValuesEqual(field, currentValue, nextValue)) return true
  }
  return false
}

/**
 * 在**已持有商品行锁**的事务内，判断这次套餐写入是否真的改变了公开展示内容。
 *
 * 覆盖 §4.4 的「套餐名称/说明，以及新增或启用未审核套餐」：
 * - `name` / `description` / `attributes` 变化 → 失效；
 * - `status` 由非 active 变为 active（启用未审核套餐）→ 失效；
 * - 纯价格/库存/交付配置 → 不失效。
 */
export async function offerPublicContentChanged(
  tx: Prisma.TransactionClient,
  offerId: number,
  data: Record<string, unknown>,
): Promise<boolean> {
  const candidateFields = PUBLIC_CONTENT_OFFER_FIELDS
    .filter(field => Object.prototype.hasOwnProperty.call(data, field))

  if (candidateFields.length === 0) return false

  const current = await tx.offer.findUnique({
    where: { id: offerId },
    select: { name: true, attributes: true, status: true },
  })
  if (!current) return false

  const nextStatus = Object.prototype.hasOwnProperty.call(data, 'status') ? data.status : current.status
  // Only enabling counts: taking an offer offline removes content guests could see,
  // so it must not revoke the product's approval.
  if (current.status !== 'active' && nextStatus === 'active') return true
  // Edits to an offer that stays offline are not visible to guests; enabling it later
  // is what triggers review.
  if (nextStatus !== 'active') return false

  for (const field of candidateFields) {
    if (field === 'status') continue
    const currentValue = (current as Record<string, unknown>)[field]
    const nextValue = data[field]
    if (!publicContentValuesEqual(field, currentValue, nextValue)) return true
  }
  return false
}

/** 新建套餐时是否属于「新增未审核套餐」：只有直接启用才需要失效。 */
export function newOfferNeedsInvalidation(data: { status?: unknown }): boolean {
  return data.status === 'active'
}

export interface GuestEligibilityInvalidation {
  publicContentRevision: number
  decision: 'pending'
  created: boolean
}

/**
 * 递增商品公开内容版本，并把准入记录重置为 pending。**必须在调用方已持有
 * 商品行锁（lockProductRow）的事务内调用。**
 */
export async function invalidateGuestEligibility(
  tx: Prisma.TransactionClient,
  productId: number,
): Promise<GuestEligibilityInvalidation> {
  const updated = await tx.product.update({
    where: { id: productId },
    data: { publicContentRevision: { increment: 1 } },
    select: { publicContentRevision: true },
  })

  const existing = await tx.productGuestEligibility.findUnique({
    where: { productId },
    select: { id: true },
  })

  if (!existing) {
    await tx.productGuestEligibility.create({
      data: { productId, decision: 'pending', reviewedRevision: null },
    })
    return { publicContentRevision: updated.publicContentRevision, decision: 'pending', created: true }
  }

  await tx.productGuestEligibility.update({
    where: { productId },
    data: {
      decision: 'pending',
      version: { increment: 1 },
      reasonCode: 'content_changed',
      // reviewedRevision 保留原值——它记录"上次审的是哪一版"。
    },
  })
  return { publicContentRevision: updated.publicContentRevision, decision: 'pending', created: false }
}

/**
 * 商品写入的便捷封装：**值确实变了**才失效。
 *
 * 返回 null 表示本次写入不影响公开审核状态（价格/库存/销量，或整包提交但
 * 内容与现状一致）。
 */
export async function invalidateGuestEligibilityIfNeeded(
  tx: Prisma.TransactionClient,
  productId: number,
  data: Record<string, unknown>,
): Promise<GuestEligibilityInvalidation | null> {
  if (!(await productPublicContentChanged(tx, productId, data))) return null
  return invalidateGuestEligibility(tx, productId)
}

/**
 * 套餐写入的便捷封装：展示字段变化或**启用**时失效。
 *
 * 调用方必须已持有该套餐所属商品的商品行锁（§4.5 统一锁顺序：先商品）。
 */
export async function invalidateGuestEligibilityForOfferChange(
  tx: Prisma.TransactionClient,
  productId: number,
  offerId: number,
  data: Record<string, unknown>,
): Promise<GuestEligibilityInvalidation | null> {
  if (!(await offerPublicContentChanged(tx, offerId, data))) return null
  return invalidateGuestEligibility(tx, productId)
}

/** 新建套餐：仅当直接启用时失效。 */
export async function invalidateGuestEligibilityForNewOffer(
  tx: Prisma.TransactionClient,
  productId: number,
  offer: { status?: unknown },
): Promise<GuestEligibilityInvalidation | null> {
  if (!newOfferNeedsInvalidation(offer)) return null
  return invalidateGuestEligibility(tx, productId)
}
