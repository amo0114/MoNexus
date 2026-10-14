// Shared L3 provider setup (SPEC-AI-001 §13). With AI_EVAL_BASE_URL set, an
// eval uses only AI_EVAL_* variables: the key never enters the database, logs
// or report. Otherwise the copilot and draft evals use the saved admin config.
//
//   AI_EVAL_BASE_URL, AI_EVAL_MODEL, AI_EVAL_API_KEY            required
//   AI_EVAL_PROTOCOL       openai_chat | anthropic_messages | openai_responses (default openai_chat)
//   AI_EVAL_OUTPUT_MODE    json_schema | json_object (default json_schema)
//   AI_EVAL_REASONING      default | none (default default)
//   AI_EVAL_MAX_CALLS      hard cap on provider calls for the whole run (default 150)

import { getLlmProvider, type LlmProvider } from '../lib/ai/provider.js'
import { AI_OUTPUT_MODES, AI_PROTOCOLS, AI_REASONING_MODES, type AiOutputMode, type AiProtocol, type AiReasoningMode } from '../lib/ai/protocol.js'
import { getAiRuntimeConfig } from '../lib/ai/runtimeConfig.js'

export function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (!value) throw new Error(`${name} is required`)
  return value
}

function oneOf<T extends string>(name: string, values: readonly T[], fallback: T): T {
  const value = (process.env[name] ?? fallback) as T
  if (!values.includes(value)) throw new Error(`${name} must be one of ${values.join(', ')}`)
  return value
}

export type EvalSettings = {
  baseUrl: string
  model: string
  protocol: AiProtocol
  outputMode: AiOutputMode
  reasoningMode: AiReasoningMode
  maxCalls: number
}

export function evalSettingsFromEnv(): EvalSettings {
  return {
    baseUrl: env('AI_EVAL_BASE_URL'),
    model: env('AI_EVAL_MODEL'),
    protocol: oneOf<AiProtocol>('AI_EVAL_PROTOCOL', AI_PROTOCOLS, 'openai_chat'),
    outputMode: oneOf<AiOutputMode>('AI_EVAL_OUTPUT_MODE', AI_OUTPUT_MODES, 'json_schema'),
    reasoningMode: oneOf<AiReasoningMode>('AI_EVAL_REASONING', AI_REASONING_MODES, 'default'),
    maxCalls: Number(env('AI_EVAL_MAX_CALLS', '150')),
  }
}

export async function createEvalProvider(settings: EvalSettings): Promise<LlmProvider> {
  const apiKey = env('AI_EVAL_API_KEY')
  const wire = { outputMode: settings.outputMode, reasoningMode: settings.reasoningMode }
  if (settings.protocol === 'openai_responses') {
    const { createOpenAiProvider } = await import('../lib/ai/openaiProvider.js')
    return createOpenAiProvider(undefined, apiKey, settings.baseUrl, wire)
  }
  const { createCompatibleProvider } = await import('../lib/ai/compatibleProvider.js')
  return createCompatibleProvider(settings.protocol, apiKey, settings.baseUrl, wire)
}

/** Provider and model for a single-call eval, plus the redacted configuration recorded in its report. */
export async function loadEvalRuntime(): Promise<{ provider: LlmProvider; model: string; config: Record<string, unknown> }> {
  if (process.env.AI_EVAL_BASE_URL) {
    const settings = evalSettingsFromEnv()
    return {
      provider: await createEvalProvider(settings),
      model: settings.model,
      config: {
        source: 'AI_EVAL', protocol: settings.protocol, outputMode: settings.outputMode, reasoningMode: settings.reasoningMode,
        model: settings.model, baseUrlHost: new URL(settings.baseUrl).host,
      },
    }
  }
  const runtime = await getAiRuntimeConfig()
  if (!runtime.apiKey || runtime.credentialError) {
    throw new Error('Configure an AI key in admin AI settings, or set AI_EVAL_* variables, to run the L3 eval')
  }
  return {
    provider: await getLlmProvider(runtime),
    model: runtime.model,
    config: {
      source: 'admin', configVersion: runtime.version, chatTokenParameter: runtime.chatTokenParameter, protocol: runtime.protocol,
      outputMode: runtime.outputMode, reasoningMode: runtime.reasoningMode, model: runtime.model, baseUrl: runtime.baseUrl,
    },
  }
}
