import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import {
  RECOMMENDATION_POLICIES,
  findRecommendationPolicy,
  normalizedStringAttribute,
  RECOMMENDATION_CANDIDATE_LIMIT,
  queryRecommendationCandidates,
  type RecommendationAdmission,
  type RecommendationCandidate,
} from './recommendations.js'
import { merchantVisibleSql } from './visibility.js'

/**
 * Read-only recommendation data-quality audit (PLAN-PRODUCT-AVAILABILITY-001 §9 PR2).
 *
 * Facts only: it never writes, never cleans data and never changes ranking rules. Every
 * "suspected" grouping is a lead for manual review, not a merge proposal. It reads catalog
 * metadata only (names, categories, template attributes, import links) — no inventory
 * content, fixed delivery content, orders or buyer data — and never calls Xboard.
 */

/** Same cap as the endpoint; slot statistics are measured before the availability filter. */
const DISPLAY_SLOTS = 6
const NAME_KEYS = ['serviceName', 'contentCategory'] as const
type NameKey = (typeof NAME_KEYS)[number]
// Period/plan/version words that suggest an imported name mixes offer terms into the service.
const IMPORT_NAME_TERMS = /(月付|季付|半年付|年付|月卡|季卡|年卡|包月|包年|\d+\s*(天|个月|月|年)|周期|套餐|版本|v\d+)/i

export interface RecommendationAuditOptions {
  /** Max samples per list; keeps the report reviewable. */
  sampleLimit?: number
  now?: Date
  /** Adds the offline C0/C1/C2 admission comparison (PLAN-RECOMMENDATION-LOCAL-QUALITY-001 §5.3). */
  compare?: boolean
}

type ScopeRow = {
  id: number
  name: string
  categoryId: number
  categoryCode: string
  categoryLabel: string
  merchantId: number | null
  merchantName: string | null
  visibility: string
  templateKey: string | null
  templateVersion: number | null
  hasActiveOffer: boolean
  hasFakaOffer: boolean
  importProvider: string | null
  serviceNameRaw: string | null
  serviceNameNormalized: string | null
  contentCategoryRaw: string | null
  contentCategoryNormalized: string | null
}

async function loadScope(): Promise<ScopeRow[]> {
  const raw = (key: NameKey) => Prisma.sql`CASE WHEN jsonb_typeof(p."attributes" -> ${key}::text) = 'string'
    THEN p."attributes" ->> ${key}::text END`
  return prisma.$queryRaw<ScopeRow[]>`
    SELECT
      p."id", p."name", p."categoryId", c."code" AS "categoryCode", c."label" AS "categoryLabel",
      p."merchantId", m."name" AS "merchantName", p."visibility", p."templateKey", p."templateVersion",
      EXISTS (SELECT 1 FROM "Offer" o WHERE o."productId" = p."id" AND o."status" = 'active') AS "hasActiveOffer",
      EXISTS (
        SELECT 1 FROM "Offer" o WHERE o."productId" = p."id" AND o."externalIntegration" = 'faka_bridge'
      ) AS "hasFakaOffer",
      l."provider" AS "importProvider",
      ${raw('serviceName')} AS "serviceNameRaw",
      ${normalizedStringAttribute('p', 'serviceName')} AS "serviceNameNormalized",
      ${raw('contentCategory')} AS "contentCategoryRaw",
      ${normalizedStringAttribute('p', 'contentCategory')} AS "contentCategoryNormalized"
    FROM "Product" p
    INNER JOIN "ProductCategory" c ON c."id" = p."categoryId"
    LEFT JOIN "Merchant" m ON m."id" = p."merchantId"
    LEFT JOIN "ExternalCatalogLink" l ON l."productId" = p."id"
    WHERE p."status" = 'active' AND p."archivedAt" IS NULL AND ${merchantVisibleSql()}
    ORDER BY p."id"
  `
}

function templateLabel(row: Pick<ScopeRow, 'templateKey' | 'templateVersion'>): string {
  const policy = findRecommendationPolicy(row.templateKey, row.templateVersion)
  return policy ? `${policy.key}@${policy.version}` : 'legacy/unknown'
}

function share(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 10_000) / 10_000
}

/**
 * Heuristic key for *suspected* synonyms only: broader than the ranking rule (NFKC, case,
 * whitespace and punctuation). Values sharing it are listed for manual review; the ranking
 * rule itself (ASCII trim + ASCII case fold) is untouched.
 */
function looseKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function nameDistribution(rows: ScopeRow[], key: NameKey, sampleLimit: number) {
  const usesKey = RECOMMENDATION_POLICIES.filter(policy => policy.primary === key)
    .map(policy => `${policy.key}@${policy.version}`)
  const relevant = rows.filter(row => usesKey.includes(templateLabel(row)))
  const rawField = key === 'serviceName' ? 'serviceNameRaw' : 'contentCategoryRaw'
  const normalizedField = key === 'serviceName' ? 'serviceNameNormalized' : 'contentCategoryNormalized'

  const byNormalized = new Map<string, Map<string, number>>()
  let missing = 0
  for (const row of relevant) {
    const normalized = row[normalizedField]
    if (normalized == null) {
      missing += 1
      continue
    }
    const spellings = byNormalized.get(normalized) ?? new Map<string, number>()
    const raw = row[rawField] ?? ''
    spellings.set(raw, (spellings.get(raw) ?? 0) + 1)
    byNormalized.set(normalized, spellings)
  }
  const values = [...byNormalized.entries()]
    .map(([normalized, spellings]) => ({
      normalized,
      count: [...spellings.values()].reduce((sum, count) => sum + count, 0),
      spellings: [...spellings.entries()].map(([raw, count]) => ({ raw, count })).sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.count - a.count || a.normalized.localeCompare(b.normalized))

  const byLoose = new Map<string, string[]>()
  for (const { normalized } of values) {
    const loose = looseKey(normalized)
    if (!loose) continue
    byLoose.set(loose, [...(byLoose.get(loose) ?? []), normalized])
  }
  const looseGroups = [...byLoose.values()].filter(group => group.length > 1)
  const containment: Array<{ shorter: string; longer: string }> = []
  for (const a of values) {
    for (const b of values) {
      const shorter = looseKey(a.normalized)
      const longer = looseKey(b.normalized)
      if (a !== b && shorter.length >= 2 && longer.length > shorter.length && longer.includes(shorter)) {
        containment.push({ shorter: a.normalized, longer: b.normalized })
      }
    }
  }

  return {
    templates: usesKey,
    productsWithKey: relevant.length,
    missing,
    distinctNormalized: values.length,
    values: values.slice(0, sampleLimit),
    valuesTruncated: values.length > sampleLimit,
    // Leads for manual review only (status: 待确认); never merged automatically.
    suspectedSynonyms: {
      looseNormalization: looseGroups.slice(0, sampleLimit).map(group => ({ values: group, status: '待确认' })),
      containment: containment.slice(0, sampleLimit).map(pair => ({ ...pair, status: '待确认' })),
    },
  }
}

function completeness(rows: ScopeRow[]) {
  const groups = new Map<string, ScopeRow[]>()
  for (const row of rows) {
    const key = `${row.categoryId}|${templateLabel(row)}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.values()]
    .map(group => {
      const first = group[0]
      const policy = findRecommendationPolicy(first.templateKey, first.templateVersion)
      const primary = policy?.primary ?? null
      const present = primary
        ? group.filter(row =>
            (primary === 'serviceName' ? row.serviceNameNormalized : row.contentCategoryNormalized) != null,
          ).length
        : null
      return {
        categoryCode: first.categoryCode,
        categoryLabel: first.categoryLabel,
        template: templateLabel(first),
        products: group.length,
        withActiveOffer: group.filter(row => row.hasActiveOffer).length,
        // null: template has no primary key (manual_service/appointment) or is legacy/unknown.
        primaryKey: primary,
        primaryPresent: present,
        primaryMissing: present == null ? null : group.length - present,
      }
    })
    .sort((a, b) => a.categoryCode.localeCompare(b.categoryCode) || b.products - a.products)
}

function legacyShare(rows: ScopeRow[]) {
  const legacy = rows.filter(row => templateLabel(row) === 'legacy/unknown')
  const byCategory = new Map<string, { categoryLabel: string; products: number; legacy: number }>()
  for (const row of rows) {
    const entry = byCategory.get(row.categoryCode) ?? { categoryLabel: row.categoryLabel, products: 0, legacy: 0 }
    entry.products += 1
    if (templateLabel(row) === 'legacy/unknown') entry.legacy += 1
    byCategory.set(row.categoryCode, entry)
  }
  return {
    products: rows.length,
    legacyOrUnknown: legacy.length,
    share: share(legacy.length, rows.length),
    byCategory: [...byCategory.entries()]
      .map(([categoryCode, entry]) => ({ categoryCode, ...entry, share: share(entry.legacy, entry.products) }))
      .sort((a, b) => b.legacy - a.legacy),
  }
}

type Slot = RecommendationCandidate & { sameSeller: boolean }

async function recommendationSlots(rows: ScopeRow[], sampleLimit: number) {
  const rowById = new Map(rows.map(row => [row.id, row]))
  const filled = Array.from({ length: DISPLAY_SLOTS + 1 }, () => 0)
  const slotTiers = { sameSeller: { 3: 0, 2: 0, 1: 0 }, otherSeller: { 3: 0, 2: 0, 1: 0 } }
  let weakPlaceholderBases = 0
  let displacedStrongSlots = 0
  const weakSamples: unknown[] = []
  const underfilledSamples: unknown[] = []

  for (const base of rows) {
    // Members see the widest catalog (most products are members_only); guests see a subset.
    const [same, other] = await Promise.all([
      queryRecommendationCandidates(base, 'member', true),
      queryRecommendationCandidates(base, 'member', false),
    ])
    const ranked: Slot[] = [
      ...same.map(row => ({ ...row, sameSeller: true })),
      ...other.map(row => ({ ...row, sameSeller: false })),
    ]
    const shown = ranked.slice(0, DISPLAY_SLOTS)
    filled[shown.length] += 1
    for (const slot of shown) {
      const bucket = slot.sameSeller ? slotTiers.sameSeller : slotTiers.otherSeller
      bucket[slot.tier as 1 | 2 | 3] += 1
    }

    if (shown.length < DISPLAY_SLOTS && underfilledSamples.length < sampleLimit) {
      underfilledSamples.push({
        productId: base.id,
        name: base.name,
        category: base.categoryLabel,
        template: templateLabel(base),
        slots: shown.length,
      })
    }

    // Same-seller weak matches occupying slots while stronger cross-seller matches are cut off.
    const weakSame = shown.filter(slot => slot.sameSeller && slot.tier < 3)
    const strongCutOff = ranked.slice(DISPLAY_SLOTS).filter(slot => !slot.sameSeller && slot.tier === 3)
    if (weakSame.length > 0 && strongCutOff.length > 0) {
      weakPlaceholderBases += 1
      displacedStrongSlots += Math.min(weakSame.length, strongCutOff.length)
      if (weakSamples.length < sampleLimit) {
        const describe = (slot: Slot) => ({ productId: slot.id, name: rowById.get(slot.id)?.name ?? null, tier: slot.tier })
        weakSamples.push({
          productId: base.id,
          name: base.name,
          template: templateLabel(base),
          weakSameSeller: weakSame.map(describe),
          strongerCrossSellerCutOff: strongCutOff.slice(0, 3).map(describe),
          status: '待确认',
        })
      }
    }
  }

  return {
    audience: 'member',
    measuredBeforeAvailabilityFilter: true,
    bases: rows.length,
    slotsFilledHistogram: Object.fromEntries(filled.map((count, slots) => [slots, count])),
    underfilledBases: rows.length - filled[DISPLAY_SLOTS],
    emptyBases: filled[0],
    slotTiers,
    weakSameSellerPlaceholder: { bases: weakPlaceholderBases, displacedStrongSlots, samples: weakSamples },
    underfilledSamples,
  }
}

const ADMISSIONS: RecommendationAdmission[] = ['C0', 'C1', 'C2']
const AUDIENCES = ['member', 'guest'] as const
type Audience = (typeof AUDIENCES)[number]
type Position = { id: number; tier: number; sameSeller: boolean }
type SlotChange = { removed: number[]; added: number[]; moved: Array<{ id: number; from: number; to: number }> }

/** Distinguishes "primary value missing" from "template has no primary field" (§5.4). */
function baseClass(row: ScopeRow): string {
  const policy = findRecommendationPolicy(row.templateKey, row.templateVersion)
  if (!policy) return 'legacy/unknown'
  if (!policy.primary) return `${policy.key}@${policy.version}:无主字段`
  const value = policy.primary === 'serviceName' ? row.serviceNameNormalized : row.contentCategoryNormalized
  return `${policy.key}@${policy.version}:${value == null ? '主值缺失' : '有主值'}`
}

function slotChange(before: Position[], after: Position[]): SlotChange {
  const beforeIndex = new Map(before.map((slot, index) => [slot.id, index + 1]))
  const afterIndex = new Map(after.map((slot, index) => [slot.id, index + 1]))
  return {
    removed: before.filter(slot => !afterIndex.has(slot.id)).map(slot => slot.id),
    added: after.filter(slot => !beforeIndex.has(slot.id)).map(slot => slot.id),
    moved: after.flatMap(slot => {
      const from = beforeIndex.get(slot.id)
      const to = afterIndex.get(slot.id)!
      return from != null && from !== to ? [{ id: slot.id, from, to }] : []
    }),
  }
}

function emptyRuleStats() {
  return {
    bases: 0,
    histogram: Object.fromEntries(Array.from({ length: DISPLAY_SLOTS + 1 }, (_, slots) => [slots, 0])) as Record<number, number>,
    emptyBases: 0,
    filledSlots: 0,
    slotTiers: { sameSeller: { 3: 0, 2: 0, 1: 0 }, otherSeller: { 3: 0, 2: 0, 1: 0 } },
    weakSameSellerPlaceholderBases: 0,
    // A bucket returning exactly the SQL cap may hide further eligible candidates.
    basesWithTruncatedBucket: 0,
  }
}

/**
 * Offline admission comparison over the full scope. Candidates are the pre-availability
 * top six of the same SQL the endpoint uses; nothing is hydrated, signed or written.
 */
async function compareAdmissions(rows: ScopeRow[], sampleLimit: number) {
  const rowById = new Map(rows.map(row => [row.id, row]))
  const details: Array<{
    audience: Audience
    sourceId: number
    categoryCode: string
    baseClass: string
    seller: 'platform' | 'merchant'
    rules: Record<RecommendationAdmission, Position[]>
    changes: Record<'C1' | 'C2', SlotChange>
  }> = []
  const summary = Object.fromEntries(AUDIENCES.map(audience => [audience, {
    bases: 0,
    rules: Object.fromEntries(ADMISSIONS.map(rule => [rule, emptyRuleStats()])) as Record<RecommendationAdmission, ReturnType<typeof emptyRuleStats>>,
    changes: Object.fromEntries((['C1', 'C2'] as const).map(rule => [rule, {
      changedBases: 0, basesLosingAllCandidates: 0, removedSlots: 0, addedSlots: 0, movedSlots: 0,
    }])) as Record<'C1' | 'C2', { changedBases: number; basesLosingAllCandidates: number; removedSlots: number; addedSlots: number; movedSlots: number }>,
  }])) as Record<Audience, {
    bases: number
    rules: Record<RecommendationAdmission, ReturnType<typeof emptyRuleStats>>
    changes: Record<'C1' | 'C2', { changedBases: number; basesLosingAllCandidates: number; removedSlots: number; addedSlots: number; movedSlots: number }>
  }>
  const groups = new Map<string, {
    audience: Audience; categoryCode: string; baseClass: string; seller: 'platform' | 'merchant'; bases: number
    rules: Record<RecommendationAdmission, { emptyBases: number; filledSlots: number }>
  }>()

  for (const audience of AUDIENCES) {
    // Guests can only open public products; members_only bases are never requested as guests.
    //
    // ⚠️ SPEC-CATALOG-VIS-001 §3.4 — **已知偏差，仅 CLI/管理端**：
    // 这里的游客口径只按 Product.visibility 分流，**不含**分类 guestVisibility。
    // 因此分类被收紧为 members_only 后，本审计仍会把该分类下的商品当成
    // 「游客可打开的 base」，guest 侧的基数与空位统计会偏多。
    //
    // 不影响线上权限：本文件的唯一入口是 `npm run recommendation:audit`
    // （scripts/auditRecommendationData.ts），无 HTTP 路由，输出只给运维看。
    // 真实的游客可见性由 products/visibility.ts 的四条路径决定，那些路径
    // 已包含分类条件（见 visibility.equivalence.test.ts）。
    //
    // 按 P1-B 评审意见保留现状，不改代码；若日后需要精确口径，应改为复用
    // isCurrentlyPubliclyVisible 而不是在这里重写一遍规则。
    const bases = audience === 'guest' ? rows.filter(row => row.visibility === 'public') : rows
    for (const base of bases) {
      const rules = {} as Record<RecommendationAdmission, Position[]>
      const seller = base.merchantId == null ? 'platform' : 'merchant'
      const groupKey = `${audience}|${base.categoryCode}|${baseClass(base)}|${seller}`
      const group = groups.get(groupKey) ?? {
        audience, categoryCode: base.categoryCode, baseClass: baseClass(base), seller, bases: 0,
        rules: Object.fromEntries(ADMISSIONS.map(rule => [rule, { emptyBases: 0, filledSlots: 0 }])) as Record<RecommendationAdmission, { emptyBases: number; filledSlots: number }>,
      }
      group.bases += 1
      groups.set(groupKey, group)
      summary[audience].bases += 1

      for (const rule of ADMISSIONS) {
        const [same, other] = await Promise.all([
          queryRecommendationCandidates(base, audience, true, rule),
          queryRecommendationCandidates(base, audience, false, rule),
        ])
        const ranked: Position[] = [
          ...same.map(row => ({ id: row.id, tier: row.tier, sameSeller: true })),
          ...other.map(row => ({ id: row.id, tier: row.tier, sameSeller: false })),
        ]
        const shown = ranked.slice(0, DISPLAY_SLOTS)
        rules[rule] = shown
        const stats = summary[audience].rules[rule]
        stats.bases += 1
        stats.histogram[shown.length] += 1
        stats.filledSlots += shown.length
        if (shown.length === 0) stats.emptyBases += 1
        for (const slot of shown) {
          stats.slotTiers[slot.sameSeller ? 'sameSeller' : 'otherSeller'][slot.tier as 1 | 2 | 3] += 1
        }
        if (shown.some(slot => slot.sameSeller && slot.tier < 3)
          && ranked.slice(DISPLAY_SLOTS).some(slot => !slot.sameSeller && slot.tier === 3)) {
          stats.weakSameSellerPlaceholderBases += 1
        }
        if (same.length === RECOMMENDATION_CANDIDATE_LIMIT || other.length === RECOMMENDATION_CANDIDATE_LIMIT) {
          stats.basesWithTruncatedBucket += 1
        }
        group.rules[rule].filledSlots += shown.length
        if (shown.length === 0) group.rules[rule].emptyBases += 1
      }

      const changes = {
        C1: slotChange(rules.C0, rules.C1),
        C2: slotChange(rules.C0, rules.C2),
      }
      for (const rule of ['C1', 'C2'] as const) {
        const change = changes[rule]
        const totals = summary[audience].changes[rule]
        if (change.removed.length || change.added.length || change.moved.length) totals.changedBases += 1
        if (rules.C0.length > 0 && rules[rule].length === 0) totals.basesLosingAllCandidates += 1
        totals.removedSlots += change.removed.length
        totals.addedSlots += change.added.length
        totals.movedSlots += change.moved.length
      }
      details.push({ audience, sourceId: base.id, categoryCode: base.categoryCode, baseClass: baseClass(base), seller, rules, changes })
    }
  }

  const describe = (slot: Position) => ({ id: slot.id, name: rowById.get(slot.id)?.name ?? null, tier: slot.tier, sameSeller: slot.sameSeller })
  const changedSamples = (rule: 'C1' | 'C2') => {
    const changed = details.filter(detail => {
      const change = detail.changes[rule]
      return change.removed.length || change.added.length || change.moved.length
    })
    return {
      total: changed.length,
      shown: Math.min(changed.length, sampleLimit),
      truncated: changed.length > sampleLimit,
      samples: changed.slice(0, sampleLimit).map(detail => ({
        audience: detail.audience,
        source: { id: detail.sourceId, name: rowById.get(detail.sourceId)?.name ?? null, baseClass: detail.baseClass },
        C0: detail.rules.C0.map(describe),
        [rule]: detail.rules[rule].map(describe),
        status: '待复核',
      })),
    }
  }

  return {
    measuredBeforeAvailabilityFilter: true,
    rules: {
      C0: '当前规则',
      C1: '已知模板锚定：已知模板基准排除 legacy/unknown 候选；legacy/unknown 基准保持 C0（有方向性）',
      C2: '严格参照（诊断上限）：C1 + 排除主值缺失的同模板候选；legacy/unknown 基准无候选',
    },
    audiences: summary,
    groups: [...groups.values()].sort((a, b) =>
      a.audience.localeCompare(b.audience) || a.categoryCode.localeCompare(b.categoryCode)
      || a.baseClass.localeCompare(b.baseClass) || a.seller.localeCompare(b.seller)),
    changedSamples: { C1: changedSamples('C1'), C2: changedSamples('C2') },
    // Full per-base positions for local manual review; not truncated by sampleLimit.
    details,
  }
}

function sources(rows: ScopeRow[], sampleLimit: number) {
  const imported = rows.filter(row => row.importProvider != null)
  const byProvider: Record<string, number> = {}
  for (const row of imported) byProvider[row.importProvider!] = (byProvider[row.importProvider!] ?? 0) + 1
  const importedNameFlags = imported
    .filter(row => IMPORT_NAME_TERMS.test(row.name) || IMPORT_NAME_TERMS.test(row.serviceNameRaw ?? ''))
    .map(row => ({ productId: row.id, name: row.name, serviceName: row.serviceNameRaw, status: '待确认' }))
  return {
    externalImport: { products: imported.length, byProvider },
    fakaOffersWithoutImportRecord: rows.filter(row => row.importProvider == null && row.hasFakaOffer).length,
    noExternalSource: rows.filter(row => row.importProvider == null && !row.hasFakaOffer).length,
    importedNamesWithOfferTerms: {
      products: importedNameFlags.length,
      samples: importedNameFlags.slice(0, sampleLimit),
    },
    aiCreation: {
      status: '无法区分',
      reason:
        'AiGeneration 只记录 Copilot/草稿助手的调用与计数，不记录商品内容是否采用了 AI 输出；' +
        '草稿助手的 targetId 是操作人而非商品。没有可靠的持久化来源字段。',
    },
  }
}

export async function auditRecommendationData(options: RecommendationAuditOptions = {}) {
  const sampleLimit = options.sampleLimit ?? 20
  const rows = await loadScope()
  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    readOnly: true,
    scope: {
      definition: '上架（status=active）、未归档、经营者有效（平台自营或商家 active）的商品；不区分 visibility',
      products: rows.length,
      withActiveOffer: rows.filter(row => row.hasActiveOffer).length,
    },
    completeness: completeness(rows),
    legacyTemplates: legacyShare(rows),
    names: Object.fromEntries(NAME_KEYS.map(key => [key, nameDistribution(rows, key, sampleLimit)])),
    recommendations: await recommendationSlots(rows, sampleLimit),
    sources: sources(rows, sampleLimit),
    ...(options.compare ? { comparison: await compareAdmissions(rows, sampleLimit) } : {}),
  }
}

export type RecommendationAuditReport = Awaited<ReturnType<typeof auditRecommendationData>>

function table(headers: string[], rows: Array<Array<string | number | null>>): string {
  if (rows.length === 0) return '（无数据）'
  const cell = (value: string | number | null) => String(value ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n')
}

/** Human-readable report body; the JSON form stays the source of truth. */
export function renderRecommendationAuditMarkdown(report: RecommendationAuditReport): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`
  const out: string[] = [
    `> 生成时间 ${report.generatedAt}；只读统计；“待确认”项仅供人工核实，未做任何清洗或规则调整。`,
    '',
    '## 1. 范围',
    `${report.scope.definition}。商品 ${report.scope.products} 件，其中有启用套餐 ${report.scope.withActiveOffer} 件。`,
    '',
    '## 2. 分类 × 模板 × 主匹配字段完整度',
    table(
      ['分类', '模板', '商品', '有启用套餐', '主匹配字段', '已填', '缺失'],
      report.completeness.map(row => [
        `${row.categoryLabel} (${row.categoryCode})`, row.template, row.products, row.withActiveOffer,
        row.primaryKey, row.primaryPresent, row.primaryMissing,
      ]),
    ),
    '',
    '## 3. 旧模板（legacy/unknown）占比',
    `全部 ${report.legacyTemplates.legacyOrUnknown}/${report.legacyTemplates.products}（${pct(report.legacyTemplates.share)}）。`,
    '',
    table(
      ['分类', '商品', '旧模板', '占比'],
      report.legacyTemplates.byCategory.map(row => [
        `${row.categoryLabel} (${row.categoryCode})`, row.products, row.legacy, pct(row.share),
      ]),
    ),
    '',
  ]
  for (const [key, dist] of Object.entries(report.names)) {
    out.push(
      `## 4.${key === 'serviceName' ? 1 : 2} ${key} 名称分布`,
      `适用模板 ${dist.templates.join('、')}；商品 ${dist.productsWithKey} 件，缺失 ${dist.missing} 件，` +
        `规则归一化后 ${dist.distinctNormalized} 个不同值${dist.valuesTruncated ? '（下表截断）' : ''}。`,
      '',
      table(
        ['归一化值', '商品', '原始写法'],
        dist.values.map(value => [
          value.normalized, value.count, value.spellings.map(s => `${s.raw} ×${s.count}`).join('；'),
        ]),
      ),
      '',
      '疑似同义（待确认，宽松归一化：NFKC/大小写/空白/标点）：',
      dist.suspectedSynonyms.looseNormalization.length
        ? dist.suspectedSynonyms.looseNormalization.map(group => `- ${group.values.join(' / ')}`).join('\n')
        : '- 无',
      '',
      '疑似包含关系（待确认）：',
      dist.suspectedSynonyms.containment.length
        ? dist.suspectedSynonyms.containment.map(pair => `- ${pair.shorter} ⊂ ${pair.longer}`).join('\n')
        : '- 无',
      '',
    )
  }
  const rec = report.recommendations
  out.push(
    '## 5. 推荐位占用与不足（登录用户视角，可售过滤之前）',
    `基准商品 ${rec.bases} 件；推荐不足 6 件的 ${rec.underfilledBases} 件，其中完全没有推荐的 ${rec.emptyBases} 件。` +
      '本指标是可售过滤前的前六候选。实际接口对完整的最多 128 个候选补全、过滤后再取六件，' +
      '后续候选可能补位，因此最终商品与位置需要单独核验。',
    '',
    table(['填充位数', '基准商品'], Object.entries(rec.slotsFilledHistogram).map(([slots, count]) => [slots, count])),
    '',
    table(
      ['推荐位来源', '强匹配 tier3', '中 tier2', '弱 tier1'],
      [
        ['同店', rec.slotTiers.sameSeller[3], rec.slotTiers.sameSeller[2], rec.slotTiers.sameSeller[1]],
        ['跨店', rec.slotTiers.otherSeller[3], rec.slotTiers.otherSeller[2], rec.slotTiers.otherSeller[1]],
      ],
    ),
    '',
    `同店弱匹配占位：${rec.weakSameSellerPlaceholder.bases} 件基准商品，` +
      `约 ${rec.weakSameSellerPlaceholder.displacedStrongSlots} 个推荐位被同店 tier<3 占用而跨店 tier3 落选（待确认样本见 JSON）。`,
    '',
    '## 6. 来源',
    `外部导入 ${report.sources.externalImport.products} 件（${Object.entries(report.sources.externalImport.byProvider)
      .map(([provider, count]) => `${provider} ${count}`).join('、') || '无'}）；` +
      `有 Faka 套餐但无导入记录 ${report.sources.fakaOffersWithoutImportRecord} 件；无外部来源 ${report.sources.noExternalSource} 件。`,
    `导入名称疑似混入周期/套餐/版本词：${report.sources.importedNamesWithOfferTerms.products} 件（待确认样本见 JSON）。`,
    `AI 创建来源：${report.sources.aiCreation.status}。${report.sources.aiCreation.reason}`,
    '',
  )
  if (report.comparison) {
    const cmp = report.comparison
    out.push(
      '## 7. 离线准入比较（可售过滤前的前六候选）',
      ...Object.entries(cmp.rules).map(([rule, text]) => `- ${rule}：${text}`),
      '',
    )
    for (const audience of AUDIENCES) {
      const entry = cmp.audiences[audience]
      out.push(
        `### ${audience === 'member' ? '登录用户（全范围基准）' : '游客（仅 public 基准）'}：基准 ${entry.bases} 件`,
        '',
        table(
          ['规则', '0 位', '1–5 位', '6 位', '空结果', '同店 t3/t2/t1', '跨店 t3/t2/t1', '同店弱占位', '桶达 64 上限'],
          ADMISSIONS.map(rule => {
            const stats = entry.rules[rule]
            const partial = Object.entries(stats.histogram)
              .filter(([slots]) => Number(slots) > 0 && Number(slots) < DISPLAY_SLOTS)
              .reduce((sum, [, count]) => sum + count, 0)
            const tiers = (bucket: { 3: number; 2: number; 1: number }) => `${bucket[3]}/${bucket[2]}/${bucket[1]}`
            return [rule, stats.histogram[0], partial, stats.histogram[DISPLAY_SLOTS], stats.emptyBases,
              tiers(stats.slotTiers.sameSeller), tiers(stats.slotTiers.otherSeller),
              stats.weakSameSellerPlaceholderBases, stats.basesWithTruncatedBucket]
          }),
        ),
        '',
        table(
          ['相对 C0', '有变化基准', '由有候选变为空', '移除位', '新增位', '位置变化'],
          (['C1', 'C2'] as const).map(rule => {
            const change = entry.changes[rule]
            return [rule, change.changedBases, change.basesLosingAllCandidates, change.removedSlots, change.addedSlots, change.movedSlots]
          }),
        ),
        '',
      )
    }
    out.push(
      '### 分组（分类 × 基准模板状态 × 经营者）',
      '',
      table(
        ['视角', '分类', '基准模板', '经营者', '基准', 'C0 空/位', 'C1 空/位', 'C2 空/位'],
        cmp.groups.map(group => [
          group.audience, group.categoryCode, group.baseClass, group.seller === 'platform' ? '平台' : '商家', group.bases,
          ...ADMISSIONS.map(rule => `${group.rules[rule].emptyBases}/${group.rules[rule].filledSlots}`),
        ]),
      ),
      '',
      `变化案例：C1 ${cmp.changedSamples.C1.total} 个（展示 ${cmp.changedSamples.C1.shown}），` +
        `C2 ${cmp.changedSamples.C2.total} 个（展示 ${cmp.changedSamples.C2.shown}）；完整逐基准明细见 JSON 的 comparison.details。`,
      '',
    )
  }
  return out.join('\n')
}
