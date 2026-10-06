// SPEC-AI-001 §6 — thin provider boundary. Features depend on this interface
// only; the OpenAI SDK is imported exclusively by openaiProvider.ts.

import type { AiSafe } from './safe.js'

export interface LlmStructuredRequest {
  model: string
  reasoningEffort: 'none'
  schemaName: string
  system: string
  input: AiSafe<unknown>
  outputSchema: Record<string, unknown>
  maxOutputTokens: number
  signal: AbortSignal
}

export interface LlmStructuredResult {
  /** Untrusted until the feature validator accepts it. */
  output: unknown
  usage: { inputTokens: number | null; outputTokens: number | null }
  model: string
}

export interface LlmProvider {
  readonly name: string
  generateStructured(req: LlmStructuredRequest): Promise<LlmStructuredResult>
}

export type LlmErrorCode =
  | 'timeout'
  | 'rate_limited'
  | 'unavailable'
  | 'refused'
  | 'bad_request'
  | 'output_unparseable'

export class LlmError extends Error {
  // The message is the code on purpose: provider error bodies may echo the
  // prompt, and messages flow into logs and Sentry (SPEC-AI-001 §6.2).
  constructor(readonly code: LlmErrorCode, readonly providerStatus?: number) {
    super(code)
    this.name = 'LlmError'
  }
}

let providerOverride: LlmProvider | null = null
let defaultProvider: LlmProvider | null = null

/** Test-only injection, same convention as externalCatalog's client overrides. */
export function setLlmProviderForTests(provider: LlmProvider | null): void {
  providerOverride = provider
}

export async function getLlmProvider(): Promise<LlmProvider> {
  if (providerOverride) return providerOverride
  if (!defaultProvider) {
    const { createOpenAiProvider } = await import('./openaiProvider.js')
    defaultProvider = createOpenAiProvider()
  }
  return defaultProvider
}
