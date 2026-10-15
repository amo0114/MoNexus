import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import {
  RECOMMENDATION_POLICIES,
  findRecommendationPolicy,
  normalizedStringAttribute,
  queryRecommendationCandidates,
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
}

type ScopeRow = {
  id: number
  name: string
  categoryId: number
  categoryCode: string
  categoryLabel: string
  merchantId: number | null
  merchantName: string | null
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
      p."merchantId", m."name" AS "merchantName", p."templateKey", p."templateVersion",
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
      '可售过滤只会进一步减少展示数。',
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
  return out.join('\n')
}
