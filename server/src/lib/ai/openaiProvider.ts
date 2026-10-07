// SPEC-AI-001 §6.3 — Responses adapter. Legacy defaults stay unchanged;
// output and reasoning modes are explicit runtime settings. No tools, retries,
// background mode or content logging; store=false is always sent.

import OpenAI from 'openai'
import { LlmError, type LlmProvider, type LlmStructuredRequest, type LlmStructuredResult } from './provider.js'
import { createAiFetch, DEFAULT_AI_BASE_URL, normalizeAiBaseUrl } from './endpoint.js'
import { DEFAULT_AI_WIRE_SETTINGS, structuredSystem, type AiWireSettings } from './protocol.js'

type OpenAiClient = Pick<OpenAI, 'responses'>

function mapSdkError(err: unknown): LlmError {
  if (err instanceof LlmError) return err
  if (err instanceof OpenAI.APIUserAbortError || err instanceof OpenAI.APIConnectionTimeoutError) {
    return new LlmError('timeout')
  }
  if (err instanceof OpenAI.APIConnectionError) return new LlmError('unavailable')
  if (err instanceof OpenAI.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined
    if (status === 429) return new LlmError('rate_limited', status)
    if (status != null && status >= 500) return new LlmError('unavailable', status)
    return new LlmError('bad_request', status)
  }
  return new LlmError('unavailable')
}

function readStructuredText(response: OpenAI.Responses.Response): string {
  if (response.status === 'incomplete') throw new LlmError('output_unparseable')
  for (const item of response.output) {
    if (item.type !== 'message') continue
    for (const part of item.content) {
      if (part.type === 'refusal') throw new LlmError('refused')
    }
  }
  if (response.status !== 'completed' || !response.output_text) {
    throw new LlmError('output_unparseable')
  }
  return response.output_text
}

function createClient(apiKey: string, baseUrl: string) {
  return new OpenAI({
    apiKey,
    baseURL: normalizeAiBaseUrl(baseUrl),
    fetch: createAiFetch(baseUrl),
    maxRetries: 0,
    logLevel: 'off',
  })
}

export function createOpenAiProvider(client?: OpenAiClient, apiKey = '', baseUrl = DEFAULT_AI_BASE_URL, settings: AiWireSettings = DEFAULT_AI_WIRE_SETTINGS): LlmProvider {
  const sdk: OpenAiClient = client ?? createClient(apiKey, baseUrl)

  return {
    name: `openai_responses:${settings.outputMode}:${settings.reasoningMode}`,
    async generateStructured(req: LlmStructuredRequest): Promise<LlmStructuredResult> {
      let response: OpenAI.Responses.Response
      try {
        response = await sdk.responses.create(
          {
            model: req.model,
            instructions: structuredSystem(req, settings.outputMode),
            input: JSON.stringify(req.input),
            text: {
              format: settings.outputMode === 'json_object' ? { type: 'json_object' } : {
                type: 'json_schema',
                name: req.schemaName,
                schema: req.outputSchema,
                strict: true,
              },
            },
            ...(settings.reasoningMode === 'none' ? { reasoning: { effort: req.reasoningEffort } } : {}),
            store: false,
            max_output_tokens: req.maxOutputTokens,
          },
          { signal: req.signal },
        )
      } catch (err) {
        throw mapSdkError(err)
      }

      const text = readStructuredText(response)
      let output: unknown
      try {
        output = JSON.parse(text)
      } catch {
        throw new LlmError('output_unparseable')
      }
      return {
        output,
        usage: {
          inputTokens: response.usage?.input_tokens ?? null,
          outputTokens: response.usage?.output_tokens ?? null,
        },
        model: response.model,
      }
    },
  }
}

/** Model lists are widely supported by OpenAI-compatible gateways. No product data is sent. */
export async function probeOpenAiConnection(apiKey: string, model: string, baseUrl = DEFAULT_AI_BASE_URL, client?: Pick<OpenAI, 'models'>): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const models = await (client ?? createClient(apiKey, baseUrl)).models.list({ signal: controller.signal })
    if (!models.data.some(item => item.id === model)) throw new LlmError('bad_request', 404)
  } catch (err) {
    throw controller.signal.aborted ? new LlmError('timeout') : mapSdkError(err)
  } finally {
    clearTimeout(timer)
  }
}
