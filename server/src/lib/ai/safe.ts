// SPEC-AI-001 §4 AI-R14 — the only values an LLM provider may receive are
// AI-safe projections. The brand makes "pass a Prisma entity / API DTO to the
// model" a type error; `markAiSafe` may only be called from projection files.

declare const aiSafeBrand: unique symbol

export type AiSafe<T> = T & { readonly [aiSafeBrand]: true }

export function markAiSafe<T>(value: T): AiSafe<T> {
  return value as AiSafe<T>
}
