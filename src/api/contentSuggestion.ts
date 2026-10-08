import api from './client'
import type { ProductEditorActor } from './catalog'

// SPEC-AI-PRODUCT-001 §6.4 / §9 — AI content suggestions. Suggestions are
// only ever written into the editor's unsaved form; saving still goes through
// the regular content PATCH with expectedContentVersion.

export const CONTENT_SUGGESTION_FIELDS = [
  'description',
  'highlights',
  'usageInstructions',
  'purchaseNotes',
  'afterSalesInstructions',
  'faq',
] as const
export type ContentSuggestionField = (typeof CONTENT_SUGGESTION_FIELDS)[number]

export type ContentSuggestionFaqItem = { question: string; answer: string }

export type FieldSuggestion =
  | { status: 'suggested'; value: string | string[] | ContentSuggestionFaqItem[]; rejectedItemCount: number }
  | { status: 'rejected'; value: null; rejectedItemCount: number }
  | { status: 'not_generated'; value: null; rejectedItemCount: 0 }

export type ContentSuggestionIssue = {
  kind: 'missing' | 'ambiguous' | 'risky_claim' | 'unsupported_fact'
  origin: 'model' | 'validator'
  field: ContentSuggestionField | 'attributes' | null
  message: string
  evidence: string | null
}

export type ContentSuggestionResponse = {
  generationId: number
  basedOnContentVersion: number
  promptVersion: string
  validatorVersion: string
  fields: Partial<Record<ContentSuggestionField, FieldSuggestion>>
  issues: ContentSuggestionIssue[]
}

export type ContentSuggestionRequest = {
  expectedContentVersion: number
  targetFields?: ContentSuggestionField[]
  sourceNotes?: string
  /** Admin + Xboard-imported products only. */
  useUpstreamDescription?: boolean
}

// Server timeout is ≤50s behind nginx's 60s; the global 15s client default
// would abort every generation (SPEC-AI-001 §9.1).
const CONTENT_SUGGESTION_TIMEOUT_MS = 55_000

function basePath(actor: ProductEditorActor): string {
  return actor === 'admin' ? '/admin' : '/merchant'
}

export async function requestContentSuggestion(
  actor: ProductEditorActor,
  productId: number,
  payload: ContentSuggestionRequest,
): Promise<ContentSuggestionResponse> {
  const { data } = await api.post<ContentSuggestionResponse>(
    `${basePath(actor)}/products/${productId}/content-suggestions`,
    payload,
    { timeout: CONTENT_SUGGESTION_TIMEOUT_MS },
  )
  return data
}

/** Best-effort telemetry (CP-12); callers ignore failures. */
export async function reportContentSuggestionApplied(
  actor: ProductEditorActor,
  productId: number,
  generationId: number,
  appliedFieldCount: number,
): Promise<void> {
  await api.post(
    `${basePath(actor)}/products/${productId}/content-suggestions/${generationId}/applied`,
    { appliedFieldCount },
  )
}
