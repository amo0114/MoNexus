import { FileText, HelpCircle, Info, List, ShieldCheck } from 'lucide-react'
import {
  EMPTY_PRODUCT_DETAILS,
  type ProductDetails,
  type ProductTemplateDefinition,
  type TemplateAttributes,
} from '../../types/catalog'

export type SpecAttributeValue = string | number | boolean | string[]
export type SpecAttributes = Record<string, SpecAttributeValue>
export type SpecSource = 'product' | 'offer'

export type MergedSpecRow = {
  key: string
  label: string
  value: string
  source: SpecSource | null
}

export const SPEC_SECTION_IDS = {
  parameters: 'product-section-parameters',
  usage: 'product-section-usage',
  purchaseNotes: 'product-section-purchase-notes',
  afterSales: 'product-section-after-sales',
  faq: 'product-section-faq',
} as const

const SECTION_SCROLL_MARGIN = 'scroll-mt-[calc(var(--navbar-h)+var(--safe-top)+3.25rem)]'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasDisplayableValue(value: unknown): value is SpecAttributeValue {
  if (typeof value === 'boolean' || typeof value === 'number') return true
  if (typeof value === 'string') return value.trim().length > 0
  return Array.isArray(value) && value.some((item) => typeof item === 'string' && item.trim().length > 0)
}

function formatSpecValue(
  value: SpecAttributeValue,
  key: string,
  enumLabels?: Record<string, Record<string, string>>,
): string {
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string' && item.trim().length > 0).join('、')
  }
  return enumLabels?.[key]?.[value] ?? value
}

function orderedKeys(order: string[] | undefined, attrs: SpecAttributes): string[] {
  const present = Object.keys(attrs).filter((key) => hasDisplayableValue(attrs[key]))
  if (!order || order.length === 0) return present
  const seen = new Set<string>()
  const result: string[] = []
  for (const key of order) {
    if (present.includes(key) && !seen.has(key)) {
      seen.add(key)
      result.push(key)
    }
  }
  for (const key of present) {
    if (!seen.has(key)) {
      seen.add(key)
      result.push(key)
    }
  }
  return result
}

export function titlesFromTemplate(template: ProductTemplateDefinition | null | undefined): Record<string, string> {
  if (!template) return {}
  const titles: Record<string, string> = {}
  for (const schema of [template.productSchema, template.offerSchema]) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    for (const [key, raw] of Object.entries(properties)) {
      if (isRecord(raw) && typeof raw.title === 'string' && raw.title.trim()) {
        titles[key] = raw.title
      }
    }
  }
  return titles
}

export function mergeProductOfferAttributes(
  productAttributes: SpecAttributes | null | undefined,
  offerAttributes: SpecAttributes | null | undefined,
  options?: {
    productOrder?: string[]
    offerOrder?: string[]
    titles?: Record<string, string>
    enumLabels?: Record<string, Record<string, string>>
  },
): MergedSpecRow[] {
  const productAttrs = productAttributes ?? {}
  const offerAttrs = offerAttributes ?? {}
  const titles = options?.titles ?? {}
  const enumLabels = options?.enumLabels
  const productKeys = orderedKeys(options?.productOrder, productAttrs)
  const offerKeys = orderedKeys(options?.offerOrder, offerAttrs)
  const offerKeySet = new Set(offerKeys)
  const seenOffer = new Set<string>()
  const rows: MergedSpecRow[] = []

  for (const key of productKeys) {
    const productValue = productAttrs[key]
    if (!hasDisplayableValue(productValue)) continue
    const overlap = offerKeySet.has(key) && hasDisplayableValue(offerAttrs[key])
    rows.push({
      key,
      label: titles[key] ?? key,
      value: formatSpecValue(productValue, key, enumLabels),
      source: overlap ? 'product' : null,
    })
    if (overlap) {
      rows.push({
        key,
        label: titles[key] ?? key,
        value: formatSpecValue(offerAttrs[key], key, enumLabels),
        source: 'offer',
      })
      seenOffer.add(key)
    }
  }

  for (const key of offerKeys) {
    if (seenOffer.has(key)) continue
    const offerValue = offerAttrs[key]
    if (!hasDisplayableValue(offerValue)) continue
    rows.push({
      key,
      label: titles[key] ?? key,
      value: formatSpecValue(offerValue, key, enumLabels),
      source: null,
    })
  }

  return rows
}

export type ProductSpecSectionsProps = {
  productAttributes?: TemplateAttributes | null
  offerAttributes?: TemplateAttributes | null
  details?: ProductDetails | null
  assurance?: { label: string; policyText: string; validUntil: string } | null
  productOrder?: string[]
  offerOrder?: string[]
  titles?: Record<string, string>
  enumLabels?: Record<string, Record<string, string>>
}

function hasFaq(details: ProductDetails | null | undefined): boolean {
  return Boolean(details?.faq?.some((item) => item.question.trim() && item.answer.trim()))
}

export function listVisibleSpecSections(input: {
  specRows: MergedSpecRow[]
  details?: ProductDetails | null
  assurance?: { label: string } | null
}): Array<{ id: string; label: string }> {
  const details = input.details ?? EMPTY_PRODUCT_DETAILS
  const sections: Array<{ id: string; label: string }> = []
  if (input.specRows.length > 0) sections.push({ id: SPEC_SECTION_IDS.parameters, label: '参数' })
  if (details.usageInstructions.trim()) sections.push({ id: SPEC_SECTION_IDS.usage, label: '使用说明' })
  if (details.purchaseNotes.trim()) sections.push({ id: SPEC_SECTION_IDS.purchaseNotes, label: '购买须知' })
  if (details.afterSalesInstructions.trim() || input.assurance) {
    sections.push({ id: SPEC_SECTION_IDS.afterSales, label: '售后与平台保障' })
  }
  if (hasFaq(details)) sections.push({ id: SPEC_SECTION_IDS.faq, label: 'FAQ' })
  return sections
}

function SectionHeading({ icon: Icon, children }: { icon: typeof FileText; children: string }) {
  return (
    <h3 className="font-heading text-lg font-bold max-md:mb-3 mb-5 flex items-center gap-2 text-[var(--color-text)] uppercase tracking-wider">
      <Icon className="w-5 h-5 text-[var(--color-primary)]" /> {children}
    </h3>
  )
}

function sourceLabel(source: SpecSource): string {
  return source === 'product' ? '商品' : '套餐'
}

export default function ProductSpecSections({
  productAttributes,
  offerAttributes,
  details,
  assurance,
  productOrder,
  offerOrder,
  titles,
  enumLabels,
}: ProductSpecSectionsProps) {
  const specRows = mergeProductOfferAttributes(productAttributes, offerAttributes, {
    productOrder,
    offerOrder,
    titles,
    enumLabels,
  })
  const resolvedDetails = details ?? EMPTY_PRODUCT_DETAILS
  const visible = listVisibleSpecSections({ specRows, details: resolvedDetails, assurance })
  if (visible.length === 0) return null

  const showUsage = Boolean(resolvedDetails.usageInstructions.trim())
  const showPurchaseNotes = Boolean(resolvedDetails.purchaseNotes.trim())
  const showAfterSales = Boolean(resolvedDetails.afterSalesInstructions.trim() || assurance)
  const showFaq = hasFaq(resolvedDetails)

  return (
    <div className="max-md:space-y-8 space-y-12" data-testid="product-spec-sections">
      {specRows.length > 0 && (
        <section id={SPEC_SECTION_IDS.parameters} className={SECTION_SCROLL_MARGIN} data-testid={SPEC_SECTION_IDS.parameters}>
          <SectionHeading icon={List}>参数</SectionHeading>
          <dl className="bg-[var(--color-background)] rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
            {specRows.map((row, index) => (
              <div
                key={`${row.key}-${row.source ?? 'unique'}-${index}`}
                className="grid grid-cols-[minmax(5.5rem,8.5rem)_minmax(0,1fr)] gap-3 px-4 py-3 text-sm"
                data-testid="product-spec-row"
                data-key={row.key}
                data-source={row.source ?? 'unique'}
              >
                <dt className="text-[var(--color-text-muted)] font-medium break-words">{row.label}</dt>
                <dd className="m-0 text-[var(--color-text)] break-words flex flex-wrap items-center gap-2 justify-start">
                  <span>{row.value}</span>
                  {row.source ? (
                    <span
                      className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]"
                      data-testid="product-spec-source"
                    >
                      {sourceLabel(row.source)}
                    </span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {showUsage && (
        <section id={SPEC_SECTION_IDS.usage} className={SECTION_SCROLL_MARGIN} data-testid={SPEC_SECTION_IDS.usage}>
          <SectionHeading icon={FileText}>使用说明</SectionHeading>
          <p className="text-sm md:text-base text-[var(--color-text)] leading-relaxed whitespace-pre-wrap break-words bg-[var(--color-background)] p-4 sm:p-6 rounded-xl border border-[var(--color-border)]">
            {resolvedDetails.usageInstructions}
          </p>
        </section>
      )}

      {showPurchaseNotes && (
        <section
          id={SPEC_SECTION_IDS.purchaseNotes}
          className={SECTION_SCROLL_MARGIN}
          data-testid={SPEC_SECTION_IDS.purchaseNotes}
        >
          <SectionHeading icon={Info}>购买须知</SectionHeading>
          <p className="text-sm md:text-base text-[var(--color-text)] leading-relaxed whitespace-pre-wrap break-words bg-[var(--color-background)] p-4 sm:p-6 rounded-xl border border-[var(--color-border)]">
            {resolvedDetails.purchaseNotes}
          </p>
        </section>
      )}

      {showAfterSales && (
        <section
          id={SPEC_SECTION_IDS.afterSales}
          className={SECTION_SCROLL_MARGIN}
          data-testid={SPEC_SECTION_IDS.afterSales}
        >
          <SectionHeading icon={ShieldCheck}>售后与平台保障</SectionHeading>
          <div className="space-y-4">
            {resolvedDetails.afterSalesInstructions.trim() ? (
              <p className="text-sm md:text-base text-[var(--color-text)] leading-relaxed whitespace-pre-wrap break-words bg-[var(--color-background)] p-4 sm:p-6 rounded-xl border border-[var(--color-border)]">
                {resolvedDetails.afterSalesInstructions}
              </p>
            ) : null}
            {assurance ? (
              <div
                className="text-sm text-[var(--color-text)] leading-relaxed bg-[var(--color-primary)]/5 p-4 sm:p-6 rounded-xl border border-[var(--color-primary)]/20"
                data-testid="product-spec-assurance"
              >
                <p className="font-bold text-[var(--color-primary)]">{assurance.label}</p>
                <p className="mt-2 text-[var(--color-text-muted)] whitespace-pre-wrap break-words">{assurance.policyText}</p>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  有效期至 {new Date(assurance.validUntil).toLocaleDateString()}
                </p>
              </div>
            ) : null}
          </div>
        </section>
      )}

      {showFaq && (
        <section id={SPEC_SECTION_IDS.faq} className={SECTION_SCROLL_MARGIN} data-testid={SPEC_SECTION_IDS.faq}>
          <SectionHeading icon={HelpCircle}>FAQ</SectionHeading>
          <div className="bg-[var(--color-background)] rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
            {resolvedDetails.faq
              .filter((item) => item.question.trim() && item.answer.trim())
              .map((item, index) => (
                <details key={`${item.question}-${index}`} className="px-4 py-1" data-testid={`product-spec-faq-${index}`}>
                  <summary className="cursor-pointer min-h-[44px] flex items-center text-sm font-medium text-[var(--color-text)]">
                    {item.question}
                  </summary>
                  <p className="pb-3 text-sm text-[var(--color-text-muted)] leading-relaxed whitespace-pre-wrap break-words">
                    {item.answer}
                  </p>
                </details>
              ))}
          </div>
        </section>
      )}
    </div>
  )
}
