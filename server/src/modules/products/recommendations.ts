import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { getProductTemplate } from '../catalog/templates/registry.js'
import type { TemplateKey } from '../catalog/templates/types.js'
import { guestVisibilitySql, merchantVisibleSql, type ProductAudience } from './visibility.js'

/** Fixed per-group candidate cap; bounds hydration cost, not the category scan. */
export const RECOMMENDATION_CANDIDATE_LIMIT = 64

export type RecommendationPolicy = {
  key: TemplateKey
  version: number
  primary: string | null
  secondary: Array<{ key: string; isArray: boolean }>
}

// Recommendation strategy per exact template version (PLAN-PDP-REC-001 §3.2). A version
// without an entry here is treated as an unknown template, never as its predecessor.
const POLICY_SOURCE: Array<{ key: TemplateKey; version: number; primary: string | null; secondary: string[] }> = [
  { key: 'redemption_code', version: 1, primary: 'serviceName', secondary: ['region'] },
  { key: 'account', version: 1, primary: 'serviceName', secondary: ['accessModel'] },
  { key: 'digital_file', version: 1, primary: 'contentCategory', secondary: ['formats', 'compatibility'] },
  { key: 'fixed_content', version: 1, primary: 'contentCategory', secondary: [] },
  { key: 'subscription', version: 1, primary: 'serviceName', secondary: [] },
  { key: 'manual_service', version: 1, primary: null, secondary: [] },
  { key: 'appointment', version: 1, primary: null, secondary: ['deliveryChannel'] },
]

function buildPolicies(): RecommendationPolicy[] {
  return POLICY_SOURCE.map(source => {
    const template = getProductTemplate(source.key, source.version)
    if (!template) throw new Error(`recommendation policy references unknown template ${source.key}@${source.version}`)
    const properties = (template.productSchema.properties ?? {}) as Record<string, { type?: unknown }>
    const assertPublicKey = (key: string) => {
      if (!template.ui.productOrder.includes(key) || !properties[key]) {
        throw new Error(`recommendation policy key ${key} is not a public field of ${source.key}@${source.version}`)
      }
    }
    if (source.primary) {
      assertPublicKey(source.primary)
      if (properties[source.primary].type !== 'string') {
        throw new Error(`recommendation primary key ${source.primary} must be a string field`)
      }
    }
    return {
      key: source.key,
      version: source.version,
      primary: source.primary,
      secondary: source.secondary.map(key => {
        assertPublicKey(key)
        return { key, isArray: properties[key].type === 'array' }
      }),
    }
  })
}

const POLICIES = buildPolicies()

/** Read-only view of the strategy table, for the recommendation data audit. */
export const RECOMMENDATION_POLICIES: readonly RecommendationPolicy[] = POLICIES

export function findRecommendationPolicy(
  templateKey: string | null,
  templateVersion: number | null,
): RecommendationPolicy | null {
  return POLICIES.find(policy => policy.key === templateKey && policy.version === templateVersion) ?? null
}

/**
 * Only ASCII space trim + ASCII case folding; empty strings count as missing.
 * Non-string JSON values are missing rather than coerced.
 */
function normalizedText(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`NULLIF(translate(btrim(${value}, ' '), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '')`
}

export function normalizedStringAttribute(alias: 'p' | 'b', key: string): Prisma.Sql {
  const attrs = alias === 'p' ? Prisma.sql`p."attributes"` : Prisma.sql`b."attributes"`
  return normalizedText(Prisma.sql`CASE WHEN jsonb_typeof(${attrs} -> ${key}::text) = 'string'
    THEN ${attrs} ->> ${key}::text END`)
}

function normalizedArrayElements(alias: 'p' | 'b', key: string): Prisma.Sql {
  const attrs = alias === 'p' ? Prisma.sql`p."attributes"` : Prisma.sql`b."attributes"`
  return Prisma.sql`(
    SELECT ${normalizedText(Prisma.sql`e #>> '{}'`)} AS v
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${attrs} -> ${key}::text) = 'array'
      THEN ${attrs} -> ${key}::text ELSE '[]'::jsonb END) AS e
    WHERE jsonb_typeof(e) = 'string'
  )`
}

function secondaryMatchSql(secondary: RecommendationPolicy['secondary'][number]): Prisma.Sql {
  if (secondary.isArray) {
    return Prisma.sql`CASE WHEN EXISTS (
      SELECT 1 FROM ${normalizedArrayElements('p', secondary.key)} ce
      JOIN ${normalizedArrayElements('b', secondary.key)} be ON be.v = ce.v
      WHERE ce.v IS NOT NULL
    ) THEN 1 ELSE 0 END`
  }
  return Prisma.sql`CASE WHEN ${normalizedStringAttribute('p', secondary.key)}
    = ${normalizedStringAttribute('b', secondary.key)} THEN 1 ELSE 0 END`
}

/**
 * Admission rules compared offline (PLAN-RECOMMENDATION-LOCAL-QUALITY-001 §7.1). C0 is the
 * live rule; C1/C2 are audit-only labels, never selectable from a request.
 * - C1: a known-template base excludes legacy/unknown candidates; legacy bases keep C0.
 * - C2: additionally drops same-template candidates with a missing primary value, and
 *   legacy/unknown bases get no candidates.
 */
export type RecommendationAdmission = 'C0' | 'C1' | 'C2'

/**
 * relevanceTier: 3 = same known template + equal primary value, 2 = same known template
 * without a comparable primary value, 1 = at least one side legacy/unknown, NULL = excluded
 * (different known templates, or both primary values present but different).
 */
function scoringSql(
  policy: RecommendationPolicy | null,
  admission: RecommendationAdmission,
): { tier: Prisma.Sql; secondary: Prisma.Sql } {
  if (!policy) return { tier: admission === 'C2' ? Prisma.sql`NULL` : Prisma.sql`1`, secondary: Prisma.sql`0` }

  const knownTemplates = Prisma.join(
    POLICIES.map(known => Prisma.sql`(${known.key}::text, ${known.version}::int)`),
  )
  const sameTemplate = Prisma.sql`p."templateKey" = ${policy.key} AND p."templateVersion" = ${policy.version}`
  let sameTemplateTier = Prisma.sql`2`
  if (policy.primary) {
    const candidatePrimary = normalizedStringAttribute('p', policy.primary)
    const basePrimary = normalizedStringAttribute('b', policy.primary)
    sameTemplateTier = Prisma.sql`CASE
      WHEN ${candidatePrimary} IS NULL OR ${basePrimary} IS NULL THEN ${admission === 'C2' ? Prisma.sql`NULL` : Prisma.sql`2`}
      WHEN ${candidatePrimary} = ${basePrimary} THEN 3
    END`
  }
  const secondary = policy.secondary.length > 0
    ? Prisma.sql`CASE WHEN ${sameTemplate} THEN ${Prisma.join(policy.secondary.map(secondaryMatchSql), ' + ')} ELSE 0 END`
    : Prisma.sql`0`
  return {
    tier: Prisma.sql`CASE
      WHEN ${sameTemplate} THEN ${sameTemplateTier}
      WHEN (p."templateKey", p."templateVersion") IN (${knownTemplates}) THEN NULL
      ELSE ${admission === 'C0' ? Prisma.sql`1` : Prisma.sql`NULL`}
    END`,
    secondary,
  }
}

export type RecommendationBase = {
  id: number
  categoryId: number
  merchantId: number | null
  templateKey: string | null
  templateVersion: number | null
}

export type RecommendationCandidate = { id: number; tier: number; secondary: number }

/**
 * Ranks eligible candidates of one seller group entirely in SQL so a stale strong match
 * is never pushed out of the LIMIT by newer unrelated rows. Returns ordered product IDs.
 */
export async function queryRecommendationCandidateIds(
  base: RecommendationBase,
  audience: ProductAudience,
  sameSeller: boolean,
): Promise<number[]> {
  return (await queryRecommendationCandidates(base, audience, sameSeller)).map(row => row.id)
}

/**
 * Same ranking with its scores, so the data audit measures exactly what the endpoint ranks.
 * Admission is applied before ORDER BY/LIMIT; the endpoint always uses C0.
 */
export async function queryRecommendationCandidates(
  base: RecommendationBase,
  audience: ProductAudience,
  sameSeller: boolean,
  admission: RecommendationAdmission = 'C0',
): Promise<RecommendationCandidate[]> {
  const { tier, secondary } = scoringSql(findRecommendationPolicy(base.templateKey, base.templateVersion), admission)
  const where: Prisma.Sql[] = [
    Prisma.sql`p."id" <> ${base.id}`,
    Prisma.sql`p."categoryId" = ${base.categoryId}`,
    Prisma.sql`p."status" = 'active' AND p."archivedAt" IS NULL`,
    merchantVisibleSql(),
    Prisma.sql`EXISTS (SELECT 1 FROM "Offer" o WHERE o."productId" = p."id" AND o."status" = 'active')`,
  ]
  if (audience === 'guest') where.push(guestVisibilitySql())
  if (base.merchantId == null) {
    where.push(sameSeller ? Prisma.sql`p."merchantId" IS NULL` : Prisma.sql`p."merchantId" IS NOT NULL`)
  } else {
    // Cross-seller must include platform (NULL) products; `<>` alone would drop them.
    where.push(sameSeller
      ? Prisma.sql`p."merchantId" = ${base.merchantId}`
      : Prisma.sql`(p."merchantId" IS NULL OR p."merchantId" <> ${base.merchantId})`)
  }

  return prisma.$queryRaw<RecommendationCandidate[]>`
    SELECT scored."id", scored."tier"::int AS "tier", scored."secondary"::int AS "secondary"
    FROM (
      SELECT p."id" AS "id", ${tier} AS "tier", ${secondary} AS "secondary"
      FROM "Product" p
      -- SPEC-CATALOG-VIS-001 §3.3：guestVisibilitySql 引用分类别名 c，
      -- 因此这里必须 JOIN 分类。Product.categoryId NOT NULL 且指向已存在行，
      -- INNER JOIN 不会丢弃合法候选。
      INNER JOIN "ProductCategory" c ON c."id" = p."categoryId"
      CROSS JOIN (SELECT "attributes" FROM "Product" WHERE "id" = ${base.id}) b
      WHERE ${Prisma.join(where, ' AND ')}
    ) scored
    WHERE scored."tier" IS NOT NULL
    ORDER BY scored."tier" DESC, scored."secondary" DESC, scored."id" DESC
    LIMIT ${RECOMMENDATION_CANDIDATE_LIMIT}
  `
}
