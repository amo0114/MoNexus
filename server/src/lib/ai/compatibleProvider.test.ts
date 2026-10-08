import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCompatibleProvider, probeAnthropicConnection } from './compatibleProvider.js'
import { getLlmProvider, LlmError, type LlmStructuredRequest } from './provider.js'
import { markAiSafe } from './safe.js'

const req: LlmStructuredRequest = {
  model: 'gateway/model-alias', reasoningEffort: 'none', schemaName: 'draft', system: 'fixed system',
  input: markAiSafe({ untrusted: { text: 'USER_SENTINEL' } }),
  outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
  maxOutputTokens: 6000, signal: new AbortController().signal,
}
const base = 'https://gateway.example/custom/v1'
const key = 'sk-SECRET_SENTINEL'
const settings = { outputMode: 'json_schema', reasoningMode: 'default' } as const
const chat = { model: 'reported-model', choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }
const anthropic = { model: 'reported-model', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 10, output_tokens: 20 } }
const mockFetch = (value: unknown, status = 200) => vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(value), { status }))
afterEach(() => vi.restoreAllMocks())

describe('third-party protocol adapters', () => {
  it('can send max_completion_tokens alone without guessing from a model name', async () => {
    const fetcher = mockFetch(chat)
    await createCompatibleProvider('openai_chat', key, base, { ...settings, chatTokenParameter: 'max_completion_tokens' }, fetcher).generateStructured(req)
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(body.max_completion_tokens).toBe(req.maxOutputTokens)
    expect(body).not.toHaveProperty('max_tokens')
    expect(body.model).toBe(req.model)
  })
  it('sends Chat messages, configured alias, schema and token limit without Responses-only fields', async () => {
    const fetcher = mockFetch(chat)
    const result = await createCompatibleProvider('openai_chat', key, base, settings, fetcher).generateStructured(req)
    expect(result).toEqual({ output: { ok: true }, model: 'reported-model', usage: { inputTokens: 10, outputTokens: 20 } })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe(base + '/chat/completions')
    expect(init?.headers).toEqual({ 'content-type': 'application/json', authorization: `Bearer ${key}` })
    expect(init?.signal).toBe(req.signal)
    expect(JSON.parse(String(init?.body))).toEqual({
      model: req.model, messages: [{ role: 'system', content: req.system }, { role: 'user', content: JSON.stringify(req.input) }],
      max_tokens: 6000, stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'draft', strict: true, schema: req.outputSchema } },
    })
  })

  it('uses Anthropic headers, top-level system and native output_config at the configured gateway', async () => {
    const fetcher = mockFetch(anthropic)
    await createCompatibleProvider('anthropic_messages', key, base, settings, fetcher).generateStructured(req)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe(base + '/messages')
    expect(init?.headers).toEqual({ 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' })
    expect(JSON.parse(String(init?.body))).toEqual({ model: req.model, system: req.system,
      messages: [{ role: 'user', content: JSON.stringify(req.input) }], max_tokens: 6000,
      output_config: { format: { type: 'json_schema', schema: req.outputSchema } } })
  })

  it.each(['openai_chat', 'anthropic_messages'] as const)('uses explicit JSON compatibility and isolates input for %s', async protocol => {
    const fetcher = mockFetch(protocol === 'openai_chat' ? chat : anthropic)
    await createCompatibleProvider(protocol, key, base, { outputMode: 'json_object', reasoningMode: 'none' }, fetcher).generateStructured(req)
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    const system = protocol === 'openai_chat' ? body.messages[0].content : body.system
    expect(system).toContain(JSON.stringify(req.outputSchema))
    expect(system).not.toContain('USER_SENTINEL')
    if (protocol === 'openai_chat') {
      expect(body.response_format).toEqual({ type: 'json_object' })
      expect(body.reasoning_effort).toBe('none')
    } else {
      expect(body).not.toHaveProperty('output_config')
      expect(body.thinking).toEqual({ type: 'disabled' })
    }
  })

  it.each([
    ['openai_chat', { ...chat, choices: [{ finish_reason: 'length', message: { content: '{"ok":true}' } }] }, 'output_unparseable'],
    ['openai_chat', { ...chat, choices: [{ finish_reason: 'stop', message: { content: '```json\n{}\n```' } }] }, 'output_unparseable'],
    ['openai_chat', { ...chat, choices: [{ finish_reason: 'stop', message: { refusal: 'SECRET', content: '{}' } }] }, 'refused'],
    ['openai_chat', { ...chat, choices: [{ finish_reason: 'stop', message: { content: '{}', tool_calls: [{}] } }] }, 'output_unparseable'],
    ['anthropic_messages', { ...anthropic, stop_reason: 'max_tokens' }, 'output_unparseable'],
    ['anthropic_messages', { ...anthropic, stop_reason: 'refusal' }, 'refused'],
    ['anthropic_messages', { ...anthropic, content: [{ type: 'tool_use', input: 'SECRET' }] }, 'output_unparseable'],
  ] as const)('rejects incomplete, refused or tool output (%s %#)', async (protocol, body, code) => {
    const fetcher = mockFetch(body)
    await expect(createCompatibleProvider(protocol, key, base, settings, fetcher).generateStructured(req)).rejects.toMatchObject({ code, message: code })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each([[400, 'bad_request'], [401, 'bad_request'], [429, 'rate_limited'], [503, 'unavailable']] as const)('sanitizes HTTP %s without retry', async (status, code) => {
    const fetcher = mockFetch({ error: key + ' USER_SENTINEL' }, status)
    const failure = await createCompatibleProvider('openai_chat', key, base, settings, fetcher).generateStructured(req).catch(err => err)
    expect(failure).toBeInstanceOf(LlmError)
    expect(failure).toMatchObject({ code, providerStatus: status })
    expect(JSON.stringify(failure)).not.toContain('SENTINEL')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('aborts in-flight requests and maps a network failure without echoing secrets', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error(key)))
    }))
    const pending = createCompatibleProvider('openai_chat', key, base, settings, fetcher).generateStructured({ ...req, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'timeout', message: 'timeout' })
    fetcher.mockRejectedValueOnce(new Error(key))
    await expect(createCompatibleProvider('openai_chat', key, base, settings, fetcher).generateStructured(req)).rejects.toMatchObject({ message: 'unavailable' })
  })

  it('uses the same DNS/redirect guard for selected protocols', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(anthropic)))
    const provider = await getLlmProvider({ apiKey: key, baseUrl: base, protocol: 'anthropic_messages', ...settings })
    await provider.generateStructured(req)
    expect(fetcher).toHaveBeenCalledWith(base + '/messages', expect.objectContaining({ dispatcher: expect.anything(), redirect: 'error' }))
  })

  it('bounds gateway output and probes model metadata without generating', async () => {
    const huge = mockFetch('x'.repeat(2 * 1024 * 1024))
    await expect(createCompatibleProvider('openai_chat', key, base, settings, huge).generateStructured(req)).rejects.toMatchObject({ code: 'output_unparseable' })
    const fetcher = mockFetch({ id: 'resolved-alias' })
    await probeAnthropicConnection(key, req.model, base, fetcher)
    expect(fetcher).toHaveBeenCalledWith(base + '/models/gateway%2Fmodel-alias', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body')
  })
})
