import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { badRequest, conflict, forbidden, tooManyRequests } from '../../lib/httpError.js'
import { validate } from '../../middlewares/validate.js'
import { encryptAiApiKey } from '../../lib/ai/credentialsCrypto.js'
import { getAiRuntimeConfig, resolveAiRuntimeConfig, type AiRuntimeSettings } from '../../lib/ai/runtimeConfig.js'
import { LlmError } from '../../lib/ai/provider.js'
import { probeOpenAiConnection } from '../../lib/ai/openaiProvider.js'
import { normalizeAiBaseUrl } from '../../lib/ai/endpoint.js'

const CONFIG_LOCK_CLASS = 20261008
const versionSchema = z.number().int().min(0).max(2147483646)
const updateSchema = z.object({
  expectedVersion: versionSchema,
  enabled: z.boolean(),
  productCopilotEnabled: z.boolean(),
  baseUrl: z.string().trim().min(8).max(2048).optional(),
  model: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/, '模型名称格式不正确').optional(),
  // Missing = preserve, null = clear, string = replace. Never accept a masked value.
  apiKey: z.string().trim().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/, 'API Key 格式不正确').nullable().optional(),
}).strict()

function publicSettings(settings: AiRuntimeSettings) {
  return {
    version: settings.version,
    source: settings.source,
    enabled: settings.enabled,
    productCopilotEnabled: settings.productCopilotEnabled,
    apiKeyConfigured: settings.apiKeyConfigured,
    apiKeyLast4: settings.apiKeyLast4,
    credentialError: settings.credentialError,
    encryptionReady: Boolean(config.ai.credentialsEncKey),
    baseUrl: settings.baseUrl,
    model: settings.model,
  }
}

function requireVersion(actual: number, expected: number) {
  if (actual !== expected) throw conflict('AI 配置已被其他管理员更新，请重新加载后再保存或测试')
}

export async function updateAiSettings(adminUserId: number, input: z.infer<typeof updateSchema>) {
  return prisma.$transaction(async tx => {
    // Also serializes concurrent first saves, when there is no singleton row yet.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CONFIG_LOCK_CLASS}::int4, 1::int4)`
    const row = await tx.aiRuntimeConfig.findUnique({ where: { id: 1 } })
    const previous = resolveAiRuntimeConfig(row)
    requireVersion(previous.version, input.expectedVersion)
    const baseUrl = normalizeAiBaseUrl(input.baseUrl ?? previous.baseUrl)
    const model = input.model ?? previous.model
    if (baseUrl !== previous.baseUrl && previous.apiKeyConfigured && input.apiKey === undefined) {
      throw badRequest('更换 API 地址时，请同时填写该服务的 API Key，或清除旧密钥')
    }
    let ciphertext = row?.apiKeyCiphertext ?? null
    let last4 = previous.apiKeyLast4
    const keyToEncrypt = typeof input.apiKey === 'string'
      ? input.apiKey
      : !row && input.apiKey !== null ? previous.apiKey : null
    if (keyToEncrypt) {
      if (!config.ai.credentialsEncKey) throw forbidden('服务器尚未配置 AI_CREDENTIALS_ENC_KEY，暂不能保存密钥')
      ciphertext = encryptAiApiKey(keyToEncrypt)
      last4 = keyToEncrypt.slice(-4)
    } else if (input.apiKey === null) {
      ciphertext = null
      last4 = null
    }
    const enabled = input.apiKey === null ? false : input.enabled
    const productCopilotEnabled = input.apiKey === null ? false : input.productCopilotEnabled
    if (productCopilotEnabled && !enabled) throw badRequest('请先开启 AI 总开关')
    if (enabled && (!ciphertext || (!keyToEncrypt && previous.credentialError))) {
      throw badRequest('请先配置可用的 API Key')
    }
    const data = { enabled, productCopilotEnabled, baseUrl, model, apiKeyCiphertext: ciphertext, apiKeyLast4: last4, updatedBy: adminUserId }
    const updated = await tx.aiRuntimeConfig.upsert({
      where: { id: 1 },
      create: { id: 1, version: 1, ...data },
      update: { version: { increment: 1 }, ...data },
    })
    // Only operation metadata; neither plaintext, ciphertext nor even key suffixes.
    await tx.adminLog.create({ data: {
      adminUserId, action: '更新 AI 配置', targetType: 'aiRuntimeConfig', targetId: 1,
      detail: JSON.stringify({ version: updated.version, enabled, productCopilotEnabled,
        endpointChanged: baseUrl !== previous.baseUrl, modelChanged: model !== previous.model,
        keyAction: input.apiKey === null ? 'clear' : keyToEncrypt ? 'replace' : 'preserve' }),
    } })
    return publicSettings(resolveAiRuntimeConfig(updated))
  })
}

function probeResult(err?: unknown) {
  if (!err) return { ok: true, code: 'ok', message: '连接成功，所选模型已出现在服务商返回的列表中。生成权限、效果和账户余额仍需单独验证。' }
  if (err instanceof LlmError) {
    if (err.providerStatus === 401) return { ok: false, code: 'unauthorized', message: 'API Key 无效或已失效，请更换密钥。' }
    if (err.providerStatus === 403 || err.providerStatus === 404) return { ok: false, code: 'model_unavailable', message: '未能确认所选模型可用，请检查模型名称、密钥权限及服务商的模型列表接口。' }
    if (err.code === 'timeout') return { ok: false, code: 'timeout', message: '连接超时，请检查服务器网络后重试。' }
    if (err.code === 'rate_limited') return { ok: false, code: 'rate_limited', message: 'AI 服务暂时限制请求，请稍后重试。' }
  }
  return { ok: false, code: 'unavailable', message: '连接失败，请检查服务器网络、API 地址和服务状态。' }
}

export async function testAiConnection(adminUserId: number, expectedVersion: number) {
  const settings = await getAiRuntimeConfig()
  requireVersion(settings.version, expectedVersion)
  if (!settings.apiKey || settings.credentialError) throw badRequest('请先保存可用的 API Key')
  const started = Date.now()
  let result
  try {
    await probeOpenAiConnection(settings.apiKey, settings.model, settings.baseUrl)
    result = probeResult()
  } catch (err) {
    result = probeResult(err)
  }
  const latencyMs = Date.now() - started
  await prisma.adminLog.create({ data: {
    adminUserId, action: '测试 AI 连接', targetType: 'aiRuntimeConfig', targetId: 1,
    detail: JSON.stringify({ version: settings.version, code: result.code, latencyMs }),
  } })
  return { ...result, testedVersion: settings.version, latencyMs }
}

export function createAiTestLimiter(skipInTests = true) {
  return rateLimit({
    windowMs: 60_000, limit: 5, standardHeaders: true, legacyHeaders: false,
    skip: () => skipInTests && config.nodeEnv === 'test',
    keyGenerator: req => `admin:${req.user!.userId}`,
    handler: (_req, _res, next) => next(tooManyRequests('连接测试过于频繁，请稍后重试')),
  })
}

/** Mounted only below the admin router's authentication/active-user/admin/MFA chain. */
export const aiSettingsRoutes = Router()
aiSettingsRoutes.use('/ai', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
aiSettingsRoutes.get('/ai/config', async (_req, res, next) => {
  try { res.json(publicSettings(await getAiRuntimeConfig())) } catch (err) { next(err) }
})
aiSettingsRoutes.put('/ai/config', validate(updateSchema), async (req, res, next) => {
  try { res.json(await updateAiSettings(req.user!.userId, req.body)) } catch (err) { next(err) }
})
aiSettingsRoutes.post('/ai/test', createAiTestLimiter(), validate(z.object({ expectedVersion: versionSchema }).strict()), async (req, res, next) => {
  try { res.json(await testAiConnection(req.user!.userId, req.body.expectedVersion)) } catch (err) { next(err) }
})
