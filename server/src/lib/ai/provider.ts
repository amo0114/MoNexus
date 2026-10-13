// SPEC-AI-001 §6 — thin provider boundary. Features depend on this interface
// only; the OpenAI SDK is imported exclusively by openaiProvider.ts.

import type { AiSafe } from './safe.js'
import type { AiWireSettings, AiProtocol } from './protocol.js'
import { getAiRuntimeConfig } from './runtimeConfig.js'

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

/** A transport compatibility rule the output was accepted through (SPEC-AI-001 §6.4). */
export type LlmOutputCompat = 'repeated_json'

export interface LlmStructuredResult {
  /** Untrusted until the feature validator accepts it. */
  output: unknown
  usage: { inputTokens: number | null; outputTokens: number | null }
  model: string
  /** Set only when the output did not follow the structured-output contract as returned. */
  outputCompat?: LlmOutputCompat
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

/**
 * Content-free shape of an unusable response, for logs and eval reports. A
 * closed set: never provider text or provider-supplied strings.
 */
export type LlmErrorDetail =
  | 'body_missing' | 'body_too_large' | 'body_not_json'
  | 'choices_count' | 'finish_length' | 'finish_other' | 'tool_call' | 'content_not_text' | 'content_blocks'
  | 'incomplete' | 'not_completed' | 'empty_text' | 'multiple_messages'
  | 'text_fenced' | 'text_not_json' | 'model_missing'

export class LlmError extends Error {
  // The message is the code on purpose: provider error bodies may echo the
  // prompt, and messages flow into logs and Sentry (SPEC-AI-001 §6.2).
  constructor(readonly code: LlmErrorCode, readonly providerStatus?: number, readonly detail?: LlmErrorDetail) {
    super(code)
    this.name = 'LlmError'
  }
}

/** End (exclusive) of the JSON object opening at `start`, honouring strings and escapes; -1 if it never closes. */
function objectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
    } else if (ch === '{' || ch === '[') {
      depth += 1
    } else if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/**
 * The structured output text as JSON; a failure only reports its shape.
 *
 * Bounded compatibility (SPEC-AI-001 §6.4): some gateways append leaked text
 * after the object and then repeat it. Only a complete leading object whose
 * exact text also ends the response is accepted; the text between is dropped
 * unread. No scanning for JSON elsewhere, no repair of truncated output, no
 * choice between differing objects. Validation is unchanged.
 */
export function parseStructuredText(text: string, detail?: LlmErrorDetail): { output: unknown; compat?: LlmOutputCompat } {
  try {
    return { output: JSON.parse(text) }
  } catch {
    const body = text.trim()
    const end = body.startsWith('{') ? objectEnd(body, 0) : -1
    if (end > 0 && body.length >= 2 * end && body.endsWith(body.slice(0, end))) {
      try {
        return { output: JSON.parse(body.slice(0, end)), compat: 'repeated_json' }
      } catch {
        // A malformed leading object is not accepted either.
      }
    }
    throw new LlmError('output_unparseable', undefined, detail ?? (/^\s*```/.test(text) ? 'text_fenced' : 'text_not_json'))
  }
}

let providerOverride: LlmProvider | null = null

/** Test-only injection, same convention as externalCatalog's client overrides. */
export function setLlmProviderForTests(provider: LlmProvider | null): void {
  providerOverride = provider
}

export async function getLlmProvider(settings?: { apiKey: string | null; baseUrl: string; protocol: AiProtocol } & AiWireSettings): Promise<LlmProvider> {
  if (providerOverride) return providerOverride
  const runtime = settings ?? await getAiRuntimeConfig()
  if (!runtime.apiKey) throw new LlmError('unavailable')
  if (runtime.protocol === 'openai_chat' || runtime.protocol === 'anthropic_messages') {
    const { createCompatibleProvider } = await import('./compatibleProvider.js')
    return createCompatibleProvider(runtime.protocol, runtime.apiKey, runtime.baseUrl, runtime)
  }
  if (runtime.protocol !== 'openai_responses') throw new LlmError('unavailable')
  const { createOpenAiProvider } = await import('./openaiProvider.js')
  return createOpenAiProvider(undefined, runtime.apiKey, runtime.baseUrl, { outputMode: runtime.outputMode, reasoningMode: runtime.reasoningMode })
}
