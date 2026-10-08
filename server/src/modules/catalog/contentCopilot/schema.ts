import { z } from 'zod'
import { CONTENT_FIELDS, MAX_SOURCE_NOTES } from './constants.js'

// SPEC-AI-PRODUCT-001 §5.1 — the merchant body has no useUpstreamDescription
// key at all; `.strict()` turns any attempt into a 400.
const targetFieldsSchema = z.array(z.enum(CONTENT_FIELDS))
  .min(1, 'targetFields 不能为空')
  .refine(fields => new Set(fields).size === fields.length, 'targetFields 不能重复')

export const merchantContentSuggestionSchema = z.object({
  expectedContentVersion: z.number().int().positive(),
  targetFields: targetFieldsSchema.optional(),
  sourceNotes: z.string().trim().max(MAX_SOURCE_NOTES, `补充说明最多 ${MAX_SOURCE_NOTES} 字`).optional(),
}).strict()

export const adminContentSuggestionSchema = merchantContentSuggestionSchema.extend({
  useUpstreamDescription: z.boolean().optional(),
}).strict()

export type ContentSuggestionRequest = z.infer<typeof adminContentSuggestionSchema>

export const contentSuggestionAppliedSchema = z.object({
  appliedFieldCount: z.number().int().min(1),
}).strict()

export const contentSuggestionParamSchema = z.object({
  id: z.coerce.number().int().positive('必须是正整数'),
  generationId: z.coerce.number().int().positive('必须是正整数'),
})
