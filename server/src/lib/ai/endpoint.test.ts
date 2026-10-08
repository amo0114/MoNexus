import { afterEach, describe, expect, it, vi } from 'vitest'
import { lookup } from 'node:dns'
import { createAiFetch, lookupAiEndpoint, normalizeAiBaseUrl } from './endpoint.js'
import { createOpenAiProvider, probeOpenAiConnection } from './openaiProvider.js'
import { markAiSafe } from './safe.js'

vi.mock('node:dns', () => ({ lookup: vi.fn() }))
afterEach(() => { vi.restoreAllMocks() })

describe('configurable AI endpoints', () => {
  it.each([
    'http://gateway.example/v1', 'https://user:pass@gateway.example/v1',
    'https://gateway.example/v1?key=secret', 'https://gateway.example/v1#secret',
    'https://127.0.0.1/v1', 'https://[::ffff:127.0.0.1]/v1', 'https://169.254.169.254/v1', 'https://localhost/v1',
  ])('rejects an unsafe endpoint %s', url => {
    expect(() => normalizeAiBaseUrl(url)).toThrow()
  })

  it('normalizes compatible gateway paths and preserves custom HTTPS ports', () => {
    expect(normalizeAiBaseUrl(' https://gateway.example:8443/proxy/v1/ ')).toBe('https://gateway.example:8443/proxy/v1')
  })

  it('blocks DNS rebinding and mixed public/private responses at connection time', () => {
    vi.mocked(lookup).mockImplementation(((_host: string, _opts: unknown, cb: Function) => cb(null, [
      { address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 },
    ])) as typeof lookup)
    const cb = vi.fn()
    lookupAiEndpoint('gateway.example', { all: true }, cb)
    expect(cb).toHaveBeenCalledWith(expect.any(Error), '')
    vi.mocked(lookup).mockImplementation(((_host: string, _opts: unknown, done: Function) => done(null, [{ address: '8.8.8.8', family: 4 }])) as typeof lookup)
    lookupAiEndpoint('gateway.example', {}, cb)
    expect(cb).toHaveBeenLastCalledWith(null, '8.8.8.8', 4)
  })

  it('keeps credentials on the configured origin and disables redirects', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    const guarded = createAiFetch('https://gateway.example/proxy/v1')
    await expect(guarded('https://other.example/proxy/v1/responses')).rejects.toThrow()
    await expect(guarded('https://gateway.example/admin')).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    await guarded('https://gateway.example/proxy/v1/responses')
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', dispatcher: expect.anything() })
  })

  it('sends generation and model-list checks to the saved base URL using the chosen key/model', async () => {
    const calls: Array<{ url: string; key: string | null; body: unknown }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      calls.push({ url, key: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null })
      const body = url.endsWith('/models') ? { object: 'list', data: [{ id: 'vendor/custom-model' }] } : {
        status: 'completed', model: 'vendor/custom-model',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
        output_text: '{"ok":true}', usage: { input_tokens: 1, output_tokens: 1 },
      }
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
    })
    const provider = createOpenAiProvider(undefined, 'sk-custom-test', 'https://gateway.example/proxy/v1')
    const result = await provider.generateStructured({
      model: 'vendor/custom-model', reasoningEffort: 'none', schemaName: 'test', system: 'fixed instructions',
      input: markAiSafe({ facts: {} }), outputSchema: { type: 'object' }, maxOutputTokens: 100,
      signal: new AbortController().signal,
    })
    await probeOpenAiConnection('sk-custom-test', 'vendor/custom-model', 'https://gateway.example/proxy/v1')
    expect(result.output).toEqual({ ok: true })
    expect(calls.map(c => c.url)).toEqual(['https://gateway.example/proxy/v1/responses', 'https://gateway.example/proxy/v1/models'])
    expect(calls.every(c => c.key === 'Bearer sk-custom-test')).toBe(true)
    expect(calls[0].body).toMatchObject({ model: 'vendor/custom-model', store: false })
  })
})
