import type { LlmStructuredRequest } from './provider.js'

export const AI_PROTOCOLS = ['openai_responses', 'openai_chat', 'anthropic_messages'] as const
export const AI_OUTPUT_MODES = ['json_schema', 'json_object'] as const
export const AI_CHAT_TOKEN_PARAMETERS = ['max_tokens', 'max_completion_tokens'] as const
export type AiChatTokenParameter = typeof AI_CHAT_TOKEN_PARAMETERS[number]
export const AI_REASONING_MODES = ['none', 'default'] as const
export type AiProtocol = typeof AI_PROTOCOLS[number]
export type AiOutputMode = typeof AI_OUTPUT_MODES[number]
export type AiReasoningMode = typeof AI_REASONING_MODES[number]
export type AiWireSettings = { outputMode: AiOutputMode; reasoningMode: AiReasoningMode; chatTokenParameter?: AiChatTokenParameter }
export const DEFAULT_AI_WIRE_SETTINGS: AiWireSettings = { outputMode: 'json_schema', reasoningMode: 'none' }

// Only the static schema enters the system prompt. User input remains separate.
export function structuredSystem(req: LlmStructuredRequest, mode: AiOutputMode): string {
  return mode === 'json_schema' ? req.system
    : `${req.system}\nReturn only a JSON object conforming to this JSON Schema. Do not use Markdown fences.\n${JSON.stringify(req.outputSchema)}`
}
