import type { Offer } from '@prisma/client'
import type { CheckoutExtension, ExtensionInput } from '../../extension-contracts/fulfillment.js'
import { config } from '../../config/index.js'
import { badRequest, HttpError, notFound, provisionEmailUnverified } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'
import { validatePurchaseFormAnswers } from '../../lib/purchaseForm.js'
import { usesStablePaidReset, withoutProvisionEmail } from '../../lib/fakaBridge/paidResetSku.js'
import {
  fetchFakaCapacityForSku,
  getFakaCapacityForPublicRead,
  isFakaBridgeConfigured,
  resolveFakaProvisionEmail,
} from '../../lib/fakaBridge/index.js'
import { assertPaidCheckoutTarget, paidCheckoutPreview, preflightPaidCheckout, type PaidCheckoutTarget } from './paidCheckout.js'
import { assertProvisionEmailTrusted } from './provisionEmailProof.js'
import { createFakaBridgeTaskForOrder, scheduleFakaBridgeFirstAttempt } from './outbox.js'

type Prepared =
  | { kind: 'email'; email: string }
  | { kind: 'paid_reset'; target: PaidCheckoutTarget; expectedTargetVersion: string }

type Target = { email: string; sku: string; paidReset?: { accountLinkId: string } }

function text(input: ExtensionInput, key: string): string | undefined {
  const value = input[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

async function assertBuyerCanProvision(
  client: Pick<typeof prisma, 'user'>,
  userId: number
): Promise<{ email: string }> {
  const buyer = await client.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true, status: true },
  })
  if (!buyer) throw notFound('用户不存在')
  if (buyer.status !== '正常') throw badRequest('账号状态异常，无法下单')
  if (!buyer.emailVerified) throw badRequest('请先验证邮箱后再购买订阅类商品')
  return buyer
}

function stableResetInput(offer: Offer, input: ExtensionInput) {
  const accountLinkId = text(input, 'xboardAccountLinkId')
  const expectedTargetVersion = text(input, 'expectedXboardTargetVersion')
  const stableReset = usesStablePaidReset(offer)
  if ((accountLinkId || expectedTargetVersion) && !stableReset) throw badRequest('此规格不支持绑定账号重置')
  return { stableReset, accountLinkId, expectedTargetVersion }
}

/**
 * Xboard checkout: email-proof provisioning (v1) or a stable-account paid
 * reset (v2). Email OTP proof, capacity and account eligibility hit Xboard or
 * slow paths, so they run in `prepare`; the order transaction only re-checks
 * the frozen choice.
 */
export const xboardCheckout: CheckoutExtension<Prepared, Target> = {
  async preview({ userId, offer, extensionInput }) {
    const { stableReset, accountLinkId } = stableResetInput(offer, extensionInput)
    let unpurchasableReason: string | undefined
    const paidReset = stableReset ? await paidCheckoutPreview(userId, offer, accountLinkId) : undefined
    if (paidReset && !paidReset.eligible) unpurchasableReason = paidReset.blockReason ?? '请选择套餐账号'

    let fakaCapacity: ReturnType<typeof getFakaCapacityForPublicRead> | null = null
    if (!isFakaBridgeConfigured()) {
      unpurchasableReason ??= '平台未配置 FakaBridge，暂时无法购买此商品'
    } else if (offer.externalSku && !stableReset) {
      fakaCapacity = getFakaCapacityForPublicRead(offer.externalSku)
      if (fakaCapacity.source === 'xboard' && !fakaCapacity.sellable) {
        unpurchasableReason ??= fakaCapacity.reason ?? 'Xboard 套餐名额已满'
      }
    }
    return {
      unpurchasableReason,
      fields: {
        requiresProvisionEmailProof: !stableReset,
        ...(paidReset ? { xboardPaidReset: paidReset } : {}),
        fakaCapacity: fakaCapacity
          ? {
              remaining: fakaCapacity.remaining,
              capacityLimit: fakaCapacity.capacityLimit,
              sellable: fakaCapacity.sellable,
              source: fakaCapacity.source,
              reason: fakaCapacity.reason,
            }
          : null,
      },
    }
  },

  formFields(offer, fields) {
    return usesStablePaidReset(offer) ? withoutProvisionEmail(fields) : fields
  },

  async prepare({ userId, offer, purchaseForm, formAnswers, extensionInput, idempotencyKey, renewalOfOrderId }) {
    const { stableReset, accountLinkId, expectedTargetVersion } = stableResetInput(offer, extensionInput)
    if (stableReset && (!accountLinkId || !expectedTargetVersion || !idempotencyKey || renewalOfOrderId)) {
      throw new HttpError(409, 'CHECKOUT_CHANGED', '请选择并确认要重置的套餐账号')
    }
    if (!isFakaBridgeConfigured()) throw badRequest('平台未配置 FakaBridge，暂时无法购买此商品')
    if (!offer.externalSku) throw badRequest('FakaBridge 商品未配置 externalSku')
    const buyer = await assertBuyerCanProvision(prisma, userId)
    const answers = validatePurchaseFormAnswers(stableReset ? withoutProvisionEmail(purchaseForm) : purchaseForm, formAnswers)
    if (stableReset) {
      const check = await preflightPaidCheckout(userId, offer, accountLinkId!)
      if (check.target.version !== expectedTargetVersion) throw new HttpError(409, 'CHECKOUT_CHANGED', '套餐账号已变化，请重新确认')
      if (!check.eligible) throw badRequest('当前账号套餐不可购买此重置，请重新查询套餐状态')
      return { kind: 'paid_reset', target: check.target, expectedTargetVersion: expectedTargetVersion! }
    }
    const email = await assertProvisionEmailTrusted(userId, resolveFakaProvisionEmail(answers ?? formAnswers, buyer.email))
    const cap = await fetchFakaCapacityForSku(offer.externalSku)
    if (cap.source === 'xboard' && !cap.sellable) {
      throw badRequest(cap.reason ?? 'Xboard 套餐名额已满，请稍后再试或更换规格')
    }
    return { kind: 'email', email }
  },

  async validateInTx(tx, { userId, offer, prepared, purchaseFormAnswers, formAnswers }) {
    if (usesStablePaidReset(offer) !== (prepared.kind === 'paid_reset')) {
      throw new HttpError(409, 'CHECKOUT_CHANGED', '商品信息已变化，请重新确认')
    }
    // 配置缺失时 400（不是静默转人工），避免扣积分却永远开不出订阅。
    if (offer.deliveryMode !== 'manual_service') throw badRequest('FakaBridge 商品履约模式配置错误，请联系管理员')
    if (!offer.externalSku) throw badRequest('FakaBridge 商品未配置 externalSku')
    if (!isFakaBridgeConfigured()) throw badRequest('平台未配置 FakaBridge，暂时无法购买此商品')
    const buyer = await assertBuyerCanProvision(tx, userId)
    if (prepared.kind === 'paid_reset') {
      const current = await assertPaidCheckoutTarget(tx, userId, offer, prepared.target, prepared.expectedTargetVersion)
      return { email: current.email, sku: offer.externalSku, paidReset: { accountLinkId: prepared.target.accountLinkId } }
    }
    // 事务内再比对 resolved 与 preflight，防表单被并发篡改。
    const resolved = resolveFakaProvisionEmail(purchaseFormAnswers ?? formAnswers, buyer.email)
    if (prepared.email !== resolved) throw provisionEmailUnverified('开通邮箱校验已失效，请重新验证后再下单')
    return { email: prepared.email, sku: offer.externalSku }
  },

  async createTaskInTx(tx, { orderId, offer, target }) {
    // The SKU is the irreversible provisioning contract: lock the Offer and
    // re-check it so an admin switching SKU/integration after preflight cannot
    // provision the buyer onto the wrong plan.
    const recheck = await tx.$queryRaw<
      Array<{ externalIntegration: string | null; externalSku: string | null; autoProvision: boolean }>
    >`
      SELECT "externalIntegration", "externalSku", "autoProvision"
      FROM "Offer"
      WHERE "id" = ${offer.id}
      FOR NO KEY UPDATE`
    if (
      recheck.length === 0 ||
      recheck[0].externalIntegration !== 'faka_bridge' ||
      recheck[0].externalSku !== target.sku ||
      recheck[0].autoProvision
    ) {
      throw new HttpError(409, 'CHECKOUT_CHANGED', '商品信息已变化，请重新确认')
    }
    // Outbox row commits with the order; the remote call happens in the worker.
    const task = await createFakaBridgeTaskForOrder(tx, {
      orderId,
      email: target.email,
      sku: target.sku,
      maxAttempts: config.fakaBridge.maxAttempts,
      ...(target.paidReset ? { period: 'reset_traffic', paidReset: target.paidReset } : {}),
    })
    return () => scheduleFakaBridgeFirstAttempt(task.id)
  },
}
