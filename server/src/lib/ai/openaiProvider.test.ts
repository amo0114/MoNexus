import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import OpenAI from 'openai'
import { describe, expect, it, vi } from 'vitest'
import { computeAiInputHash } from './generation.js'
import { createOpenAiProvider, probeOpenAiConnection } from './openaiProvider.js'
import { LlmError, type LlmStructuredRequest } from './provider.js'
import { markAiSafe } from './safe.js'

function request(signal = new AbortController().signal): LlmStructuredRequest {
  return {
    model: 'gpt-6-luna',
    reasoningEffort: 'none',
    schemaName: 'product_content_suggestion',
    system: 'system prompt',
    input: markAiSafe({ facts: { a: 1 } }),
    outputSchema: { type: 'object', additionalProperties: false, required: [], properties: {} },
    maxOutputTokens: 8000,
    signal,
  }
}

function completed(text: string, extra: Record<string, unknown> = {}) {
  return {
    status: 'completed',
    model: 'gpt-6-luna-2026-09-01',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    output_text: text,
    usage: { input_tokens: 11, output_tokens: 22 },
    ...extra,
  }
}

function clientReturning(impl: (body: unknown, options: unknown) => Promise<unknown>) {
  const create = vi.fn(impl)
  return { client: { responses: { create } } as unknown as Pick<OpenAI, 'responses'>, create }
}

describe('OpenAI adapter (SPEC-AI-001 §6.3 / §17-7)', () => {
  it('supports JSON mode and omitted reasoning for a custom Responses model', async () => {
    const { client, create } = clientReturning(async () => completed('{"ok":true}'))
    const req = request()
    await createOpenAiProvider(client, 'test', 'https://gateway.example/v1', { outputMode: 'json_object', reasoningMode: 'default' }).generateStructured(req)
    const body = create.mock.calls[0][0] as Record<string, unknown>
    expect(body.text).toEqual({ format: { type: 'json_object' } })
    expect(body).not.toHaveProperty('reasoning')
    expect(body.instructions).toContain(JSON.stringify(req.outputSchema))
    expect(body.instructions).not.toContain(JSON.stringify(req.input))
    expect(body.store).toBe(false)
  })
  it('sends the frozen Responses request shape', async () => {
    const { client, create } = clientReturning(async () => completed('{"ok":true}'))
    const req = request()
    const result = await createOpenAiProvider(client).generateStructured(req)

    expect(result).toEqual({ output: { ok: true }, usage: { inputTokens: 11, outputTokens: 22 }, model: 'gpt-6-luna-2026-09-01' })
    const [body, options] = create.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>]
    expect(body).toEqual({
      model: 'gpt-6-luna',
      instructions: 'system prompt',
      input: '{"facts":{"a":1}}',
      text: { format: { type: 'json_schema', name: 'product_content_suggestion', schema: req.outputSchema, strict: true } },
      reasoning: { effort: 'none' },
      store: false,
      max_output_tokens: 8000,
    })
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('background')
    expect(options).toEqual({ signal: req.signal })
  })

  it('disables SDK retries on the default client', () => {
    const client = new OpenAI({ apiKey: 'test', maxRetries: 0 })
    expect(client.maxRetries).toBe(0)
    const source = readFileSync(fileURLToPath(new URL('./openaiProvider.ts', import.meta.url)), 'utf8')
    expect(source).toMatch(/maxRetries:\s*0/)
  })

  it.each([
    ['refusal', completed('', { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }), 'refused'],
    ['incomplete', completed('{"a":', { status: 'incomplete' }), 'output_unparseable'],
    ['bad json', completed('not json'), 'output_unparseable'],
  ])('maps %s responses', async (_name, response, code) => {
    const { client } = clientReturning(async () => response)
    await expect(createOpenAiProvider(client).generateStructured(request())).rejects.toMatchObject({ code })
  })

  it.each([
    [new OpenAI.APIUserAbortError(), 'timeout'],
    [new OpenAI.APIConnectionTimeoutError(), 'timeout'],
    [new OpenAI.APIConnectionError({ message: 'down' }), 'unavailable'],
    [OpenAI.APIError.generate(429, { error: { message: 'slow down' } }, 'rate', new Headers()), 'rate_limited'],
    [OpenAI.APIError.generate(503, { error: { message: 'busy' } }, 'busy', new Headers()), 'unavailable'],
    [OpenAI.APIError.generate(400, { error: { message: 'echo of the prompt' } }, 'bad', new Headers()), 'bad_request'],
  ])('maps SDK error %# without leaking its body', async (error, code) => {
    const { client } = clientReturning(async () => { throw error })
    const failure = await createOpenAiProvider(client).generateStructured(request()).catch(err => err)
    expect(failure).toBeInstanceOf(LlmError)
    expect(failure.code).toBe(code)
    expect(failure.message).toBe(code)
  })
})

describe('AI input hash (SPEC-AI-001 AI-R21)', () => {
  it('is stable across key order and domain-separated from a bare HMAC', async () => {
    const { createHmac } = await import('node:crypto')
    const { config } = await import('../../config/index.js')
    const a = computeAiInputHash({ b: 1, a: [1, { d: 2, c: 3 }] })
    const b = computeAiInputHash({ a: [1, { c: 3, d: 2 }], b: 1 })
    expect(a).toBe(b)
    const bare = createHmac('sha256', config.jwtSecret).update('{"a":[1,{"c":3,"d":2}],"b":1}').digest('hex')
    expect(a).not.toBe(bare)
  })
})

describe('SDK import boundary (SPEC-AI-001 §17-8)', () => {
  it('only the adapter imports the OpenAI SDK', () => {
    const srcRoot = fileURLToPath(new URL('../../', import.meta.url))
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          walk(path)
        } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
          if (/from ['"]openai(\/[^'"]*)?['"]/.test(readFileSync(path, 'utf8'))) offenders.push(relative(srcRoot, path))
        }
      }
    }
    walk(srcRoot)
    expect(offenders).toEqual(['lib/ai/openaiProvider.ts'])
  })
})

describe('OpenAI connection probe', () => {
  it('uses the model list endpoint with an abort signal, never Responses', async () => {
    const list = vi.fn().mockResolvedValue({ data: [{ id: 'gpt-6-luna' }] })
    await probeOpenAiConnection('test-key', 'gpt-6-luna', undefined, { models: { list } } as unknown as Pick<OpenAI, 'models'>)
    expect(list).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) })
  })

  it('aborts a hung probe at 10 seconds', async () => {
    vi.useFakeTimers()
    try {
      const list = vi.fn((opts) => new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new OpenAI.APIUserAbortError()))
      }))
      const pending = probeOpenAiConnection('test-key', 'gpt-6-luna', undefined, { models: { list } } as unknown as Pick<OpenAI, 'models'>)
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
    } finally { vi.useRealTimers() }
  })

  it('strips upstream error bodies including echoed API keys', async () => {
    const list = vi.fn().mockRejectedValue(OpenAI.APIError.generate(401, { message: 'SECRET-SENTINEL' }, 'SECRET-SENTINEL', new Headers()))
    const err = await probeOpenAiConnection('test-key', 'gpt-6-luna', undefined, { models: { list } } as unknown as Pick<OpenAI, 'models'>).catch(e => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err.providerStatus).toBe(401)
    expect(JSON.stringify(err)).not.toContain('SECRET-SENTINEL')
  })
})
