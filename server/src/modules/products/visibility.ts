import { Prisma } from '@prisma/client'
import { HttpError, notFound } from '../../lib/httpError.js'
import { CATALOG_ERROR_CODES } from '../catalog/constants.js'
import type { AuthPayload } from '../../middlewares/auth.js'

/**
 * SPEC-CATALOG-VIS-001 §3.2/§3.3 —— 公开商品访问的统一判定。
 *
 * 游客可见 = 生命周期允许公开 + 商品 visibility=public + **分类 guestVisibility=public**。
 * 登录用户沿用原有规则（不看分类可见性、不看商品 visibility）。
 *
 * 四条路径必须等价：Prisma where、raw SQL 片段、详情断言、内存过滤。
 * 只改其中一条（典型是只改列表查询）会导致「列表里看不到、直接访问编号却能看到」，
 * 或者「详情拒绝、推荐里却出现」。因此：
 *
 * 1. 四条路径共用同一份条件语义，改动必须同时发生；
 * 2. 分类字段在类型上**必填**——见 PublicProductAccessRow。缺字段要让编译失败，
 *    不能靠 optional 的「缺省即公开」兼容旧调用方，那等于让漏查分类的调用方
 *    默认放行（§3.3 明确要求「缺字段的测试应失败，而不是静默跳过分类检查」）。
 */

export type ProductAudience = 'guest' | 'member'

/** 分类级游客可见性取值（与 ProductCategory.guestVisibility CHECK 约束一致）。 */
export const CATEGORY_GUEST_VISIBILITY = {
  PUBLIC: 'public',
  MEMBERS_ONLY: 'members_only',
} as const
export type CategoryGuestVisibility =
  (typeof CATEGORY_GUEST_VISIBILITY)[keyof typeof CATEGORY_GUEST_VISIBILITY]

/**
 * 访问判定所需的最小商品快照。
 *
 * `category` **不是** optional：任何构造该类型的地方都必须显式加载分类的
 * guestVisibility。把分类字段设成 optional 会让「忘查分类」编译通过并在运行时
 * 默认公开——这正是本功能最危险的失效方式。
 *
 * 商品自身的 `visibility` 与 `category` 都做「缺字段即不可公开」处理（见下方
 * readGuestVisibility/readCategoryGuestVisibility）：类型强制加载，运行期再兜一层，
 * 防止 via `as any` / 原始 SQL 投影绕过类型后静默公开。
 */
export type PublicProductAccessRow = {
  status: string
  archivedAt: Date | null
  visibility?: string | null
  merchantId?: number | null
  merchant?: { status: string } | null
  /** 必填：分类快照。缺分类视为不可公开，不默认公开。 */
  category: {
    id?: number
    guestVisibility: string | null
  } | null
}

export function resolveProductAudience(user: AuthPayload | undefined): ProductAudience {
  return user?.userId ? 'member' : 'guest'
}

/**
 * 商品自身的可见性；缺字段按 members_only（最严）处理，绝不默认 public。
 */
function readProductVisibility(product: { visibility?: string | null }): string {
  const raw = product.visibility
  if (raw === 'public' || raw === 'members_only') return raw
  return 'members_only'
}

/**
 * 分类的游客可见性；缺分类、缺字段、空值一律按 members_only 处理。
 *
 * 这是 §3.2「分类或必需访问字段缺失时不默认为公开」的落点。
 */
function readCategoryGuestVisibility(
  category: { guestVisibility: string | null } | null | undefined,
): string {
  const raw = category?.guestVisibility
  if (raw === CATEGORY_GUEST_VISIBILITY.PUBLIC) return CATEGORY_GUEST_VISIBILITY.PUBLIC
  return CATEGORY_GUEST_VISIBILITY.MEMBERS_ONLY
}

/** 游客视角是否要求该商品向游客公开（商品自身 + 分类两道门）。 */
function guestRequiresLogin(product: PublicProductAccessRow): boolean {
  if (readProductVisibility(product) !== 'public') return true
  if (readCategoryGuestVisibility(product.category) !== CATEGORY_GUEST_VISIBILITY.PUBLIC) return true
  return false
}

/* ------------------------------------------------------------------------- *
 * 路径 1：Prisma where（列表、按 id 批量补水、流量统计等）
 * ------------------------------------------------------------------------- */

export function publicVisibilityWhere(audience: ProductAudience): Prisma.ProductWhereInput {
  const base: Prisma.ProductWhereInput = {
    status: 'active',
    archivedAt: null,
    OR: [{ merchantId: null }, { merchant: { status: 'active' } }],
  }
  if (audience === 'guest') {
    return {
      ...base,
      visibility: 'public',
      // 分类 restriction 与商品 restriction 是 AND 关系：两者都要满足。
      // 分类缺失（不可能，categoryId NOT NULL 且关联存在）也在此被排除。
      category: { is: { guestVisibility: CATEGORY_GUEST_VISIBILITY.PUBLIC } },
    }
  }
  return base
}

/* ------------------------------------------------------------------------- *
 * 路径 2：raw SQL 片段（商品列表的 ranked 查询）
 * ------------------------------------------------------------------------- */

export function guestVisibilitySql(): Prisma.Sql {
  // 商品自身 + 分类两道门。别名 p = Product，c = ProductCategory
  // （由调用方的 INNER JOIN 提供；调用方必须 JOIN 分类，见 listRankedProductRows）。
  return Prisma.sql`(p."visibility" = 'public'
    AND c."guestVisibility" = ${CATEGORY_GUEST_VISIBILITY.PUBLIC})`
}

/**
 * 分类过滤的 SQL 片段生成器。与 guestVisibilitySql 分开导出，便于调用方在
 * 不同的 JOIN 形态下复用同一条件文本，避免各写一份而漂移。
 */
export function categoryGuestVisibilitySql(alias = 'c'): Prisma.Sql {
  // 别名来自本模块常量（非用户输入），此处仍是参数化写入以保持一致风格。
  return Prisma.sql`${Prisma.raw(`"${alias}"."guestVisibility"`)} = ${CATEGORY_GUEST_VISIBILITY.PUBLIC}`
}

export function merchantVisibleSql(): Prisma.Sql {
  return Prisma.sql`(p."merchantId" IS NULL OR EXISTS (
    SELECT 1 FROM "Merchant" m WHERE m."id" = p."merchantId" AND m."status" = 'active'
  ))`
}

/* ------------------------------------------------------------------------- *
 * 路径 3：详情断言（抛错）
 * ------------------------------------------------------------------------- */

export function assertPublicProductAccess(
  product: PublicProductAccessRow,
  audience: ProductAudience,
): void {
  if (product.status !== 'active' || product.archivedAt) {
    throw notFound('商品暂不可用')
  }
  if (product.merchantId != null && product.merchant?.status !== 'active') {
    throw notFound('商品暂不可用')
  }
  if (guestRequiresLogin(product) && audience === 'guest') {
    // 商品与分类的受限共用同一个 403 码与文案：错误体不得透露是「商品仅登录」
    // 还是「分类仅登录」，否则就成了分类元数据泄露（§3.2）。
    throw new HttpError(
      403,
      CATALOG_ERROR_CODES.PRODUCT_LOGIN_REQUIRED,
      '登录后查看商品',
    )
  }
}

/* ------------------------------------------------------------------------- *
 * 路径 4：内存过滤（缓存命中后的实时复核、推荐候选过滤）
 * ------------------------------------------------------------------------- */

export function isCurrentlyPubliclyVisible(
  product: PublicProductAccessRow,
  audience: ProductAudience,
): boolean {
  if (product.status !== 'active' || product.archivedAt) return false
  if (product.merchantId != null && product.merchant?.status !== 'active') return false
  if (guestRequiresLogin(product) && audience === 'guest') return false
  return true
}

/**
 * 分类是否对游客可见（registry、分类筛选等按分类维度输出时使用）。
 * 与商品侧同一语义：缺字段不默认公开。
 */
export function isCategoryGuestVisible(
  category: { guestVisibility: string | null; status?: string } | null | undefined,
): boolean {
  if (!category) return false
  if (category.status !== undefined && category.status !== 'active') return false
  return readCategoryGuestVisibility(category) === CATEGORY_GUEST_VISIBILITY.PUBLIC
}
