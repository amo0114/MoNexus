// SPEC-AI-PRODUCT-001 §5 / SPEC-AI-001 §4 — the only builder of model input
// for the content copilot. Every field is copied explicitly from an allowlist;
// secrets (fixedContent, externalSku, prices, stock, capacity, planId…) are
// never read into the context even when the caller loaded them.

import { markAiSafe, type AiSafe } from '../../../lib/ai/safe.js'
import { productDetailsSchema } from '../templates/productDetails.js'
import {
  EMPTY_PRODUCT_DETAILS,
  type ProductDetails,
  type ProductTemplateDefinition,
  type TemplateKey,
} from '../templates/types.js'
import {
  GENERATION_LIMITS,
  MAX_CONTEXT_CHARS,
  type ContentField,
  type GenerationLimits,
} from './constants.js'

export const DELIVERY_METHODS = ['instant_inventory', 'instant_fixed', 'manual_service'] as const
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number]

export const XBOARD_PERIODS = [
  'monthly',
  'quarterly',
  'half_yearly',
  'yearly',
  'two_yearly',
  'three_yearly',
  'onetime',
  'reset_traffic',
] as const
export type XboardPeriod = (typeof XBOARD_PERIODS)[number]

/** Faithful projection of Offer.validityDays; `null` means perpetual access in the domain. */
export type Validity = { kind: 'days'; days: number } | { kind: 'perpetual_access' }

export type DeclaredAttr =
  | { kind: 'text'; title: string; value: string | null }
  | { kind: 'list'; title: string; value: string[] | null }
  | { kind: 'enum'; title: string; value: string | null; valueLabel: string | null }
  | { kind: 'integer'; title: string; value: number | null; unit: 'minute' | null }

export type OfferFacts = {
  ref: `offer:${number}`
  name: string
  deliveryMethod: DeliveryMethod
  autoProvision: boolean
  externalProvisioning: boolean
  validity: Validity
  xboardPeriod: XboardPeriod | null
  deliveryFieldLabels: string[]
  attributes: Record<string, DeclaredAttr>
}

export type ProductAiFacts = {
  template: { key: TemplateKey; version: number; label: string }
  category: { label: string }
  productAttributes: Record<string, DeclaredAttr>
  offers: OfferFacts[]
  common: { deliveryMethod: DeliveryMethod | null; validity: Validity | null }
  purchaseFormFieldLabels: string[]
  xboard: { periods: XboardPeriod[] } | null
}

export type ProductContentAiContext = {
  schemaVersion: 1
  targetFields: ContentField[]
  limits: GenerationLimits
  facts: ProductAiFacts
  untrusted: {
    productName: string
    currentContent: { description: string | null; details: ProductDetails }
    sourceNotes: string | null
    upstreamDescriptionText: string | null
  }
  truncated: boolean
}

/** Domain data already read through the caller's ownership rules (§5.2). */
export interface ContentCopilotDomainInput {
  actorKind: 'merchant' | 'admin'
  template: ProductTemplateDefinition
  categoryLabel: string
  product: {
    name: string
    description: string | null
    attributes: unknown
    details: unknown
    purchaseForm: unknown
  }
  /** Active offers ordered by sortOrder, id. */
  offers: Array<{
    id: number
    name: string
    deliveryMode: string
    autoProvision: boolean
    externalIntegration: string | null
    validityDays: number | null
    deliveryFields: unknown
    attributes: unknown
    /** Only loaded for admin + ExternalCatalogLink; used to derive xboardPeriod, never projected. */
    externalSku?: string | null
  }>
  externalLink: { sourceSnapshot: unknown; latestDescriptionText: string | null } | null
  useUpstreamDescription: boolean
  targetFields: ContentField[]
  sourceNotes: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function schemaProperties(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const props = schema.properties
  if (!isRecord(props)) return {}
  const out: Record<string, Record<string, unknown>> = {}
  for (const [key, value] of Object.entries(props)) {
    if (isRecord(value)) out[key] = value
  }
  return out
}

function projectDeclaredAttributes(
  schema: Record<string, unknown>,
  order: string[],
  enumLabels: Record<string, Record<string, string>> | undefined,
  raw: unknown,
): Record<string, DeclaredAttr> {
  const values = isRecord(raw) ? raw : {}
  const props = schemaProperties(schema)
  const keys = [...order.filter(key => key in props), ...Object.keys(props).filter(key => !order.includes(key))]
  const out: Record<string, DeclaredAttr> = {}
  for (const key of keys) {
    const prop = props[key]
    const title = typeof prop.title === 'string' ? prop.title : key
    const value = values[key]
    if (prop.type === 'string' && Array.isArray(prop.enum)) {
      const enumValue = typeof value === 'string' && prop.enum.includes(value) ? value : null
      out[key] = {
        kind: 'enum',
        title,
        value: enumValue,
        valueLabel: enumValue == null ? null : enumLabels?.[key]?.[enumValue] ?? null,
      }
    } else if (prop.type === 'string') {
      out[key] = { kind: 'text', title, value: nonBlank(value) }
    } else if (prop.type === 'array') {
      const items = Array.isArray(value)
        ? value.map(nonBlank).filter((item): item is string => item != null)
        : []
      out[key] = { kind: 'list', title, value: items.length > 0 ? items : null }
    } else if (prop.type === 'integer') {
      out[key] = {
        kind: 'integer',
        title,
        value: Number.isInteger(value) ? (value as number) : null,
        unit: key === 'estimatedMinutes' ? 'minute' : null,
      }
    }
  }
  return out
}

function labelsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(item => (isRecord(item) ? nonBlank(item.label) : null))
    .filter((label): label is string => label != null)
}

function isDeliveryMethod(value: string): value is DeliveryMethod {
  return (DELIVERY_METHODS as readonly string[]).includes(value)
}

function isXboardPeriod(value: unknown): value is XboardPeriod {
  return typeof value === 'string' && (XBOARD_PERIODS as readonly string[]).includes(value)
}

function lower(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : null
}

/**
 * Exact Xboard period for an imported offer (§5.3): skuAlias → namedSkus →
 * `plan-{planId}-{period}` → null. Never `periodFromFakaSku`, which falls back
 * to 'monthly' on unparseable SKUs.
 */
export function deriveXboardPeriod(sourceSnapshot: unknown, externalSku: string | null | undefined): XboardPeriod | null {
  const sku = lower(externalSku)
  if (!sku || !isRecord(sourceSnapshot)) return null
  const periods = Array.isArray(sourceSnapshot.periods) ? sourceSnapshot.periods.filter(isRecord) : []
  const namedSkus = Array.isArray(sourceSnapshot.namedSkus) ? sourceSnapshot.namedSkus.filter(isRecord) : []

  for (const row of periods) {
    if (lower(row.skuAlias) === sku && isXboardPeriod(lower(row.period))) return lower(row.period) as XboardPeriod
  }
  for (const row of namedSkus) {
    if (lower(row.sku) === sku && isXboardPeriod(lower(row.period))) return lower(row.period) as XboardPeriod
  }
  const planId = sourceSnapshot.planId
  if (typeof planId === 'number' && Number.isInteger(planId)) {
    const known = new Set(periods.map(row => lower(row.period)))
    const prefix = `plan-${planId}-`
    if (sku.startsWith(prefix)) {
      const period = sku.slice(prefix.length)
      if (known.has(period) && isXboardPeriod(period)) return period
    }
  }
  return null
}

function snapshotPeriods(sourceSnapshot: unknown): XboardPeriod[] {
  if (!isRecord(sourceSnapshot) || !Array.isArray(sourceSnapshot.periods)) return []
  const out: XboardPeriod[] = []
  for (const row of sourceSnapshot.periods) {
    const period = isRecord(row) ? lower(row.period) : null
    if (isXboardPeriod(period) && !out.includes(period)) out.push(period)
  }
  return out
}

function sameValidity(a: Validity, b: Validity): boolean {
  return a.kind === b.kind && (a.kind !== 'days' || a.days === (b as { days: number }).days)
}

function parseCurrentDetails(raw: unknown): ProductDetails {
  const parsed = productDetailsSchema.safeParse(raw)
  return parsed.success ? parsed.data : { ...EMPTY_PRODUCT_DETAILS }
}

function cut(text: string, overflow: number): string {
  const keep = Math.max(0, text.length - overflow - 1)
  return keep === 0 ? '' : `${text.slice(0, keep)}…`
}

export function buildProductContentAiContext(input: ContentCopilotDomainInput): AiSafe<ProductContentAiContext> {
  const isAdmin = input.actorKind === 'admin'
  const link = isAdmin ? input.externalLink : null
  const template = input.template

  const offers: OfferFacts[] = input.offers
    .filter(offer => isDeliveryMethod(offer.deliveryMode))
    .map(offer => ({
      ref: `offer:${offer.id}` as const,
      name: offer.name,
      deliveryMethod: offer.deliveryMode as DeliveryMethod,
      autoProvision: offer.autoProvision,
      externalProvisioning: offer.externalIntegration === 'faka_bridge',
      validity: offer.validityDays == null
        ? { kind: 'perpetual_access' as const }
        : { kind: 'days' as const, days: offer.validityDays },
      xboardPeriod: link ? deriveXboardPeriod(link.sourceSnapshot, offer.externalSku) : null,
      deliveryFieldLabels: labelsOf(offer.deliveryFields),
      attributes: projectDeclaredAttributes(
        template.offerSchema,
        template.ui.offerOrder,
        template.ui.enumLabels,
        offer.attributes,
      ),
    }))

  const first = offers[0]
  const common = {
    deliveryMethod: first && offers.every(offer => offer.deliveryMethod === first.deliveryMethod)
      ? first.deliveryMethod
      : null,
    validity: first && offers.every(offer => sameValidity(offer.validity, first.validity))
      ? first.validity
      : null,
  }

  const context: ProductContentAiContext = {
    schemaVersion: 1,
    targetFields: [...input.targetFields],
    limits: GENERATION_LIMITS,
    facts: {
      template: { key: template.key, version: template.version, label: template.label },
      category: { label: input.categoryLabel },
      productAttributes: projectDeclaredAttributes(
        template.productSchema,
        template.ui.productOrder,
        template.ui.enumLabels,
        input.product.attributes,
      ),
      offers,
      common,
      purchaseFormFieldLabels: labelsOf(input.product.purchaseForm),
      xboard: link ? { periods: snapshotPeriods(link.sourceSnapshot) } : null,
    },
    untrusted: {
      productName: input.product.name,
      currentContent: {
        description: nonBlank(input.product.description),
        details: parseCurrentDetails(input.product.details),
      },
      sourceNotes: nonBlank(input.sourceNotes),
      upstreamDescriptionText: link && input.useUpstreamDescription
        ? nonBlank(link.latestDescriptionText)
        : null,
    },
    truncated: false,
  }
  return markAiSafe(truncateToLimit(context))
}

/**
 * Thrown when the context still exceeds MAX_CONTEXT_CHARS after every
 * untrusted field was truncated. Facts are never cut (AI-R13), so the request
 * must be refused before any provider call rather than sent over the limit.
 */
export class ContentContextTooLargeError extends Error {
  constructor() {
    super('content copilot context exceeds the frozen size limit')
  }
}

type TruncationStep =
  | { kind: 'text'; get: () => string | null; set: (value: string) => void }
  | { kind: 'list'; list: () => unknown[] }

function truncateToLimit(context: ProductContentAiContext): ProductContentAiContext {
  const over = () => JSON.stringify(context).length - MAX_CONTEXT_CHARS
  const untrusted = context.untrusted
  const details = untrusted.currentContent.details
  const textStep = (get: () => string | null, set: (value: string) => void): TruncationStep => ({ kind: 'text', get, set })
  // Frozen order (§5.4): least valuable untrusted text first, facts never.
  const steps: TruncationStep[] = [
    textStep(() => untrusted.upstreamDescriptionText, value => { untrusted.upstreamDescriptionText = value || null }),
    textStep(() => untrusted.sourceNotes, value => { untrusted.sourceNotes = value || null }),
    textStep(() => details.usageInstructions || null, value => { details.usageInstructions = value }),
    textStep(() => details.purchaseNotes || null, value => { details.purchaseNotes = value }),
    textStep(() => details.afterSalesInstructions || null, value => { details.afterSalesInstructions = value }),
    { kind: 'list', list: () => details.faq },
    { kind: 'list', list: () => details.highlights },
    textStep(() => untrusted.currentContent.description, value => { untrusted.currentContent.description = value || null }),
  ]
  for (const step of steps) {
    if (over() <= 0) break
    if (step.kind === 'list') {
      const list = step.list()
      while (over() > 0 && list.length > 0) {
        list.pop()
        context.truncated = true
      }
      continue
    }
    // JSON escaping can make the char count drift; keep trimming until it fits.
    while (over() > 0 && step.get()) {
      step.set(cut(step.get() as string, over()))
      context.truncated = true
    }
  }
  if (over() > 0) throw new ContentContextTooLargeError()
  return context
}
