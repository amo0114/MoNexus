import { z } from 'zod'
import { MAX_DRAFT_DESCRIPTION } from './projection.js'

export const draftSuggestionRequestSchema = z.object({
  description: z.string().trim().min(1).max(MAX_DRAFT_DESCRIPTION),
}).strict()

const text = (maxLength: number) => ({ type: ['string', 'null'], maxLength })
const attribute = {
  type: 'object', additionalProperties: false, required: ['key', 'values'],
  properties: {
    key: { type: 'string', minLength: 1, maxLength: 80 },
    values: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1000 } },
  },
}
export const DRAFT_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['templateKey', 'categoryId', 'name', 'description', 'offerName', 'productAttributes', 'offerAttributes', 'details'],
  properties: {
    templateKey: text(80),
    categoryId: { type: ['integer', 'null'], minimum: 1 },
    name: text(100),
    description: text(2000),
    offerName: text(50),
    productAttributes: { type: 'array', maxItems: 30, items: attribute },
    offerAttributes: { type: 'array', maxItems: 30, items: attribute },
    details: {
      type: 'object', additionalProperties: false,
      required: ['highlights', 'usageInstructions', 'purchaseNotes', 'afterSalesInstructions'],
      properties: {
        highlights: { type: 'array', maxItems: 4, items: { type: 'string', minLength: 1, maxLength: 40 } },
        usageInstructions: text(4000), purchaseNotes: text(2000), afterSalesInstructions: text(2000),
      },
    },
  },
}

// Provider subset derives from the complete schema to keep structural contracts identical.
function providerSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(providerSchema)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) =>
      !['minLength', 'maxLength', 'maxItems', 'minimum'].includes(key),
    ).map(([key, child]) => [key, providerSchema(child)]))
  }
  return value
}
export const DRAFT_MODEL_SCHEMA = providerSchema(DRAFT_OUTPUT_SCHEMA) as Record<string, unknown>

export type DraftModelOutput = {
  templateKey: string | null
  categoryId: number | null
  name: string | null
  description: string | null
  offerName: string | null
  productAttributes: Array<{ key: string; values: string[] }>
  offerAttributes: Array<{ key: string; values: string[] }>
  details: {
    highlights: string[]
    usageInstructions: string | null
    purchaseNotes: string | null
    afterSalesInstructions: string | null
  }
}
