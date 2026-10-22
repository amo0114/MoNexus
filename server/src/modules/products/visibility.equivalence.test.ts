import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { getActiveNetworkNodeCategoryId } from '../../__tests__/catalogFixture.js'
import {
  assertPublicProductAccess,
  CATEGORY_GUEST_VISIBILITY,
  guestVisibilitySql,
  isCurrentlyPubliclyVisible,
  publicVisibilityWhere,
  type ProductAudience,
  type PublicProductAccessRow,
} from './visibility.js'

/**
 * SPEC-CATALOG-VIS-001 §3.3 —— 四条访问路径的等价性测试。
 *
 * 这一层的存在理由：访客门禁写在四个不同的表达里
 *   1. publicVisibilityWhere   —— Prisma where（列表、批量补水、流量统计）
 *   2. guestVisibilitySql      —— raw SQL 片段（排名查询）
 *   3. assertPublicProductAccess —— 详情/评价/推荐的抛错断言
 *   4. isCurrentlyPubliclyVisible —— 缓存命中后的内存复核
 *
 * 只改其中一条，就会出现「列表看不到、直接输编号却能看到」或
 * 「详情拒绝、推荐里却出现」。手工逐条核对四个函数不现实，所以把同一批
 * 样例同时喂给四条路径，用它们的**交叉一致**来锁死语义。
 *
 * 覆盖维度（笛卡尔积）：
 *   商品 visibility × 分类 guestVisibility × 生命周期 × 商家状态 × audience
 */

type Case = {
  name: string
  visibility: string
  categoryVisibility: string
  status: string
  archived: boolean
  merchantStatus: 'active' | 'suspended' | null
  audience: ProductAudience
  /** SPEC-CATALOG-VIS-001 §4.2（P1.5）：准入状态维度。 */
  eligibility: 'none' | 'pending' | 'approved_matching' | 'approved_stale' | 'denied'
  /** 期望：该样例对游客/该 audience 是否可见。 */
  expectedVisible: boolean
}

const LIFECYCLES = [
  { status: 'active', archived: false, label: 'active' },
  { status: 'draft', archived: false, label: 'draft' },
  { status: 'inactive', archived: false, label: 'inactive' },
  { status: 'active', archived: true, label: 'archived' },
] as const

/**
 * SPEC-CATALOG-VIS-001 §4.3/§4.5.1 准入状态维度。
 * approved_stale 模拟「批准了 v1、内容已改到 v2」——必须失效。
 */
const ELIGIBILITY_STATES = [
  'none',
  'pending',
  'approved_matching',
  'approved_stale',
  'denied',
] as const

const MERCHANT_STATES = [
  { merchantStatus: null, label: 'platform' },
  { merchantStatus: 'active', label: 'active-merchant' },
  { merchantStatus: 'suspended', label: 'suspended-merchant' },
] as const

/**
 * 期望值的单一来源。四条路径都对不上它时，说明**规则本身**被改了，
 * 而不是某条路径漂移——两种失败要能区分开。
 */
function computeExpected(c: Omit<Case, 'expectedVisible'>): boolean {
  // 生命周期：非 active 或已归档 → 任何 audience 都不可见。
  if (c.status !== 'active' || c.archived) return false
  // 商家异常 → 不可见（沿用既有规则）。
  if (c.merchantStatus === 'suspended') return false
  // member 视角不看 visibility / 分类可见性（沿用既有规则）。
  if (c.audience === 'member') return true
  // guest：商品必须 public、分类必须 public、且当前内容版本已获批准。
  if (c.visibility !== 'public') return false
  if (c.categoryVisibility !== CATEGORY_GUEST_VISIBILITY.PUBLIC) return false
  // 准入：只有 approved + 版本匹配才放行（§4.2）。
  // pending / denied / 无记录 / 已批准但内容已改，一律不对游客展示。
  if (c.eligibility !== 'approved_matching') return false
  return true
}

function buildCases(): Case[] {
  const cases: Case[] = []
  for (const visibility of ['public', 'members_only']) {
    for (const categoryVisibility of [CATEGORY_GUEST_VISIBILITY.PUBLIC, CATEGORY_GUEST_VISIBILITY.MEMBERS_ONLY]) {
      for (const lifecycle of LIFECYCLES) {
        for (const merchant of MERCHANT_STATES) {
          for (const audience of ['guest', 'member'] as ProductAudience[]) {
            // 准入维度只在 audience=guest 时影响结果（member 不看准入），
            // 但仍全部枚举——这样若有人误把准入判断加进 member 分支，
            // 等价性测试会立刻发现。
            for (const eligibility of ELIGIBILITY_STATES) {
              const base = {
                name: `${visibility}/${categoryVisibility}/${lifecycle.label}/${merchant.label}/${audience}/${eligibility}`,
                visibility,
                categoryVisibility,
                status: lifecycle.status,
                archived: lifecycle.archived,
                merchantStatus: merchant.merchantStatus,
                audience,
                eligibility,
              }
              cases.push({ ...base, expectedVisible: computeExpected(base) })
            }
          }
        }
      }
    }
  }
  return cases
}

const CASES = buildCases()

/** 已批准且版本匹配的准入快照，供手工构造用例复用（其他维度默认通过）。 */
const APPROVED_ELIGIBILITY = { decision: 'approved', reviewedRevision: 1 } as const

/**
 * 分类行的 createdByUserId/updatedByUserId 是 Restrict 外键，必须指向真实用户。
 * 复用现有用户，没有就建一个记账 actor（仅为外键存在，不代表任何业务身份）。
 */
async function seedActorId(): Promise<number> {
  // 刻意**不做跨测试缓存**：setup.ts 在每个 test 前 TRUNCATE "User" 并
  // RESTART IDENTITY，任何缓存的 id 到了下个 test 都是失效外键
  // （catalogFixture.ts 顶部对此有同样的说明）。
  const actor = await prisma.user.upsert({
    where: { email: 'vis-eq-actor@test.local' },
    update: {},
    create: { email: 'vis-eq-actor@test.local', password: 'x', role: 'admin' },
    select: { id: true },
  })
  return actor.id
}

/**
 * 并发播种前的**一次性**取 actor。
 *
 * ⚠️ P1-B 复审发现：原实现让每个 seedCase 各自 upsert 同一 email，而样板是
 * `Promise.all` 并发的——Postgres 的 INSERT … ON CONFLICT 在并发下仍可能让
 * 多个事务同时进入插入路径，其中一个拿到唯一约束冲突（CI 上稳定复现：
 * `Unique constraint failed on the fields: (email)`）。本地偶发，CI 必现。
 *
 * 修法是把 actor 的创建提到并发之外，只做一次；并发部分只做纯 create。
 */
let actorIdPromise: Promise<number> | null = null
function ensureActorId(): Promise<number> {
  actorIdPromise ??= seedActorId()
  return actorIdPromise
}


/** 造一条真实数据库记录，返回 id 与可直接喂给内存判定的快照。 */
async function seedCase(
  index: number,
  c: Case,
): Promise<{ productId: number; row: PublicProductAccessRow }> {
  // 每个组合一个独立分类，避免同批用例互相影响分类可见性。
  // actor 由 ensureActorId() 串行提供（见上方说明），此处不再各自 upsert。
  const actorId = await ensureActorId()
  const category = await prisma.productCategory.create({
    data: {
      code: `vis-eq-${index}`,
      label: `等价性分类${index}`,
      normalizedLabel: `等价性分类${index}`.toLowerCase(),
      guestVisibility: c.categoryVisibility,
      status: 'active',
      createdByUserId: actorId,
      updatedByUserId: actorId,
    },
  })

  let merchantId: number | null = null
  if (c.merchantStatus) {
    const merchantUser = await prisma.user.create({
      data: {
        email: `vis-eq-merchant-${index}@test.local`,
        password: 'x',
        role: 'merchant',
      },
    })
    const merchant = await prisma.merchant.create({
      data: {
        userId: merchantUser.id,
        name: `等价性商家${index}`,
        status: c.merchantStatus,
        commissionRate: 0.1,
      },
    })
    merchantId = merchant.id
  }

  const product = await prisma.product.create({
    data: {
      name: `等价性商品${index}`,
      type: '网络节点',
      categoryId: category.id,
      price: 10,
      stock: 1,
      status: c.status,
      archivedAt: c.archived ? new Date() : null,
      visibility: c.visibility,
      merchantId,
    },
  })

  // SPEC-CATALOG-VIS-001 §4.2/§4.5.1：按维度播种准入记录。
  //   none             → 不建记录（§4.3「无记录一律不展示」）
  //   pending/denied   → 有记录但不是 approved
  //   approved_matching→ approved 且 reviewedRevision == 当前版本
  //   approved_stale   → approved 但版本落后（内容已改，批准失效）
  let eligibilityRow: { decision: string; reviewedRevision: number | null } | null = null
  if (c.eligibility !== 'none') {
    const decision = c.eligibility === 'pending'
      ? 'pending'
      : c.eligibility === 'denied'
        ? 'denied'
        : 'approved'
    // approved_stale：把商品版本推到 2，但记录仍指 1。
    if (c.eligibility === 'approved_stale') {
      await prisma.product.update({
        where: { id: product.id },
        data: { publicContentRevision: 2 },
      })
    }
    await prisma.productGuestEligibility.create({
      data: {
        productId: product.id,
        decision,
        reviewedRevision: decision === 'approved' ? 1 : null,
        reasonCode: c.eligibility === 'denied' ? 'rejected' : null,
      },
    })
    eligibilityRow = {
      decision,
      reviewedRevision: decision === 'approved' ? 1 : null,
    }
  }

  const currentRevision = c.eligibility === 'approved_stale' ? 2 : 1

  const row: PublicProductAccessRow = {
    status: c.status,
    archivedAt: c.archived ? new Date() : null,
    visibility: c.visibility,
    merchantId,
    merchant: c.merchantStatus ? { status: c.merchantStatus } : null,
    category: { id: category.id, guestVisibility: c.categoryVisibility },
    publicContentRevision: currentRevision,
    guestEligibility: eligibilityRow,
  }

  return { productId: product.id, row }
}

describe('SPEC-CATALOG-VIS-001 §3.3 四条路径等价性', () => {
  it('同一组样例在四条路径上的可见性判定完全一致', async () => {
    // 本 test 前 table 被 TRUNCATE，旧的 actorPromise 若存在必然失效。
    actorIdPromise = null
    const rows = await Promise.all(CASES.map((c, i) => seedCase(i, c)))

    const mismatches: string[] = []
    // Prisma where 只做粗筛，只校验「不遗漏应可见商品」这一侧。
    const supersetViolations: string[] = []
    for (const [i, c] of CASES.entries()) {
      const { productId, row } = rows[i]

      // 路径 1：Prisma where
      const prismaHit = await prisma.product.findFirst({
        where: { id: productId, ...publicVisibilityWhere(c.audience) },
        select: { id: true },
      })
      const byPrisma = prismaHit !== null

      // 路径 2：raw SQL 片段（与列表查询同一形状：JOIN 分类 + 别名 p/c）
      const sqlRows = await prisma.$queryRaw<Array<{ id: number }>>`
        SELECT p."id" FROM "Product" p
        INNER JOIN "ProductCategory" c ON c."id" = p."categoryId"
        WHERE p."id" = ${productId}
          AND p."status" = 'active' AND p."archivedAt" IS NULL
          AND (p."merchantId" IS NULL OR EXISTS (
            SELECT 1 FROM "Merchant" m WHERE m."id" = p."merchantId" AND m."status" = 'active'
          ))
          ${c.audience === 'guest' ? Prisma.sql`AND ${guestVisibilitySql()}` : noGuestFilter()}
      `
      const bySql = sqlRows.length > 0

      // 路径 3：详情断言（抛错 = 不可见）
      let byAssert = true
      try {
        assertPublicProductAccess(row, c.audience)
      } catch {
        byAssert = false
      }

      // 路径 4：内存过滤
      const byMemory = isCurrentlyPubliclyVisible(row, c.audience)

      // 三条**精确**路径必须互相一致，且等于期望值。
      // 路径 1（Prisma where）刻意不参与这个等式：它只能表达「存在 approved
      // 记录」这层粗筛，无法比较 reviewedRevision 与 publicContentRevision
      // （上面已说明原因）。把它算进去等于假装它精确。
      const exact = { bySql, byAssert, byMemory }
      const allSame = new Set(Object.values(exact)).size === 1
      if (!allSame || byMemory !== c.expectedVisible) {
        mismatches.push(
          `${c.name}: expected=${c.expectedVisible} sql=${bySql} assert=${byAssert} memory=${byMemory} (prisma-coarse=${byPrisma})`,
        )
      }

      // 路径 1 的不变式：它只能是**超集**——不允许出现「Prisma 说没有、
      // 精确路径说有」的情况（那意味着 where 比规则更严，会漏掉合法商品）。
      if (!byPrisma && c.expectedVisible) {
        supersetViolations.push(`${c.name}: prisma 漏掉了应可见商品（where 过严）`)
      }
    }

    expect(mismatches).toEqual([])
    expect(supersetViolations).toEqual([])
  })

  it('分类受限时，商品自身 public 也不对游客可见（双向都要拦）', async () => {
    // 同上：本 test 前 User 表已 TRUNCATE，清掉可能失效的 actor 缓存。
    actorIdPromise = null
    const actorId = await ensureActorId()
    const category = await prisma.productCategory.create({
      data: {
        code: 'vis-eq-locked-cat',
        label: '受限分类',
        normalizedLabel: '受限分类',
        guestVisibility: CATEGORY_GUEST_VISIBILITY.MEMBERS_ONLY,
        status: 'active',
        createdByUserId: actorId,
        updatedByUserId: actorId,
      },
    })
    const product = await prisma.product.create({
      data: {
        name: '公开商品但在受限分类',
        type: '网络节点',
        categoryId: category.id,
        price: 10,
        stock: 1,
        status: 'active',
        visibility: 'public',
      },
    })

    const guestList = await prisma.product.findMany({
      where: { id: product.id, ...publicVisibilityWhere('guest') },
      select: { id: true },
    })
    expect(guestList).toEqual([])

    const memberList = await prisma.product.findMany({
      where: { id: product.id, ...publicVisibilityWhere('member') },
      select: { id: true },
    })
    expect(memberList).toEqual([{ id: product.id }])
  })

  it('缺分类快照时不默认公开（§3.2 缺失字段不得放行）', () => {
    const rowWithoutCategory = {
      status: 'active',
      archivedAt: null,
      visibility: 'public',
      merchantId: null,
      merchant: null,
      category: null,
    } as PublicProductAccessRow

    expect(isCurrentlyPubliclyVisible(rowWithoutCategory, 'guest')).toBe(false)
    expect(() => assertPublicProductAccess(rowWithoutCategory, 'guest')).toThrow()
    // member 不受影响：沿用既有登录用户规则。
    expect(isCurrentlyPubliclyVisible(rowWithoutCategory, 'member')).toBe(true)
  })

  it('分类 guestVisibility 为空字符串等非法值时按受限处理，不默认公开', () => {
    const base = {
      status: 'active',
      archivedAt: null,
      visibility: 'public',
      merchantId: null,
      merchant: null,
    }
    for (const value of ['', 'PUBLIC', 'public ', 'unknown', null]) {
      const row: PublicProductAccessRow = {
        ...base,
        category: { guestVisibility: value },
        publicContentRevision: 1,
        guestEligibility: APPROVED_ELIGIBILITY,
      }
      expect(isCurrentlyPubliclyVisible(row, 'guest'), `value=${String(value)}`).toBe(false)
    }
  })

  it('商品 visibility 缺失时按 members_only 处理，不默认公开', () => {
    const row: PublicProductAccessRow = {
      status: 'active',
      archivedAt: null,
      visibility: null,
      merchantId: null,
      merchant: null,
      category: { guestVisibility: CATEGORY_GUEST_VISIBILITY.PUBLIC },
      publicContentRevision: 1,
      guestEligibility: APPROVED_ELIGIBILITY,
    }
    expect(isCurrentlyPubliclyVisible(row, 'guest')).toBe(false)
  })

  it('分类放开不会给已受限商品放行（两道门是 AND，不是 OR）', async () => {
    const categoryId = await getActiveNetworkNodeCategoryId()
    // 分类是 public（seed 默认），但商品 members_only。
    const product = await prisma.product.create({
      data: {
        name: '会员商品在公开分类',
        type: '网络节点',
        categoryId,
        price: 10,
        stock: 1,
        status: 'active',
        visibility: 'members_only',
      },
    })

    expect(isCurrentlyPubliclyVisible({
      status: 'active',
      archivedAt: null,
      visibility: 'members_only',
      merchantId: null,
      merchant: null,
      category: { guestVisibility: CATEGORY_GUEST_VISIBILITY.PUBLIC },
      publicContentRevision: 1,
      guestEligibility: APPROVED_ELIGIBILITY,
    }, 'guest')).toBe(false)

    const guestList = await prisma.product.findMany({
      where: { id: product.id, ...publicVisibilityWhere('guest') },
      select: { id: true },
    })
    expect(guestList).toEqual([])
  })
})

/**
 * 非游客请求不追加分类/商品过滤片段（保持原查询语义）。
 * 与 guestVisibilitySql 一样自带前导 AND，保证片段可被无条件拼接。
 */
function noGuestFilter(): Prisma.Sql {
  return Prisma.sql`AND 1=1`
}
