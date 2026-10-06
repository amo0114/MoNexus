// SPEC-AI-001 §6.3 (D-AI-01) — the single OpenAI adapter. Request shape is
// frozen: Responses API, strict JSON Schema output, store=false, no tools, no
// background mode, no SDK retries. Nothing here logs prompts or outputs.

import OpenAI from 'openai'
import { config } from '../../config/index.js'
import { LlmError, type LlmProvider, type LlmStructuredRequest, type LlmStructuredResult } from './provider.js'

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

export function createOpenAiProvider(client?: OpenAiClient): LlmProvider {
  const sdk: OpenAiClient = client ?? new OpenAI({
    // Explicit key from validated config; the SDK must not read env on its own.
    apiKey: config.ai.openaiApiKey ?? '',
    maxRetries: 0,
  })

  return {
    name: 'openai',
    async generateStructured(req: LlmStructuredRequest): Promise<LlmStructuredResult> {
      let response: OpenAI.Responses.Response
      try {
        response = await sdk.responses.create(
          {
            model: req.model,
            instructions: req.system,
            input: JSON.stringify(req.input),
            text: {
              format: {
                type: 'json_schema',
                name: req.schemaName,
                schema: req.outputSchema,
                strict: true,
              },
            },
            reasoning: { effort: req.reasoningEffort },
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
