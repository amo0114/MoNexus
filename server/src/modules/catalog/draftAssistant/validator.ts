import Ajv2020 from 'ajv/dist/2020.js'
import { getProductTemplate } from '../templates/registry.js'
import { validateTemplateAttributes } from '../templates/validate.js'
import { productDetailsSchema } from '../templates/productDetails.js'
import type { TemplateAttributes, TemplateKey } from '../templates/types.js'
import type { DraftAiContext } from './projection.js'
import { detectHardFacts, hasForbiddenMarkup } from '../contentCopilot/normalizers.js'
import { DRAFT_OUTPUT_SCHEMA, type DraftModelOutput } from './schema.js'

const validateStructure = new Ajv2020({ strict: true, allErrors: true, coerceTypes: false, removeAdditional: false })
  .compile<DraftModelOutput>(DRAFT_OUTPUT_SCHEMA)

export function validateDraftSuggestion(output: unknown, context: DraftAiContext) {
  if (!validateStructure(output)) throw new Error('Invalid draft suggestion structure')
  const raw = output
  let rejected = 0
  const source = context.untrusted.description
  function excerpt(value: string | null): string | null {
    if (value == null || value.trim() === '') return null
    if (hasForbiddenMarkup(value) || detectHardFacts(value).some(item => ['H2', 'H4', 'H7'].includes(item.cls))) {
      rejected++; return null
    }
    // Never turn 130 into 30 or split a signed/decimal quantity.
    let index = source.indexOf(value)
    while (index >= 0) {
      const before = source.slice(0, index)
      const after = source.slice(index + value.length)
      const cutsStart = /^[\d.]/.test(value) && /[\d.+-]$/.test(before)
      const cutsEnd = /\d$/.test(value) && /^[\d.%]/.test(after)
      if (!cutsStart && !cutsEnd) return value.trim()
      index = source.indexOf(value, index + 1)
    }
    rejected++
    return null
  }
  const proposedTemplate = context.facts.templates.find(template => template.key === raw.templateKey)
  const template = proposedTemplate ? getProductTemplate(proposedTemplate.key as TemplateKey, 1) : null
  const categoryId = context.facts.categories.find(category => category.id === raw.categoryId)?.id ?? null
  if (raw.templateKey && !template) rejected++
  if (raw.categoryId && categoryId == null) rejected++

  function attributes(target: 'product' | 'offer'): TemplateAttributes {
    const entries = target === 'product' ? raw.productAttributes : raw.offerAttributes
    const result: TemplateAttributes = {}
    const fields = target === 'product' ? proposedTemplate?.productFields : proposedTemplate?.offerFields
    const duplicates = new Set(entries.filter((entry, i) => entries.findIndex(item => item.key === entry.key) !== i).map(entry => entry.key))
    for (const entry of entries) {
      const field = fields?.find(item => item.key === entry.key)
      if (!template || !field || duplicates.has(entry.key) || entry.values.length === 0) { rejected++; continue }
      const values = entry.values.map(excerpt)
      if (values.some(value => value === null)) continue
      const strings = values as string[]
      let value: TemplateAttributes[string] | undefined
      if (field.type === 'array') value = strings
      else if (strings.length === 1) {
        if (field.options.length > 0) {
          const option = field.options.find(item => item.value === strings[0] || item.label === strings[0])
          if (option) value = field.type === 'integer' ? Number(option.value) : option.value
        } else if (field.type === 'integer' && /^-?(?:0|[1-9]\d*)$/.test(strings[0])) {
          const number = Number(strings[0])
          if (Number.isSafeInteger(number)) value = number
        } else if (field.type === 'string') value = strings[0]
      }
      if (value === undefined) { rejected++; continue }
      const validated = validateTemplateAttributes({
        templateKey: template.key, templateVersion: 1, mode: 'draft', target,
        attributes: { [entry.key]: value }, pathPrefix: '/attributes',
      })
      if (validated.ok) result[entry.key] = value
      else rejected++
    }
    return result
  }
  const productAttributes = attributes('product')
  const offerAttributes = attributes('offer')
  const details = productDetailsSchema.parse({
    highlights: raw.details.highlights.map(excerpt).filter((value): value is string => value != null),
    usageInstructions: excerpt(raw.details.usageInstructions) ?? '',
    purchaseNotes: excerpt(raw.details.purchaseNotes) ?? '',
    afterSalesInstructions: excerpt(raw.details.afterSalesInstructions) ?? '',
    faq: [],
  })
  const suggestion = {
    templateKey: template?.key ?? null,
    categoryId,
    name: excerpt(raw.name),
    description: excerpt(raw.description),
    offerName: excerpt(raw.offerName),
    attributes: productAttributes,
    offerAttributes,
    details,
  }
  const missingFields: string[] = []
  if (!template) missingFields.push('商品形态')
  if (!categoryId) missingFields.push('商品分类')
  if (!suggestion.name) missingFields.push('商品名称')
  if (template) {
    for (const [schema, values] of [[template.productSchema, productAttributes], [template.offerSchema, offerAttributes]] as const) {
      const properties = schema.properties as Record<string, { title?: string }>
      for (const key of (schema.required ?? []) as string[]) {
        if (!Object.hasOwn(values, key)) missingFields.push(properties[key]?.title ?? key)
      }
    }
  }
  return { suggestion, missingFields, rejectedFieldCount: rejected, truncated: context.truncated }
}
