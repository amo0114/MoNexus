import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import express from 'express'
import request from 'supertest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { decryptAiApiKey, encryptAiApiKey } from '../lib/ai/credentialsCrypto.js'
import { getAiRuntimeConfig } from '../lib/ai/runtimeConfig.js'
import { isAiFeatureEnabled, runAiGeneration } from '../lib/ai/generation.js'
import { markAiSafe } from '../lib/ai/safe.js'
import { getLlmProvider, LlmError } from '../lib/ai/provider.js'
import * as adapter from '../lib/ai/openaiProvider.js'
import * as compatibleAdapter from '../lib/ai/compatibleProvider.js'
import { createAiTestLimiter } from '../modules/admin/aiSettings.js'
import { isContentCopilotAvailable } from '../modules/catalog/contentCopilot/service.js'

const KEY = 'sk-test-SECRET_SENTINEL_1234567890'
const ROTATED = 'sk-test-ROTATED_SENTINEL_9876543210'
const originalAi = { ...config.ai }
let token: string
let adminId: number

beforeEach(async () => {
  Object.assign(config.ai, { enabled: false, productCopilotEnabled: false, openaiApiKey: undefined, credentialsEncKey: 'ab'.repeat(32) })
  const { user, password } = await createTestUser('ai-admin@test.local', 'pass123', 'admin')
  adminId = user.id
  token = (await loginAs(user.email, password)).accessToken
  await prisma.systemConfig.deleteMany({ where: { key: { startsWith: 'aiProductCopilot' } } })
})
afterEach(() => { Object.assign(config.ai, originalAi); vi.restoreAllMocks() })

function save(body: Record<string, unknown>) {
  return api.put('/api/admin/ai/config').set(authHeader(token)).send({ expectedVersion: 0, enabled: false, productCopilotEnabled: false, ...body })
}
const getSettings = () => api.get('/api/admin/ai/config').set(authHeader(token))

describe('admin AI settings', () => {
  it('preserves legacy Responses defaults and validates protocol configuration', async () => {
    expect((await getSettings()).body).toMatchObject({ protocol: 'openai_responses', outputMode: 'json_schema', reasoningMode: 'none' })
    await save({ protocol: 'unknown', apiKey: KEY }).expect(400)
    await save({ outputMode: 'text', apiKey: KEY }).expect(400)
    await save({ reasoningMode: 'high', apiKey: KEY }).expect(400)
    await save({ chatTokenParameter: 'wrong', apiKey: KEY }).expect(400)
    await save({ apiKey: KEY }).expect(200)
    expect((await getAiRuntimeConfig()).protocol).toBe('openai_responses')
    await expect(prisma.aiRuntimeConfig.update({ where: { id: 1 }, data: { protocol: 'unknown' } })).rejects.toThrow()
  })

  it('saves the explicit Chat token parameter and passes it to the adapter', async () => {
    await save({ apiKey: KEY, protocol: 'openai_chat', chatTokenParameter: 'max_completion_tokens' }).expect(200)
    expect((await getSettings()).body.chatTokenParameter).toBe('max_completion_tokens')
    const create = vi.spyOn(compatibleAdapter, 'createCompatibleProvider').mockReturnValue({ name: 'test', generateStructured: vi.fn() })
    await getLlmProvider()
    expect(create).toHaveBeenCalledWith('openai_chat', KEY, 'https://api.openai.com/v1', expect.objectContaining({ chatTokenParameter: 'max_completion_tokens' }))
  })

  it.each(['openai_chat', 'anthropic_messages'] as const)('routes saved %s and retains an arbitrary gateway/model alias', async protocol => {
    const baseUrl = 'https://custom-gateway.example/tenant/v1'
    const saved = await save({ apiKey: KEY, protocol, outputMode: 'json_object', reasoningMode: 'default', baseUrl, model: 'merchant-alias/v4.1-flash' }).expect(200)
    expect(saved.body).toMatchObject({ protocol, outputMode: 'json_object', reasoningMode: 'default', model: 'merchant-alias/v4.1-flash' })
    const create = vi.spyOn(compatibleAdapter, 'createCompatibleProvider').mockReturnValue({ name: 'test', generateStructured: vi.fn() })
    await getLlmProvider()
    expect(create).toHaveBeenCalledWith(protocol, KEY, baseUrl, expect.objectContaining({ protocol, outputMode: 'json_object', reasoningMode: 'default' }))
    await save({ expectedVersion: 1 }).expect(200)
    expect((await getAiRuntimeConfig())).toMatchObject({ protocol, outputMode: 'json_object', reasoningMode: 'default', apiKey: KEY })
    const openaiProbe = vi.spyOn(adapter, 'probeOpenAiConnection').mockResolvedValue()
    const anthropicProbe = vi.spyOn(compatibleAdapter, 'probeAnthropicConnection').mockResolvedValue()
    await api.post('/api/admin/ai/test').set(authHeader(token)).send({ expectedVersion: 2 }).expect(200)
    expect(protocol === 'openai_chat' ? openaiProbe : anthropicProbe).toHaveBeenCalledExactlyOnceWith(KEY, 'merchant-alias/v4.1-flash', baseUrl)
    expect(protocol === 'openai_chat' ? anthropicProbe : openaiProbe).not.toHaveBeenCalled()
    expect(await prisma.aiGeneration.count()).toBe(0)
  })
  it('encrypts credentials, only exposes suffix metadata, and audits without secrets', async () => {
    const initial = await getSettings().expect(200)
    expect(initial.body).toMatchObject({ version: 0, enabled: false, apiKeyConfigured: false, encryptionReady: true })
    const saved = await save({ apiKey: KEY }).expect(200)
    const row = await prisma.aiRuntimeConfig.findUniqueOrThrow({ where: { id: 1 } })
    expect(row.apiKeyCiphertext).not.toContain(KEY)
    expect(decryptAiApiKey(row.apiKeyCiphertext!)).toBe(KEY)
    expect(saved.body).toMatchObject({ version: 1, source: 'database', apiKeyConfigured: true, apiKeyLast4: '7890' })
    expect((await getSettings()).headers['cache-control']).toBe('no-store')
    const configs = await api.get('/api/admin/config').set(authHeader(token)).expect(200)
    const audit = await prisma.adminLog.findMany({ where: { targetType: 'aiRuntimeConfig' } })
    const exposed = JSON.stringify([saved.body, (await getSettings()).body, configs.body, audit])
    expect(exposed).not.toContain(KEY)
    expect(exposed).not.toContain(row.apiKeyCiphertext!)
    expect(JSON.stringify(audit)).not.toContain('7890')
  })

  it('preserves an omitted key, rotates it immediately, and does not reuse a stale SDK', async () => {
    await save({ apiKey: KEY, enabled: true, productCopilotEnabled: true }).expect(200)
    const create = vi.spyOn(adapter, 'createOpenAiProvider').mockReturnValue({ name: 'test', generateStructured: vi.fn() })
    await getLlmProvider()
    expect(create).toHaveBeenLastCalledWith(undefined, KEY, 'https://api.openai.com/v1', { outputMode: 'json_schema', reasoningMode: 'none' })
    await save({ expectedVersion: 1, enabled: false }).expect(200)
    expect((await getAiRuntimeConfig()).apiKey).toBe(KEY)
    await save({ expectedVersion: 2, apiKey: ROTATED, enabled: true, productCopilotEnabled: true }).expect(200)
    await getLlmProvider()
    expect(create).toHaveBeenLastCalledWith(undefined, ROTATED, 'https://api.openai.com/v1', { outputMode: 'json_schema', reasoningMode: 'none' })
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('honors saved flags and role quotas in editor capabilities without a restart', async () => {
    const product = { templateKey: 'fixed_content', templateVersion: 1, archivedAt: null }
    await save({ apiKey: KEY, enabled: true, productCopilotEnabled: true }).expect(200)
    expect(await isAiFeatureEnabled('product_content_copilot')).toBe(true)
    expect(await isContentCopilotAvailable('merchant', product)).toBe(false)
    await api.put('/api/admin/config/aiProductCopilotDailyQuotaMerchant').set(authHeader(token)).send({ value: 7 }).expect(200)
    expect(await isContentCopilotAvailable('merchant', product)).toBe(true)
    expect(await isContentCopilotAvailable('admin', product)).toBe(false)
    await save({ expectedVersion: 1, enabled: false, productCopilotEnabled: false }).expect(200)
    expect(await isContentCopilotAvailable('merchant', product)).toBe(false)
  })

  it('imports environment bootstrap once and never resurrects it after clearing the key', async () => {
    Object.assign(config.ai, { enabled: true, productCopilotEnabled: true, openaiApiKey: KEY })
    expect((await getSettings()).body).toMatchObject({ source: 'environment', enabled: true, apiKeyLast4: '7890' })
    await save({ enabled: true, productCopilotEnabled: true }).expect(200)
    expect((await getAiRuntimeConfig()).apiKey).toBe(KEY)
    const cleared = await save({ expectedVersion: 1, apiKey: null, enabled: true, productCopilotEnabled: true }).expect(200)
    expect(cleared.body).toMatchObject({ apiKeyConfigured: false, enabled: false, productCopilotEnabled: false, source: 'database' })
    expect((await getAiRuntimeConfig()).apiKey).toBeNull()
    expect(await isAiFeatureEnabled('product_content_copilot')).toBe(false)
    await save({ expectedVersion: 2 }).expect(200)
    expect((await getAiRuntimeConfig()).apiKey).toBeNull()
  })

  it('rejects missing/masked keys, invalid flag combinations and stale writes', async () => {
    await save({ enabled: true }).expect(400)
    await save({ productCopilotEnabled: true }).expect(400)
    await save({ apiKey: '****1234' }).expect(400)
    await save({ apiKey: KEY, unexpected: true }).expect(400)
    const writes = await Promise.all([save({ apiKey: KEY }), save({ apiKey: ROTATED })])
    expect(writes.map(r => r.status).sort()).toEqual([200, 409])
    expect(await prisma.aiRuntimeConfig.count()).toBe(1)
    expect(await prisma.adminLog.count({ where: { targetType: 'aiRuntimeConfig' } })).toBe(1)
  })

  it('requires a master key and fails closed if ciphertext is corrupt, while allowing replacement', async () => {
    config.ai.credentialsEncKey = null
    await save({ apiKey: KEY }).expect(403)
    config.ai.credentialsEncKey = 'ab'.repeat(32)
    await save({ apiKey: KEY, enabled: true, productCopilotEnabled: true }).expect(200)
    config.ai.credentialsEncKey = 'cd'.repeat(32)
    expect((await getSettings()).body.credentialError).toBe(true)
    expect(await isAiFeatureEnabled('product_content_copilot')).toBe(false)
    await save({ expectedVersion: 1, enabled: true }).expect(400)
    await save({ expectedVersion: 1, apiKey: ROTATED, enabled: true, productCopilotEnabled: true }).expect(200)
    expect(await isAiFeatureEnabled('product_content_copilot')).toBe(true)
  })

  it('only allows authenticated, active administrators with current MFA for all endpoints', async () => {
    const probe = vi.spyOn(adapter, 'probeOpenAiConnection').mockResolvedValue()
    const { user, password } = await createTestUser('ai-merchant@test.local', 'pass123', 'merchant')
    const merchantToken = (await loginAs(user.email, password)).accessToken
    const session = await prisma.refreshToken.findFirstOrThrow({ where: { userId: adminId, revoked: false } })
    const noMfa = jwt.sign({ userId: adminId, role: 'admin', sid: session.sessionId }, config.jwtSecret, { expiresIn: '15m' })
    const endpoints = () => [api.get('/api/admin/ai/config'), api.put('/api/admin/ai/config').send({ apiKey: KEY }), api.post('/api/admin/ai/test').send({ expectedVersion: 0 })]
    for (const req of endpoints()) await req.expect(401)
    for (const req of endpoints()) await req.set(authHeader(merchantToken)).expect(403)
    for (const req of endpoints()) await req.set(authHeader(noMfa)).expect(403)
    await prisma.user.update({ where: { id: adminId }, data: { status: '已封禁' } })
    for (const req of endpoints()) await req.set(authHeader(token)).expect(403)
    expect(probe).not.toHaveBeenCalled()
    expect(await prisma.aiRuntimeConfig.count()).toBe(0)
  })

  it('tests a saved key with flags off, does not consume quota, and sanitizes failures', async () => {
    const probe = vi.spyOn(adapter, 'probeOpenAiConnection').mockResolvedValue()
    await save({ apiKey: KEY }).expect(200)
    const test = () => api.post('/api/admin/ai/test').set(authHeader(token)).send({ expectedVersion: 1 })
    expect((await test().expect(200)).body).toMatchObject({ ok: true, testedVersion: 1 })
    expect(probe).toHaveBeenCalledWith(KEY, 'gpt-6-luna', 'https://api.openai.com/v1')
    probe.mockRejectedValueOnce(new LlmError('bad_request', 401))
    expect((await test()).body.code).toBe('unauthorized')
    probe.mockRejectedValueOnce(new Error(KEY + ' upstream failure with sensitive body'))
    const failure = await test().expect(200)
    expect(failure.body).toMatchObject({ ok: false, code: 'unavailable' })
    expect(JSON.stringify(failure.body)).not.toContain(KEY)
    expect(await prisma.aiGeneration.count()).toBe(0)
    expect(JSON.stringify(await prisma.adminLog.findMany())).not.toContain(KEY)
    await api.post('/api/admin/ai/test').set(authHeader(token)).send({ expectedVersion: 0 }).expect(409)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('authenticates ciphertext and uses random nonces', () => {
    const a = encryptAiApiKey(KEY)
    expect(encryptAiApiKey(KEY)).not.toBe(a)
    expect(decryptAiApiKey(a)).toBe(KEY)
    const parts = a.split(':'); parts[3] = (parts[3][0] === 'a' ? 'b' : 'a') + parts[3].slice(1)
    expect(() => decryptAiApiKey(parts.join(':'))).toThrow()
  })

  it('changes endpoint and model together, requires a new key for a new endpoint, and uses the saved model for generation', async () => {
    await save({ apiKey: KEY, enabled: true, productCopilotEnabled: true }).expect(200)
    const baseUrl = 'https://third-party.example/proxy/v1'
    await save({ expectedVersion: 1, baseUrl, model: 'vendor/custom' }).expect(400)
    const updated = await save({ expectedVersion: 1, baseUrl: baseUrl + '/', model: 'vendor/custom', apiKey: ROTATED, enabled: true, productCopilotEnabled: true }).expect(200)
    expect(updated.body).toMatchObject({ baseUrl, model: 'vendor/custom', version: 2 })
    const generate = vi.fn().mockResolvedValue({ output: {}, usage: { inputTokens: 1, outputTokens: 1 }, model: 'vendor/custom-reported' })
    const create = vi.spyOn(adapter, 'createOpenAiProvider').mockReturnValue({ name: 'openai-compatible', generateStructured: generate })
    await api.put('/api/admin/config/aiProductCopilotDailyQuotaAdmin').set(authHeader(token)).send({ value: 3 }).expect(200)
    const result = await runAiGeneration({
      feature: 'product_content_copilot', actor: { userId: adminId, role: 'admin' }, target: { type: 'product', id: 100 },
      promptVersion: 'test', validatorVersion: 'test', reasoningEffort: 'none', schemaName: 'test', system: 'fixed',
      input: markAiSafe({ facts: {} }), outputSchema: {}, maxOutputTokens: 100,
      parse: () => ({ value: {}, issueCounts: { missing: 0, ambiguous: 0, risky_claim: 0, unsupported_fact: 0 }, suggestedFieldCount: 0 }),
    })
    expect(create).toHaveBeenCalledWith(undefined, ROTATED, baseUrl, { outputMode: 'json_schema', reasoningMode: 'none' })
    expect(generate.mock.calls[0][0].model).toBe('vendor/custom')
    expect((await prisma.aiGeneration.findUniqueOrThrow({ where: { id: result.generationId } })).model).toBe('vendor/custom-reported')
    const probe = vi.spyOn(adapter, 'probeOpenAiConnection').mockResolvedValue()
    await api.post('/api/admin/ai/test').set(authHeader(token)).send({ expectedVersion: 2 }).expect(200)
    expect(probe).toHaveBeenCalledWith(ROTATED, 'vendor/custom', baseUrl)
  })

  it('limits connection tests per administrator rather than by shared IP', async () => {
    const app = express()
    app.use((req, _res, next) => { req.user = { userId: Number(req.headers['x-test-actor']), role: 'admin' }; next() })
    app.post('/', createAiTestLimiter(false), (_req, res) => res.sendStatus(204))
    app.use((err: { status: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err.status || 500).end())
    for (let i = 0; i < 5; i++) await request(app).post('/').set('x-test-actor', '1').expect(204)
    await request(app).post('/').set('x-test-actor', '1').expect(429)
    await request(app).post('/').set('x-test-actor', '2').expect(204)
  })
})
