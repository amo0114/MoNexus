import { markAiSafe, type AiSafe } from '../../../lib/ai/safe.js'
import { HttpError } from '../../../lib/httpError.js'
import type { ProductTemplateDefinition } from '../templates/types.js'

export const MAX_DRAFT_DESCRIPTION = 4000
export const MAX_DRAFT_CONTEXT = 24000

export type DraftField = {
  key: string
  label: string
  type: string
  options: Array<{ value: string; label: string }>
}
export type DraftAiContext = {
  facts: {
    product: null
    templates: Array<{ key: string; label: string; productFields: DraftField[]; offerFields: DraftField[] }>
    categories: Array<{ id: number; label: string }>
  }
  declared: Record<string, never>
  untrusted: { description: string }
  truncated: boolean
}

function fields(template: ProductTemplateDefinition, target: 'product' | 'offer'): DraftField[] {
  const schema = target === 'product' ? template.productSchema : template.offerSchema
  const properties = schema.properties as Record<string, Record<string, unknown>>
  const order = target === 'product' ? template.ui.productOrder : template.ui.offerOrder
  return order.map(key => {
    const property = properties[key]
    return {
      key,
      label: String(property.title ?? key),
      type: String(property.type),
      options: Array.isArray(property.enum) ? property.enum.map(value => ({
        value: String(value),
        label: template.ui.enumLabels?.[key]?.[String(value)] ?? String(value),
      })) : [],
    }
  })
}

/** Only public author-supplied text and the governed catalog; never an editor DTO. */
export function buildProductDraftAiContext(input: {
  description: string
  templates: ProductTemplateDefinition[]
  categories: Array<{ id: number; label: string }>
}): AiSafe<DraftAiContext> {
  const context: DraftAiContext = {
    facts: {
      product: null,
      templates: input.templates.map(template => ({
        key: template.key,
        label: template.label,
        productFields: fields(template, 'product'),
        offerFields: fields(template, 'offer'),
      })),
      categories: input.categories.map(category => ({ id: category.id, label: category.label })),
    },
    declared: {},
    untrusted: { description: input.description.slice(0, MAX_DRAFT_DESCRIPTION) },
    truncated: input.description.length > MAX_DRAFT_DESCRIPTION,
  }
  while (JSON.stringify(context).length > MAX_DRAFT_CONTEXT && context.untrusted.description.length > 0) {
    const excess = JSON.stringify(context).length - MAX_DRAFT_CONTEXT
    context.untrusted.description = context.untrusted.description.slice(0, Math.max(0, context.untrusted.description.length - excess))
    context.truncated = true
  }
  if (JSON.stringify(context).length > MAX_DRAFT_CONTEXT || context.untrusted.description.trim() === '') {
    throw new HttpError(422, 'AI_CONTEXT_TOO_LARGE', '商品信息或目录过多，请缩短介绍或使用手动创建')
  }
  return markAiSafe(context)
}
