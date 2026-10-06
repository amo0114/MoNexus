// SPEC-AI-PRODUCT-001 §6.3 / §10 — version-bound constants. Changing the
// prompt, output schema, projection shape, model or call parameters requires a
// new PROMPT_VERSION; changing lexicons or judgement rules requires a new
// VALIDATOR_VERSION (SPEC-AI-001 §12).

export const CONTENT_COPILOT_FEATURE = 'product_content_copilot' as const
export const PROMPT_VERSION = 'product-content@1'
export const VALIDATOR_VERSION = 'product-content-validator@1'

export const MODEL_BINDING = {
  model: 'gpt-6-luna',
  reasoningEffort: 'none',
  schemaName: 'product_content_suggestion',
  maxOutputTokens: 8000,
} as const

export const CONTENT_FIELDS = [
  'description',
  'highlights',
  'usageInstructions',
  'purchaseNotes',
  'afterSalesInstructions',
  'faq',
] as const
export type ContentField = (typeof CONTENT_FIELDS)[number]

/** AI suggestions are shorter than product limits to cut latency and fabrication surface. */
export const GENERATION_LIMITS = {
  descriptionMax: 300,
  highlightsMaxItems: 4,
  highlightMax: 40,
  usageInstructionsMax: 1200,
  purchaseNotesMax: 600,
  afterSalesInstructionsMax: 600,
  faqMaxItems: 6,
  faqQuestionMax: 60,
  faqAnswerMax: 300,
} as const
export type GenerationLimits = typeof GENERATION_LIMITS

export const MAX_CONTEXT_CHARS = 24_000
export const MAX_SOURCE_NOTES = 2_000
export const MAX_MODEL_ISSUES = 12
export const MAX_ISSUE_TEXT = 200
export const MAX_CLAIMS_PER_UNIT = 12
export const MAX_SPAN_LENGTH = 80
