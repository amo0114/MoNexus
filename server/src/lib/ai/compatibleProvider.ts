import { createAiFetch, normalizeAiBaseUrl } from './endpoint.js'
import { LlmError, type LlmProvider, type LlmStructuredRequest } from './provider.js'
import { structuredSystem, type AiWireSettings } from './protocol.js'

type Protocol = 'openai_chat' | 'anthropic_messages'
type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
const tokens = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null

function headers(protocol: Protocol, apiKey: string): Record<string, string> {
  return protocol === 'anthropic_messages'
    ? { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
}

/** Shared guarded fetch. No retries, redirects, raw error bodies or logging. */
async function fetchJson(fetcher: typeof fetch, url: string, init: RequestInit): Promise<JsonObject> {
  try {
    const response = await fetcher(url, init)
    if (!response.ok) {
      await response.body?.cancel()
      const code = response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'unavailable' : 'bad_request'
      throw new LlmError(code, response.status)
    }
    // Bound even an uncooperative gateway's response before parsing it.
    const reader = response.body?.getReader()
    if (!reader) throw new LlmError('output_unparseable')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 2 * 1024 * 1024) {
          await reader.cancel()
          throw new LlmError('output_unparseable')
        }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
    catch { throw new LlmError('output_unparseable') }
  } catch (err) {
    if (init.signal?.aborted) throw new LlmError('timeout')
    throw err instanceof LlmError ? err : new LlmError('unavailable')
  }
}

export function createCompatibleProvider(protocol: Protocol, apiKey: string, baseUrl: string, settings: AiWireSettings, fetcher = createAiFetch(baseUrl)): LlmProvider {
  const base = normalizeAiBaseUrl(baseUrl)
  const anthropic = protocol === 'anthropic_messages'
  return {
    name: `${protocol}:${settings.outputMode}:${settings.reasoningMode}${anthropic ? '' : ':' + (settings.chatTokenParameter ?? 'max_tokens')}`,
    async generateStructured(req: LlmStructuredRequest) {
      const system = structuredSystem(req, settings.outputMode)
      const body = anthropic ? {
        model: req.model, system, messages: [{ role: 'user', content: JSON.stringify(req.input) }],
        max_tokens: req.maxOutputTokens,
        ...(settings.outputMode === 'json_schema' ? { output_config: { format: { type: 'json_schema', schema: req.outputSchema } } } : {}),
        ...(settings.reasoningMode === 'none' ? { thinking: { type: 'disabled' } } : {}),
      } : {
        model: req.model, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(req.input) }],
        [settings.chatTokenParameter ?? 'max_tokens']: req.maxOutputTokens, stream: false,
        response_format: settings.outputMode === 'json_schema'
          ? { type: 'json_schema', json_schema: { name: req.schemaName, schema: req.outputSchema, strict: true } }
          : { type: 'json_object' },
        ...(settings.reasoningMode === 'none' ? { reasoning_effort: 'none' } : {}),
      }
      const response = await fetchJson(fetcher, `${base}/${anthropic ? 'messages' : 'chat/completions'}`, {
        method: 'POST', headers: headers(protocol, apiKey), body: JSON.stringify(body), signal: req.signal,
      })
      let text: string
      if (anthropic) {
        if (response.stop_reason === 'refusal') throw new LlmError('refused')
        if (response.stop_reason !== 'end_turn' || !Array.isArray(response.content)) throw new LlmError('output_unparseable')
        const blocks = response.content.map(object)
        if (blocks.some(block => !['text', 'thinking', 'redacted_thinking'].includes(String(block.type)))) throw new LlmError('output_unparseable')
        const parts = blocks.filter(block => block.type === 'text')
        if (!parts.length || parts.some(part => typeof part.text !== 'string')) throw new LlmError('output_unparseable')
        text = parts.map(part => part.text).join('')
      } else {
        if (!Array.isArray(response.choices) || response.choices.length !== 1) throw new LlmError('output_unparseable')
        const choice = object(response.choices[0])
        const message = object(choice.message)
        if (message.refusal || choice.finish_reason === 'content_filter') throw new LlmError('refused')
        if (choice.finish_reason !== 'stop' || message.tool_calls || message.function_call || typeof message.content !== 'string') throw new LlmError('output_unparseable')
        text = message.content
      }
      let output: unknown
      try { output = JSON.parse(text) } catch { throw new LlmError('output_unparseable') }
      const usage = object(response.usage)
      if (typeof response.model !== 'string' || !response.model || response.model.length > 200) throw new LlmError('output_unparseable')
      return { output, model: response.model, usage: {
        inputTokens: tokens(anthropic ? usage.input_tokens : usage.prompt_tokens),
        outputTokens: tokens(anthropic ? usage.output_tokens : usage.completion_tokens),
      } }
    },
  }
}

/** Retrieval avoids treating a partial model-list page as proof of absence. */
export async function probeAnthropicConnection(apiKey: string, model: string, baseUrl: string, fetcher = createAiFetch(baseUrl)): Promise<void> {
  const response = await fetchJson(fetcher, `${normalizeAiBaseUrl(baseUrl)}/models/${encodeURIComponent(model)}`, {
    headers: headers('anthropic_messages', apiKey), signal: AbortSignal.timeout(10_000),
  })
  if (typeof response.id !== 'string' || !response.id) throw new LlmError('bad_request', 404)
}
