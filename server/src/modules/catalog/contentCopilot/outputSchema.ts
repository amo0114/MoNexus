// SPEC-AI-PRODUCT-001 §6.1 / §6.2 — model output contract. The same schema is
// sent to OpenAI (strict mode: every property required, no extra keys,
// nullable via anyOf) and used for the server-side structural check. Length
// and count limits are enforced by the validator, never by the provider.

import Ajv2020 from 'ajv/dist/2020.js'
import { CONTENT_FIELDS } from './constants.js'

export const CLAIM_KINDS = [
  'duration',
  'quantity',
  'region',
  'platform',
  'delivery_method',
  'delivery_timing',
  'service_duration',
  'price',
  'stock',
  'refund',
  'guarantee',
] as const
export type ClaimKind = (typeof CLAIM_KINDS)[number]

export const MODEL_ISSUE_KINDS = ['missing', 'ambiguous', 'risky_claim'] as const
export type ModelIssueKind = (typeof MODEL_ISSUE_KINDS)[number]

export type Claim = { kind: ClaimKind; span: string; factRef: string | null }
export type TextUnit = { text: string; claims: Claim[] }
export type FaqUnit = { question: string; answer: string; claims: Claim[] }
export type ModelIssue = {
  kind: ModelIssueKind
  field: (typeof CONTENT_FIELDS)[number] | 'attributes' | null
  message: string
  evidence: string | null
}
export type ModelOutput = {
  description: TextUnit | null
  highlights: TextUnit[] | null
  usageInstructions: TextUnit | null
  purchaseNotes: TextUnit | null
  afterSalesInstructions: TextUnit | null
  faq: FaqUnit[] | null
  issues: ModelIssue[]
}

const claimSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'span', 'factRef'],
  properties: {
    kind: { type: 'string', enum: [...CLAIM_KINDS] },
    span: { type: 'string' },
    factRef: { type: ['string', 'null'] },
  },
}

const textUnitSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'claims'],
  properties: {
    text: { type: 'string' },
    claims: { type: 'array', items: claimSchema },
  },
}

const faqUnitSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['question', 'answer', 'claims'],
  properties: {
    question: { type: 'string' },
    answer: { type: 'string' },
    claims: { type: 'array', items: claimSchema },
  },
}

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] })

export const MODEL_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [...CONTENT_FIELDS, 'issues'],
  properties: {
    description: nullable(textUnitSchema),
    highlights: nullable({ type: 'array', items: textUnitSchema }),
    usageInstructions: nullable(textUnitSchema),
    purchaseNotes: nullable(textUnitSchema),
    afterSalesInstructions: nullable(textUnitSchema),
    faq: nullable({ type: 'array', items: faqUnitSchema }),
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'field', 'message', 'evidence'],
        properties: {
          kind: { type: 'string', enum: [...MODEL_ISSUE_KINDS] },
          field: { type: ['string', 'null'], enum: [...CONTENT_FIELDS, 'attributes', null] },
          message: { type: 'string' },
          evidence: { type: ['string', 'null'] },
        },
      },
    },
  },
}

const ajv = new Ajv2020({
  strict: true,
  allowUnionTypes: true,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
})

const validateStructure = ajv.compile<ModelOutput>(MODEL_OUTPUT_SCHEMA)

export function isModelOutput(value: unknown): value is ModelOutput {
  return validateStructure(value)
}
