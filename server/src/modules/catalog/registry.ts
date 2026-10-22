// T-CAT-BE-001 — Public category registry (SPEC-CATALOG-OPS-001 §7.1).
//
// The registry is the ONLY public category list. It returns active categories
// only, ordered by (sortOrder ASC, id ASC), with a short-TTL Redis-backed cache
// (REQ-CAT-NF-002, CHK-PERF-001). Every category mutation bumps the registry
// generation via bumpCategoryRegistryCacheVersion() so public reads converge
// across instances without a process restart (REQ-CAT-NF-008, AC-CAT-026).
//
// Legacy `productTypes` is projected from the same active category rows and
// flagged `deprecated: true` — it is never read from the hard-coded
// businessRegistry anymore (D-CAT-05, §7.1).
//
// SPEC-CATALOG-VIS-001 §3.1/§3.4（P1-B）：registry 按 audience 输出。
// 受限分类（guestVisibility='members_only'）对游客完全不出现——不是把
// guestVisibility 字段带出去让前端隐藏，而是**整条记录不下发**：
// code/label/iconKey 以及兼容 productTypes 的 value/label 都属于方案
// §2.3 保护目标里的「分类元数据」，泄露任何一项都等于告知游客
// 「这里有个你无权查看的分类」。
//
// 缓存键必须含 audience：两个视角的记录集合不同，共用条目会让先到的
// 视角把结果喂给另一个。版本号仍是单一 generation——分类变更对两个
// audience 都必须失效，单一版本正好满足（见 bumpCategoryRegistryCacheVersion）。

import {
  bumpCacheVersion,
  getCacheVersion,
  makeCacheKey,
  wrapCache,
} from '../../lib/cache.js'
import { prisma } from '../../lib/prisma.js'
import { CATEGORY_STATUS } from './constants.js'
import type { CategoryRegistryItem, LegacyProductTypeCompat } from './contracts.js'
import {
  CATEGORY_GUEST_VISIBILITY,
  type CategoryGuestVisibility,
  type ProductAudience,
} from '../products/visibility.js'

export const CATEGORY_REGISTRY_CACHE_TTL_SEC = 60

export interface PublicCategoryRegistry {
  productCategories: CategoryRegistryItem[]
  productTypes: LegacyProductTypeCompat[]
}

/** Invalidate the public registry after any category mutation. */
export async function bumpCategoryRegistryCacheVersion(): Promise<void> {
  await bumpCacheVersion({ name: 'category-registry' })
}

async function buildRegistryCacheKey(audience: ProductAudience): Promise<string | null> {
  const version = await getCacheVersion({ name: 'category-registry' })
  if (version == null) return null
  // audience 参与键：guest 与 member 的可见分类集合不同（SPEC-CATALOG-VIS-001 §3.4）。
  return makeCacheKey('registry', 'product-categories', version, audience)
}

async function loadRegistry(audience: ProductAudience): Promise<PublicCategoryRegistry> {
  const rows = await prisma.productCategory.findMany({
    where: {
      status: CATEGORY_STATUS.ACTIVE,
      // 游客只拿到 public 分类；member 沿用原行为（全部 active 分类）。
      // 缺字段不默认公开：该条件由常量生成，非 optional 判定（§3.2）。
      ...(audience === 'guest'
        ? { guestVisibility: CATEGORY_GUEST_VISIBILITY.PUBLIC }
        : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      code: true,
      label: true,
      iconKey: true,
      sortOrder: true,
      guestVisibility: true,
    },
  })

  return {
    productCategories: rows.map(row => ({
      id: row.id,
      code: row.code,
      label: row.label,
      iconKey: row.iconKey,
      sortOrder: row.sortOrder,
      // 只对登录用户下发：游客要么不该看到该分类（已整条过滤），
      // 要么看到的是 public 分类，标出来无意义且多一处元数据出口。
      ...(audience === 'member'
        ? { guestVisibility: row.guestVisibility as CategoryGuestVisibility }
        : {}),
    })),
    productTypes: rows.map(row => ({
      value: row.label,
      label: row.label,
      deprecated: true as const,
    })),
  }
}

export async function getPublicCategoryRegistry(
  audience: ProductAudience = 'guest',
): Promise<PublicCategoryRegistry> {
  const key = await buildRegistryCacheKey(audience)
  if (!key) return loadRegistry(audience)
  return wrapCache(
    'category-registry',
    key,
    CATEGORY_REGISTRY_CACHE_TTL_SEC,
    () => loadRegistry(audience),
  )
}
