import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  generateWebhookSecret,
} from '../../lib/webhookSecret.js'
import {
  callWebhook,
  classifyWebhookFailure,
  signWebhookPayload,
  validateWebhookUrl,
  WebhookTargetError,
} from '../../lib/outboundWebhook.js'

/**
 * P7b：商家自动开通 webhook 配置（设计 §3.2/§3.6，硬验收 ⑤⑦）。
 *
 * 硬规则：
 * - 版本化：保存 = 撤销旧 active 行 + 新建 active 行（新 secret）；每商家至
 *   多一条 active（部分唯一索引兜底并发）。
 * - **轮换/撤销即降级**：引用被撤销配置的 pending 任务在同一事务内置
 *   degraded（含在途租约的任务——其迟到结果被 status='pending' CAS 丢弃），
 *   任务**绝不解析到新配置**；降级邮件由 provision cron 的
 *   merchantNotifiedAt 通道统一补发。
 * - 撤销配置时原子关闭该商家全部规格的 autoProvision 开关——否则这些规格
 *   的新订单会在下单事务冻结配置时 409，商品事实上不可购买。开关变化进
 *   checkoutVersion，买家预览自动失效重确认。
 * - secret 明文只在保存（创建/轮换）响应中一次性返回；常规读取只回尾 4 位。
 * - URL 在保存时即过完整 SSRF 校验（外呼时还会再验 + 连接期钉扎）。
 */

function secretLast4(ciphertext: string): string {
  return decryptWebhookSecret(ciphertext).slice(-4)
}

export async function getMyWebhookConfig(merchantId: number) {
  const active = await prisma.merchantWebhookConfig.findFirst({
    where: { merchantId, status: 'active' },
    select: { url: true, secretCiphertext: true, createdAt: true },
  })
  if (!active) return null
  return {
    url: active.url,
    secretLast4: secretLast4(active.secretCiphertext),
    createdAt: active.createdAt,
  }
}

/** 保存（创建或轮换）：返回值是 secret 明文的**唯一**出口。 */
export async function saveMyWebhookConfig(merchantId: number, rawUrl: string) {
  try {
    validateWebhookUrl(rawUrl)
  } catch (err) {
    if (err instanceof WebhookTargetError) throw badRequest(err.message)
    throw err
  }

  const secret = generateWebhookSecret()
  const created = await prisma.$transaction(async tx => {
    const previous = await tx.merchantWebhookConfig.findFirst({
      where: { merchantId, status: 'active' },
      select: { id: true },
    })
    if (previous) {
      await tx.merchantWebhookConfig.update({
        where: { id: previous.id },
        data: { status: 'revoked', revokedAt: new Date() },
      })
      // 硬验收 ⑤：尚未发出的旧任务安全默认降级人工——绝不切到新配置。
      await tx.provisionTask.updateMany({
        where: { webhookConfigId: previous.id, status: 'pending' },
        data: { status: 'degraded', lastError: 'config_revoked', leaseUntil: null },
      })
    }
    return tx.merchantWebhookConfig.create({
      data: {
        merchantId,
        url: rawUrl,
        secretCiphertext: encryptWebhookSecret(secret),
      },
      select: { url: true, createdAt: true },
    })
  })

  return {
    url: created.url,
    createdAt: created.createdAt,
    // 一次性明文：前端弹窗展示后不再可取。
    secret,
    secretLast4: secret.slice(-4),
  }
}

export async function revokeMyWebhookConfig(merchantId: number) {
  return prisma.$transaction(async tx => {
    const active = await tx.merchantWebhookConfig.findFirst({
      where: { merchantId, status: 'active' },
      select: { id: true },
    })
    if (!active) throw notFound('尚未配置自动开通 webhook')
    await tx.merchantWebhookConfig.update({
      where: { id: active.id },
      data: { status: 'revoked', revokedAt: new Date() },
    })
    await tx.provisionTask.updateMany({
      where: { webhookConfigId: active.id, status: 'pending' },
      data: { status: 'degraded', lastError: 'config_revoked', leaseUntil: null },
    })
    // 原子关闭全部开关：否则这些规格的新订单会在冻结配置时 409，
    // 商品事实上不可购买；开关变化进 checkoutVersion，预览自动失效。
    const offers = await tx.offer.updateMany({
      where: { autoProvision: true, product: { merchantId } },
      data: { autoProvision: false },
    })
    return { revoked: true, disabledOffers: offers.count }
  })
}

/**
 * 测试事件：与真实外呼同一条安全路径（SSRF 校验 + 钉扎 + 签名），taskId 带
 * `test-` 前缀且 `test: true`，供商家验证签名校验与 taskId 幂等去重逻辑。
 * 结果只回 HTTP 状态与脱敏诊断码，绝不回远端响应体。
 */
export async function sendTestWebhookEvent(merchantId: number) {
  const active = await prisma.merchantWebhookConfig.findFirst({
    where: { merchantId, status: 'active' },
    select: { url: true, secretCiphertext: true },
  })
  if (!active) throw notFound('尚未配置自动开通 webhook')

  const payload = {
    taskId: `test-${randomUUID()}`,
    test: true,
    attempt: 1,
    timestamp: Math.floor(Date.now() / 1000),
    orderId: 0,
    productName: '测试商品',
    offerName: null,
    price: 0,
    purchaseFormAnswers: null,
    bookingDate: null,
  }
  const rawBody = JSON.stringify(payload)
  const signature = signWebhookPayload(decryptWebhookSecret(active.secretCiphertext), rawBody, payload.timestamp)
  try {
    const result = await callWebhook(active.url, rawBody, signature)
    return { ok: result.status >= 200 && result.status < 300, httpStatus: result.status }
  } catch (err) {
    return { ok: false, httpStatus: null, error: classifyWebhookFailure(err) }
  }
}
