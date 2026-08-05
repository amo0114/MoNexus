import { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'
import { badRequest, notFound, HttpError, provisionEmailUnverified } from '../../lib/httpError.js'
import { runProvisionBatch } from './provisionCron.js'
import { lockActiveWebhookConfigForShare } from '../merchant/webhookConfig.js'
import {
  createOrderStatusEvent,
  getProductFulfillmentMode,
  isInstantMode,
  normalizeOrderStatus,
  transitionOrderStatus,
  resolveSubscriptionExpiresAt,
} from './fulfillment.js'
import { debitAvailablePoints, holdAvailablePoints, settleHeldOrder } from './accounting.js'
import {
  claimIdempotencyKey,
  completeIdempotencyClaim,
  peekCompletedIdempotencyReplay,
  releaseIdempotencyClaim,
  type IdempotencyFingerprint,
} from './idempotency.js'
import { serializeUserOrderDetail, serializeUserOrderList } from './serializers.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import { logInventoryChange } from '../../lib/inventoryLog.js'
import { parseStoredPurchaseForm, validatePurchaseFormAnswers, computePurchaseFormVersion, findBookingDateField } from '../../lib/purchaseForm.js'
import { calendarDayToUtc } from '../../lib/businessTime.js'
import { assertCheckoutVerification } from '../checkout/verification.js'
import { resolvePurchaseOfferChecked } from '../../lib/offers.js'
import {
  parseStoredDeliveryFields,
  parseStoredStructuredContent,
  structuredContentToJson,
  type StructuredDeliveryContent,
} from '../../lib/deliveryFields.js'
import {
  assertProvisionEmailTrusted,
  createFakaBridgeTaskForOrder,
  fetchFakaCapacityForSku,
  isFakaBridgeConfigured,
  isFakaBridgeOffer,
  resolveFakaProvisionEmail,
  scheduleFakaBridgeFirstAttempt,
} from '../../lib/fakaBridge/index.js'
import {
  recordOrderAcceptances,
  resolveConsentEvidence,
  type ConsentEvidence,
} from '../legal/service.js'

/**
 * Deterministic seam for the Faka checkout race regression.  Production never
 * sets this hook; tests use it to mutate the Offer after checkout resolution
 * but before the transaction takes its final Offer row lock.
 */
type BeforeFakaOfferTaskRecheckHook = (input: {
  offerId: number
  externalSku: string
}) => Promise<void>
let beforeFakaOfferTaskRecheckHookForTests: BeforeFakaOfferTaskRecheckHook | null = null

export function __setBeforeFakaOfferTaskRecheckHookForTests(
  hook: BeforeFakaOfferTaskRecheckHook | null
): void {
  beforeFakaOfferTaskRecheckHookForTests = hook
}

// manual_service 商家履约 SLA：创建订单后 7 天内需交付，M3-S2 工作台高亮超时
// P6a：履约 SLA 天数迁入 SystemConfig（fulfillmentSlaDays），下单事务内读取。

export type CreateOrderOptions = {
  // 购买的规格（P4a）。可选：单 SKU 商品由服务端解析为唯一 active Offer。
  offerId?: number
  // 服务端最终价确认：与商品当前价不一致时拒单（409 PRICE_CHANGED），
  // 用户必须针对新价格重新确认，而不是静默按新价格成交。
  expectedPrice?: number
  // 同一结算意图（双击/超时重试/网络重放)只允许产生一笔订单。
  idempotencyKey?: string
  // 购买前表单答案：按商品当前定义校验后与定义一并快照进订单。
  formAnswers?: Record<string, string>
  // 结算预览返回的表单版本：商家在预览后改动表单时拒单（409 CHECKOUT_CHANGED）。
  expectedPurchaseFormVersion?: string
  // 结算预览返回的 Offer 结算版本（价格/状态/履约方式/库存模式/固定内容/交付
  // 模板摘要）：商家在预览后改动任一项时拒单（409 CHECKOUT_CHANGED）——买家
  // 确认的是"将获得什么"，不只是价格。可选以兼容旧客户端。
  expectedCheckoutVersion?: string
  // 高风险二次验证：触发阈值时必须携带的登录密码（checkout/verification.ts）。
  verificationPassword?: string
  // P6a：手动续费——指向被续费的原订单。事务内校验同买家/同规格/订阅交付，
  // 交付时若原单未过期则到期时刻自原到期顺延（resolveSubscriptionExpiresAt）。
  renewalOfOrderId?: number
  // SPEC-LEGAL-001：协议确认 { document: version }（来自结算预览的
  // legalRequirement）；证据在订单事务内随单落库。
  agreementVersions?: Record<string, string>
  // 确认证据的网络标识：IP 原样、UA 截断 ≤512，retention cron 到期匿名化。
  ip?: string
  userAgent?: string
}

export async function createOrder(
  userId: number,
  productId: number,
  options: CreateOrderOptions = {}
) {
  const {
    offerId,
    expectedPrice,
    idempotencyKey,
    formAnswers,
    expectedPurchaseFormVersion,
    expectedCheckoutVersion,
    verificationPassword,
    renewalOfOrderId,
    agreementVersions,
    ip,
    userAgent,
  } = options

  const fingerprint: IdempotencyFingerprint = {
    productId,
    offerId,
    expectedPrice,
    purchaseFormVersion: expectedPurchaseFormVersion,
    checkoutVersion: expectedCheckoutVersion,
    formAnswers,
    renewalOfOrderId,
    agreementVersions,
  }

  // SPEC-LEGAL-001 复审 P1：已完成记录的重放识别先于协议校验——协议升级
  // 不得阻断已成功意图按原 key + 原版本重放（否则前端换新键重确认会产生
  // 第二笔订单）。
  if (idempotencyKey) {
    const replay = await peekCompletedIdempotencyReplay(userId, idempotencyKey, fingerprint)
    if (replay) return buildReplayResponse(replay.orderId, userId)
  }

  // SPEC-LEGAL-001：协议证据解析先于幂等 claim——REQUIRED/STALE 是纯注册表
  // 比对，失败请求不占幂等键，前端换新版本后同 key 重试不受污染。
  const consentEvidence = resolveConsentEvidence('order', agreementVersions)

  let claimToken: string | undefined
  if (idempotencyKey) {
    const claim = await claimIdempotencyKey(userId, idempotencyKey, fingerprint)
    if (claim.kind === 'replay') return buildReplayResponse(claim.orderId, userId)
    claimToken = claim.claimToken
  }

  try {
    // 高风险二次验证：幂等 claim 之后、订单事务之前（bcrypt 慢操作不进事务）。
    // 验证前先做轻量的价格/表单版本预检——商家改价（或改表单）恰好把订单推过
    // 验证阈值时，必须优先返回 409 让前端重新报价（新 preview 会带上密码框），
    // 而不是先返回 VERIFICATION_REQUIRED 把用户卡在没有密码框的旧弹窗里。
    // 这里只是预检，事务内仍保留最终一致性校验；商品缺失由事务内统一 404。
    const current = await prisma.product.findUnique({
      where: { id: productId },
      select: { purchaseForm: true },
    })
    if (current) {
      // P4b：带结算版本守卫的解析（风控前预检）。版本先于"下架/不可购买"
      // 判定——预览后规格被下架/改配置统一 409 让前端重新报价，事务内保留终检。
      const offer = await resolvePurchaseOfferChecked(prisma, productId, offerId, expectedCheckoutVersion)
      if (expectedPrice != null && expectedPrice !== offer.price) {
        throw new HttpError(409, 'PRICE_CHANGED', '商品信息已变化，请重新确认')
      }
      if (
        expectedPurchaseFormVersion != null &&
        expectedPurchaseFormVersion !== computePurchaseFormVersion(parseStoredPurchaseForm(current.purchaseForm))
      ) {
        throw new HttpError(409, 'CHECKOUT_CHANGED', '商品信息已变化，请重新确认')
      }
      // 服务端按当前价重算触发条件，不信任 preview 的 requiresVerification 声明。
      // 失败抛错走下面的 release 路径，同 key 可换密码重试同一意图。
      await assertCheckoutVerification(userId, offer.price, verificationPassword)
    }
    return await createOrderOnce(userId, productId, {
      offerId,
      expectedPrice,
      idempotencyKey,
      formAnswers,
      expectedPurchaseFormVersion,
      expectedCheckoutVersion,
      renewalOfOrderId,
      claimToken,
      consentEvidence,
      ip,
      userAgent,
    })
  } catch (err) {
    // 事务已回滚，释放幂等占用让用户可以用同一 key 重试同一意图。
    // 释放按租约 token 定向：若占用已被其他请求接管，这里不会误删。
    if (idempotencyKey && claimToken) {
      await releaseIdempotencyClaim(userId, idempotencyKey, claimToken)
    }
    throw err
  }
}

/** Rebuild the createOrder response shape for an idempotent replay. */
async function buildReplayResponse(orderId: number, userId: number) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    include: {
      product: { select: { name: true } },
      merchant: { select: { id: true, name: true } },
      delivery: {
        select: {
          content: true,
          contentType: true,
          structuredContent: true,
          expiresAt: true,
          file: { select: { fileName: true, size: true } },
        },
      },
    },
  })
  // 幂等记录指向的订单只可能因数据被外部改动而缺失。
  if (!order) throw notFound('订单不存在')

  const account = await prisma.pointAccount.findUnique({ where: { userId } })
  const fakaTask = await prisma.fakaBridgeTask.findUnique({
    where: { orderId },
    select: { status: true },
  })
  const replayExpired = order.delivery?.expiresAt != null && order.delivery.expiresAt.getTime() <= Date.now()
  return {
    orderId: order.id,
    productName: order.productNameSnapshot ?? order.product.name,
    price: order.price,
    status: normalizeOrderStatus(order.status),
    deliveryMode: getProductFulfillmentMode(order.deliveryModeSnapshot),
    // 复审 P2-2：重放是唯一绕过遮蔽序列化器的买家可达投影——订阅到期后
    // 重放同样不回明文（重放窗口内的短订阅可能已过期）。
    deliveryContent: replayExpired ? undefined : order.delivery?.content ?? undefined,
    deliveryContentType: order.delivery?.contentType ?? undefined,
    deliveryStructuredContent: replayExpired
      ? undefined
      : parseStoredStructuredContent(order.delivery?.structuredContent) ?? undefined,
    deliveryFile: order.delivery?.file ?? undefined,
    balanceAfter: account?.balance ?? 0,
    merchantId: order.merchantId,
    merchantName: order.merchant?.name ?? null,
    provisionPending: fakaTask != null && fakaTask.status === 'pending',
    idempotentReplay: true,
  }
}

async function createOrderOnce(
  userId: number,
  productId: number,
  {
    offerId,
    expectedPrice,
    idempotencyKey,
    formAnswers,
    expectedPurchaseFormVersion,
    expectedCheckoutVersion,
    renewalOfOrderId,
    claimToken,
    consentEvidence,
    ip,
    userAgent,
  }: CreateOrderOptions & { claimToken?: string; consentEvidence: ConsentEvidence[] }
) {
  // P7b：事务外旁路标记——提交成功后尽力即时首呼（正确性由 cron 兜底）。
  let autoProvisionTaskCreated = false
  // FakaBridge outbox id — only set when the offer provisions via Xboard.
  let fakaBridgeTaskId: number | null = null

  // Faka preflight OUTSIDE the order transaction: email OTP proof + Xboard capacity
  // HTTP must not run under an open DB transaction.
  let fakaPreflightEmail: string | null = null
  {
    const productPeek = await prisma.product.findUnique({
      where: { id: productId },
      select: { status: true, purchaseForm: true },
    })
    if (productPeek && productPeek.status === 'active') {
      try {
        const offerPeek = await resolvePurchaseOfferChecked(
          prisma,
          productId,
          offerId,
          expectedCheckoutVersion
        )
        // 互斥：规格配置冲突直接拒绝（正常被 DB CHECK 挡住；此处防御）
        if (offerPeek.autoProvision && isFakaBridgeOffer(offerPeek)) {
          throw badRequest(
            '商品规格配置冲突：不能同时开启商家自动开通与 FakaBridge，请联系商家/管理员'
          )
        }
        if (isFakaBridgeOffer(offerPeek)) {
          if (!isFakaBridgeConfigured()) {
            throw badRequest('平台未配置 FakaBridge，暂时无法购买此商品')
          }
          if (!offerPeek.externalSku) {
            throw badRequest('FakaBridge 商品未配置 externalSku')
          }
          const buyer = await prisma.user.findUnique({
            where: { id: userId },
            select: { email: true, emailVerified: true, status: true },
          })
          if (!buyer) throw notFound('用户不存在')
          if (buyer.status !== '正常') throw badRequest('账号状态异常，无法下单')
          if (!buyer.emailVerified) {
            throw badRequest('请先验证邮箱后再购买订阅类商品')
          }
          const formFields = parseStoredPurchaseForm(productPeek.purchaseForm)
          const answers = validatePurchaseFormAnswers(formFields, formAnswers)
          const resolved = resolveFakaProvisionEmail(answers ?? formAnswers, buyer.email)
          fakaPreflightEmail = await assertProvisionEmailTrusted(userId, resolved)

          const cap = await fetchFakaCapacityForSku(offerPeek.externalSku)
          if (cap.source === 'xboard' && !cap.sellable) {
            throw badRequest(cap.reason ?? 'Xboard 套餐名额已满，请稍后再试或更换规格')
          }
        }
      } catch (err) {
        // PRICE_CHANGED / CHECKOUT_CHANGED from offer resolve must surface as-is;
        // rethrow everything from preflight.
        throw err
      }
    }
  }

  const result = await prisma.$transaction(async tx => {
    const account = await tx.pointAccount.findUnique({ where: { userId } })
    if (!account) throw notFound('积分账户不存在')

    const product = await tx.product.findUnique({ where: { id: productId } })
    if (!product) throw notFound('商品不存在')
    if (product.status !== 'active') throw badRequest('商品已下架')
    // P4a：价格与履约配置以所选 Offer 为准（单 SKU 未传 offerId 时解析默认）。
    // P4b：结算版本终检在解析内完成（与预检同序：版本先于下架判定）。
    const offer = await resolvePurchaseOfferChecked(tx, productId, offerId, expectedCheckoutVersion)
    if (expectedPrice != null && expectedPrice !== offer.price) {
      throw new HttpError(409, 'PRICE_CHANGED', '商品信息已变化，请重新确认')
    }

    // FakaBridge 终检：集成规格必须是 manual_service + 平台已配置 + 买家邮箱已验证。
    // 配置缺失时 400（不是静默转人工），避免扣积分却永远开不出订阅。
    const fakaBridge = isFakaBridgeOffer(offer)
    if (fakaBridge) {
      if (offer.deliveryMode !== 'manual_service') {
        throw badRequest('FakaBridge 商品履约模式配置错误，请联系管理员')
      }
      if (!offer.externalSku) {
        throw badRequest('FakaBridge 商品未配置 externalSku')
      }
      if (!isFakaBridgeConfigured()) {
        throw badRequest('平台未配置 FakaBridge，暂时无法购买此商品')
      }
    }
    // 购买前表单：先做版本比对——商家在买家打开弹窗后改动表单（新增必填、
    // 删选项等）时，买家看到的还是旧表单，必须重新报价确认而不是校验失败 400。
    const purchaseFormFields = parseStoredPurchaseForm(product.purchaseForm)
    if (
      expectedPurchaseFormVersion != null &&
      expectedPurchaseFormVersion !== computePurchaseFormVersion(purchaseFormFields)
    ) {
      throw new HttpError(409, 'CHECKOUT_CHANGED', '商品信息已变化，请重新确认')
    }
    const purchaseFormAnswers = validatePurchaseFormAnswers(purchaseFormFields, formAnswers)
    // P6c：预约日期列化——取 date 字段（schema 限定至多一个）的已校验答案
    // （YYYY-MM-DD），商家排序与提醒 cron 免查答案 JSON。存储为该日历日的
    // UTC 零点（复审 P1-3：与运行时区无关）。无日期字段/未填（非必填）= null。
    const bookingDateField = findBookingDateField(purchaseFormFields)
    const bookingDateAnswer = bookingDateField ? purchaseFormAnswers?.[bookingDateField.key] : undefined
    const orderBookingDate = bookingDateAnswer ? calendarDayToUtc(bookingDateAnswer) : null
    const deliveryMode = getProductFulfillmentMode(offer.deliveryMode)
    // P4b：下单即冻结交付字段模板——人工服务发货按此快照强制校验，商家改
    // 模板不影响已购未发货订单（快照惯例同 deliveryModeSnapshot）。
    const deliveryFieldsSnapshot = parseStoredDeliveryFields(offer.deliveryFields)

    // P5：file 形态的"内容"是 fixedFileId 指向的文件；text/url 形态仍看 fixedContent。
    // 文件被吊销/清理即停售——新订单在这里被挡下，已成交订单不受影响（读快照）。
    let purchasedFile: { id: number; fileName: string; size: number } | null = null
    if (deliveryMode === 'instant_fixed') {
      if (offer.fixedContentType === 'file') {
        const file = offer.fixedFileId == null
          ? null
          : await tx.deliveryFile.findUnique({
              where: { id: offer.fixedFileId },
              select: { id: true, fileName: true, size: true, status: true },
            })
        if (!file || file.status !== 'active') {
          throw badRequest('商品暂不可购买，请联系商家')
        }
        purchasedFile = { id: file.id, fileName: file.fileName, size: file.size }
      } else if (!offer.fixedContent) {
        throw badRequest('商品暂不可购买，请联系商家')
      }
    }
    if (deliveryMode !== 'instant_inventory' && offer.stockMode === 'limited' && offer.stock <= 0) {
      throw badRequest('库存不足，请稍后再试')
    }

    // P6a T3：续费关联校验（事务内终检，预检 /renew 只是引导）——原单必须
    // 存在、属于同一买家（查询条件即防枚举，失败不区分"不存在/他人"）、
    // 与本次购买同一规格、且是订阅交付（有到期时刻）。
    if (renewalOfOrderId != null) {
      // 复审 P1-1：先锁原单行再查续费链。两个不同幂等键并发续同一原单时，
      // 都会在"查到无续费子单"后创建成功——两张新单都自原到期顺延，买家
      // 重复扣款只延一份时长。FOR UPDATE 串行化后，后到者在锁释放后重查
      // 必然看到先到者的续费单 → RENEW_ALREADY_RENEWED。退款走
      // transitionOrderStatus 的行更新，同样被此锁序：要么先退款（下方
      // status 终检拒单），要么先续费（退款后的交付继承由 P1-2 收口）。
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${renewalOfOrderId} FOR UPDATE`
      const original = await tx.order.findFirst({
        where: { id: renewalOfOrderId, userId },
        select: {
          offerId: true,
          status: true,
          delivery: { select: { expiresAt: true } },
          renewals: { where: { status: { not: 'refunded' } }, select: { id: true }, take: 1 },
        },
      })
      if (!original || original.offerId !== offer.id || original.delivery?.expiresAt == null) {
        throw new HttpError(400, 'RENEW_INVALID', '续费关联订单无效，请从订单详情重新发起续费')
      }
      // 退款保留 expiresAt 仅作审计——已退款原单的剩余时长不可被续费免费继承。
      if (original.status === 'refunded') {
        throw new HttpError(400, 'RENEW_INVALID', '订单已退款，无法续费')
      }
      // 续费链终检：原单已有未退款续费单时必须在链尾（最新订单）续费，
      // 否则两次续费都自原到期顺延——买家花两份钱只延一份时长。
      if (original.renewals.length > 0) {
        throw new HttpError(400, 'RENEW_ALREADY_RENEWED', '该订单已续费，请在最新的续费订单上操作')
      }
    }

    let merchantId: number | null = null
    let merchantName: string | null = null
    let commissionRate = 0
    let commissionAmount = 0

    if (product.merchantId != null) {
      const merchant = await tx.merchant.findUnique({ where: { id: product.merchantId } })
      if (!merchant || merchant.status !== 'active') throw badRequest('商家暂不可用')

      merchantId = merchant.id
      merchantName = merchant.name
      commissionRate = Number(merchant.commissionRate)
      commissionAmount = Math.floor(offer.price * commissionRate)
    }

    const isManual = deliveryMode === 'manual_service'

    // FakaBridge 开通邮箱：使用事务前 preflight 已校验归属的邮箱（OTP / 登录邮箱）。
    // 事务内再比对 resolved 与 preflight，防表单被并发篡改。升/降级均允许。
    let buyerEmail: string | null = null
    if (fakaBridge) {
      const buyer = await tx.user.findUnique({
        where: { id: userId },
        select: { email: true, emailVerified: true, status: true },
      })
      if (!buyer) throw notFound('用户不存在')
      if (buyer.status !== '正常') throw badRequest('账号状态异常，无法下单')
      if (!buyer.emailVerified) {
        throw badRequest('请先验证邮箱后再购买订阅类商品')
      }
      const resolved = resolveFakaProvisionEmail(purchaseFormAnswers ?? formAnswers, buyer.email)
      if (!fakaPreflightEmail || fakaPreflightEmail !== resolved) {
        throw provisionEmailUnverified('开通邮箱校验已失效，请重新验证后再下单')
      }
      buyerEmail = fakaPreflightEmail
    }

    // 积分流转规则（PRD §4.3.1）：
    // - instant_* 模式：即时扣减，PointLog 'out'，Settlement 'pending'
    // - manual_service：原子地从可用积分转入冻结余额，Settlement 'holding'
    let orderHoldingPoints: number | null = null
    let orderFulfillmentDeadline: Date | null = null
    let balanceAfter = account.balance
    let settledSettlementStatus: 'pending' | 'holding' = 'pending'
    let fundsHeld = false

    if (isManual) {
      // 虚拟服务订单：冻结真实占用可用积分，避免同一余额被多笔订单重复使用。
      orderHoldingPoints = offer.price
      const slaDays = await getSystemConfigValue('fulfillmentSlaDays', tx)
      orderFulfillmentDeadline = new Date(Date.now() + slaDays * 24 * 60 * 60 * 1000)
      settledSettlementStatus = 'holding'
      balanceAfter = await holdAvailablePoints(tx, userId, offer.price)
      fundsHeld = true
    } else {
      // 即时模式：带余额条件的原子扣减，禁止并发下单透支。
      balanceAfter = await debitAvailablePoints(tx, userId, offer.price)
    }

    const order = await tx.order.create({
      data: {
        userId,
        productId,
        offerId: offer.id,
        offerNameSnapshot: offer.name,
        ...(deliveryFieldsSnapshot.length > 0
          ? { deliveryFieldsSnapshot: deliveryFieldsSnapshot as unknown as Prisma.InputJsonValue }
          : {}),
        price: offer.price,
        status: isInstantMode(deliveryMode) ? 'delivered' : 'pending',
        merchantId,
        commissionRate,
        commissionAmount,
        deliveryModeSnapshot: deliveryMode,
        productNameSnapshot: product.name,
        productTypeSnapshot: product.type,
        productIconSnapshot: product.icon,
        productImageUrlSnapshot: product.imageUrl,
        holdingPoints: orderHoldingPoints,
        fundsHeld,
        fulfillmentDeadline: orderFulfillmentDeadline,
        // P6a：订阅时长快照——商家改 Offer.validityDays 不影响本单。
        validityDaysSnapshot: offer.validityDays ?? null,
        bookingDate: orderBookingDate,
        // P6a：续费链落库（Restrict 外键，原单行不可删）。
        renewalOfOrderId: renewalOfOrderId ?? null,
        // 定义与答案一并快照：商家之后改表单不影响本单的展示与履约依据。
        ...(purchaseFormFields.length > 0 ? { purchaseFormSnapshot: purchaseFormFields } : {}),
        ...(purchaseFormAnswers ? { purchaseFormAnswers } : {}),
      },
    })

    await createOrderStatusEvent(tx, {
      orderId: order.id,
      actorUserId: userId,
      actorRole: 'user',
      fromStatus: null,
      toStatus: order.status,
      action: fakaBridge ? 'order.created.faka_bridge' : `order.created.${deliveryMode}`,
    })

    // SPEC-LEGAL-001：订单级协议确认快照与订单同事务落库（只插入不更新），
    // (orderId, document) 唯一使幂等重放/重试不产生重复行。
    await recordOrderAcceptances(tx, {
      orderId: order.id,
      userId,
      evidences: consentEvidence,
      ip,
      userAgent,
    })

    // 自动履约 outbox：P7b 与 Faka 互斥——同一订单只创建一条路径。
    if (fakaBridge && offer.autoProvision) {
      throw badRequest(
        '商品规格配置冲突：不能同时开启商家自动开通与 FakaBridge，请联系商家/管理员'
      )
    }
    if (fakaBridge && buyerEmail && offer.externalSku) {
      // FakaBridge 的 preflight（邮箱证明、容量）必须在事务外执行，但其 SKU 是
      // 不可逆外呼的履约合同。最终在同一订单事务内锁 Offer 并重验，避免管理员
      // 在 resolvePurchaseOfferChecked() 与 outbox create 之间切换 SKU / 集成，
      // 让买家按旧快照被开通到错误套餐。
      if (beforeFakaOfferTaskRecheckHookForTests) {
        await beforeFakaOfferTaskRecheckHookForTests({
          offerId: offer.id,
          externalSku: offer.externalSku,
        })
      }
      const fakaOfferRecheck = await tx.$queryRaw<
        Array<{
          externalIntegration: string | null
          externalSku: string | null
          autoProvision: boolean
        }>
      >`
        SELECT "externalIntegration", "externalSku", "autoProvision"
        FROM "Offer"
        WHERE "id" = ${offer.id}
        FOR NO KEY UPDATE`
      if (
        fakaOfferRecheck.length === 0 ||
        fakaOfferRecheck[0].externalIntegration !== 'faka_bridge' ||
        fakaOfferRecheck[0].externalSku !== offer.externalSku ||
        fakaOfferRecheck[0].autoProvision
      ) {
        throw new HttpError(409, 'CHECKOUT_CHANGED', '商品信息已变化，请重新确认')
      }
      // FakaBridge outbox：与订单同事务提交；外呼在事务外 worker。
      const task = await createFakaBridgeTaskForOrder(tx, {
        orderId: order.id,
        email: buyerEmail,
        sku: offer.externalSku,
        maxAttempts: config.fakaBridge.maxAttempts,
      })
      fakaBridgeTaskId = task.id
    } else if (offer.autoProvision) {
      // P7b：自动开通任务（transactional outbox）——冻结商家当前 active webhook。
      const webhookConfig = merchantId == null
        ? null
        : await lockActiveWebhookConfigForShare(tx, merchantId)
      if (!webhookConfig) {
        throw new HttpError(409, 'AUTO_PROVISION_UNAVAILABLE', '商品信息已变化，请重新确认')
      }
      const offerRecheck = await tx.$queryRaw<
        Array<{ autoProvision: boolean; externalIntegration: string | null }>
      >`
        SELECT "autoProvision", "externalIntegration" FROM "Offer" WHERE "id" = ${offer.id} FOR NO KEY UPDATE`
      if (
        offerRecheck.length === 0 ||
        !offerRecheck[0].autoProvision ||
        offerRecheck[0].externalIntegration === 'faka_bridge'
      ) {
        throw new HttpError(409, 'AUTO_PROVISION_UNAVAILABLE', '商品信息已变化，请重新确认')
      }
      await tx.provisionTask.create({
        data: { orderId: order.id, webhookConfigId: webhookConfig.id },
      })
      autoProvisionTaskCreated = true
    }

    let deliveryContent: string | undefined
    let deliveryContentType: string | undefined
    let deliveryStructuredContent: StructuredDeliveryContent | null = null

    // P6a：即时交付的订阅到期时刻（null = 永久）。续费单且原单未过期时
    // 自原到期顺延——与人工交付路径共用同一解析逻辑（fulfillment.ts）。
    const subscriptionExpiresAt = isInstantMode(deliveryMode)
      ? await resolveSubscriptionExpiresAt(tx, order, order.validityDaysSnapshot, new Date())
      : null

    if (deliveryMode === 'instant_inventory') {
      // Claim one row in the database instead of first reading a candidate
      // and then conditionally updating it. SKIP LOCKED lets simultaneous
      // buyers move on to the next available secret rather than all racing
      // for the first row and unnecessarily rejecting valid purchases.
      const reservedItems = await tx.$queryRaw<Array<{ id: number; content: string; structuredContent: unknown }>>(Prisma.sql`
        UPDATE "InventoryItem"
        SET "status" = 'sold',
            "orderId" = ${order.id},
            "soldToUserId" = ${userId},
            "soldAt" = NOW()
        WHERE "id" = (
          SELECT "id"
          FROM "InventoryItem"
          WHERE "offerId" = ${offer.id}
            AND "status" = 'available'
          ORDER BY "id" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING "id", "content", "structuredContent"
      `)
      const item = reservedItems[0]
      if (!item) throw badRequest('库存不足，请稍后再试')

      deliveryContent = item.content
      deliveryContentType = 'text'
      // P4b：条目携带的自包含快照 { fields, values } 原样落进交付记录——
      // 商家后续改模板不影响这笔订单的字段化展示；非法形态按纯文本兜底。
      deliveryStructuredContent = parseStoredStructuredContent(item.structuredContent)

      await tx.deliveryRecord.create({
        data: {
          orderId: order.id,
          userId,
          productId,
          content: item.content,
          contentType: 'text',
          structuredContent: deliveryStructuredContent
            ? structuredContentToJson(deliveryStructuredContent)
            : undefined,
          status: 'delivered',
          deliveredAt: new Date(),
          expiresAt: subscriptionExpiresAt,
        },
      })

    } else if (deliveryMode === 'instant_fixed') {
      if (purchasedFile) {
        // P5：下单事务冻结文件引用——商家换文件只影响后续订单，
        // 本单下载永远按这份快照授权，绝不回查当前 Offer。
        deliveryContentType = 'file'
        await tx.deliveryRecord.create({
          data: {
            orderId: order.id,
            userId,
            productId,
            content: null,
            contentType: 'file',
            fileId: purchasedFile.id,
            status: 'delivered',
            deliveredAt: new Date(),
            expiresAt: subscriptionExpiresAt,
          },
        })
      } else {
        deliveryContent = offer.fixedContent!
        deliveryContentType = offer.fixedContentType

        await tx.deliveryRecord.create({
          data: {
            orderId: order.id,
            userId,
            productId,
            content: offer.fixedContent,
            contentType: offer.fixedContentType,
            status: 'delivered',
            deliveredAt: new Date(),
            expiresAt: subscriptionExpiresAt,
          },
        })
      }
    }

    await tx.pointLog.create({
      data: {
        userId,
        type: isManual ? 'hold' : 'out',
        amount: offer.price,
        balanceAfter,
        reason: isManual ? `订单冻结积分: #${order.id}` : `兑换商品: ${product.name}`,
        orderId: order.id,
      },
    })

    if (merchantId != null) {
      await tx.settlement.create({
        data: {
          merchantId,
          orderId: order.id,
          orderAmount: offer.price,
          commissionRate,
          commissionAmount,
          settlementAmount: offer.price - commissionAmount,
          status: settledSettlementStatus,
        },
      })
    }

    // 库存/销量：Offer 是真相源；Product 同名列是投影，同事务增量镜像维护
    //（避免全量重算的额外查询）。
    if (deliveryMode === 'instant_inventory') {
      await tx.offer.update({ where: { id: offer.id }, data: { sales: { increment: 1 } } })
      await tx.product.update({
        where: { id: productId },
        // 即时库存已经通过上面的 InventoryItem 原子领取变为 sold；
        // Product.stock 不再是该模式的库存来源或缓存投影。
        data: { sales: { increment: 1 } },
      })
    } else if (offer.stockMode === 'limited') {
      // 条件更新防并发超卖：stock>0 才扣减，失败即售罄
      const updated = await tx.offer.updateMany({
        where: { id: offer.id, stock: { gt: 0 } },
        data: { stock: { decrement: 1 }, sales: { increment: 1 } },
      })
      if (updated.count !== 1) throw badRequest('库存不足，请稍后再试')
      await tx.product.updateMany({
        where: { id: productId, stock: { gt: 0 } },
        data: { stock: { decrement: 1 }, sales: { increment: 1 } },
      })
    } else {
      await tx.offer.update({ where: { id: offer.id }, data: { sales: { increment: 1 } } })
      await tx.product.update({
        where: { id: productId },
        data: { sales: { increment: 1 } },
      })
    }

    if (deliveryMode === 'instant_inventory' || offer.stockMode === 'limited') {
      // Every finite sellable resource is consumed exactly once. This entry
      // is written in the same transaction as either the InventoryItem claim
      // or the numeric capacity decrement, while retaining only the order
      // reference—not any delivery secret.
      await logInventoryChange(tx, {
        productId,
        offerId: offer.id,
        merchantId: product.merchantId,
        actorUserId: userId,
        action: 'sale',
        delta: -1,
        orderId: order.id,
      })
    }

    if (idempotencyKey && claimToken) {
      // 与订单创建同事务提交："订单存在"与"key 可重放"必须原子生效。
      // 租约 token 不匹配（占用已被接管）时抛错回滚，避免同 key 双单。
      await completeIdempotencyClaim(tx, userId, idempotencyKey, claimToken, order.id)
    }

    return {
      orderId: order.id,
      productName: product.name,
      price: offer.price,
      status: normalizeOrderStatus(order.status),
      deliveryMode,
      deliveryContent,
      deliveryContentType,
      deliveryStructuredContent: deliveryStructuredContent ?? undefined,
      // P5：文件交付只回元数据（名称/大小）；下载走独立发放端点，
      // 响应里永远没有对象键或可直取的链接。
      deliveryFile: purchasedFile
        ? { fileName: purchasedFile.fileName, size: purchasedFile.size }
        : undefined,
      balanceAfter,
      merchantId,
      merchantName,
      // 买家可见：订阅开通任务已入队（实际 HTTP 在 M4 worker）。
      provisionPending: fakaBridge || autoProvisionTaskCreated,
    }
  })

  await invalidateProductPublicCache(productId, { detail: true, list: 'coalesced' })
  if (autoProvisionTaskCreated && config.nodeEnv !== 'test') {
    // 尽力而为的即时首呼：让买家秒级拿到开通结果；失败/崩溃由 provision cron 兜底。
    setImmediate(() => {
      void runProvisionBatch().catch(() => {})
    })
  }
  if (fakaBridgeTaskId != null) {
    scheduleFakaBridgeFirstAttempt(fakaBridgeTaskId)
  }
  return result
}

export async function getOrderDetail(orderId: number, userId: number) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    include: {
      merchant: { select: { id: true, name: true } },
      product: { select: { id: true, name: true, icon: true, type: true, imageUrl: true, deliveryMode: true } },
      delivery: {
        select: {
          status: true, content: true, contentType: true, structuredContent: true,
          publicNote: true, deliveredAt: true,
          // P6a：订阅到期时刻；序列化层据此补 expired 并做买家到期遮蔽。
          expiresAt: true,
          // P5：文件交付元数据（仅详情；列表 select 不含 delivery 内容照旧）。
          file: { select: { fileName: true, size: true, status: true } },
        },
      },
      review: {
        select: { rating: true, comment: true, status: true, editableUntil: true, editedAt: true, createdAt: true },
      },
      // 是否存在未退款的续费单（仅详情；只取存在性，不透出续费单行）——
      // 买家端据此隐藏「续费」入口，指引到链尾（最新订单）操作。
      renewals: { where: { status: { not: 'refunded' } }, select: { id: true }, take: 1 },
      // P7b：pending 任务 → 买家详情「自动开通中」提示态（序列化层折叠为
      // provisionPending 布尔，只取 status，绝不透传任务内部字段）。
      provisionTask: { select: { status: true } },
      // P6b：买家时间线固定契约——仅 action/fromStatus/toStatus/publicNote/
      // createdAt/actorRole 六字段，不透出事件行 id 与操作人用户 id。
      statusEvents: {
        select: {
          actorRole: true,
          fromStatus: true,
          toStatus: true,
          action: true,
          publicNote: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  })
  if (!order) throw notFound('订单不存在')
  // 续费单行不进响应，只折叠为存在性布尔。
  const { renewals, ...orderRest } = order
  const normalized = normalizeOrderStatus(order.status)
  return {
    ...serializeUserOrderDetail(orderRest),
    holdingPoints: order.holdingPoints ?? null,
    fulfillmentDeadline: order.fulfillmentDeadline ?? null,
    // P6c：预约日期（null = 非预约单）。
    bookingDate: order.bookingDate ?? null,
    review: order.review ?? null,
    canReview: !order.review && (normalized === 'delivered' || normalized === 'closed'),
    // 已有未退款续费单——前端隐藏「续费」按钮（仅详情，列表行不带）。
    hasActiveRenewal: renewals.length > 0,
  }
}

function buildUserOrderWhere(userId: number, status?: string): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = { userId }
  if (!status) return where

  const normalizedStatus = normalizeOrderStatus(status)
  where.status = normalizedStatus === 'delivered'
    ? { in: ['delivered', 'completed'] }
    : normalizedStatus

  return where
}

export async function getUserOrders(userId: number, page = 1, pageSize = 20, status?: string) {
  const orders = await prisma.order.findMany({
    where: buildUserOrderWhere(userId, status),
    include: {
      merchant: { select: { id: true, name: true } },
      product: { select: { id: true, name: true, icon: true, type: true, imageUrl: true, deliveryMode: true } },
      // P6a：列表带 expiresAt 供「已过期」徽标（内容字段照旧不进列表查询）。
      delivery: { select: { status: true, expiresAt: true } },
    },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
  })
  return orders.map(order => ({
    ...serializeUserOrderList(order),
    holdingPoints: order.holdingPoints ?? null,
    // P6c：列表行透出预约日期供「预约单」标识（null = 非预约单）。
    bookingDate: order.bookingDate ?? null,
  }))
}

async function assertUserOwnsOrder(orderId: number, userId: number) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: { id: true },
  })
  if (!order) throw notFound('订单不存在')
}

export async function disputeOrder(orderId: number, userId: number) {
  await assertUserOwnsOrder(orderId, userId)
  await transitionOrderStatus({
    orderId,
    toStatus: 'disputed',
    actorRole: 'user',
    actorUserId: userId,
    action: 'user.dispute',
    publicNote: '用户发起争议',
  })

  return getOrderDetail(orderId, userId)
}

export async function closeOrder(orderId: number, userId: number) {
  // 用户确认关闭：积分正式扣减（若为 manual_service 冻结单）
  // PRD §4.3.1：delivered > 7 天自动 closed，积分正式扣减并触发 Settlement
  await assertUserOwnsOrder(orderId, userId)
  const result = await prisma.$transaction(async tx => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true, holdingPoints: true, fundsHeld: true, status: true, productId: true },
    })
    if (!order) throw notFound('订单不存在')

    // 状态流转：delivered → closed
    const updated = await transitionOrderStatus(
      {
        orderId,
        toStatus: 'closed',
        actorRole: 'user',
        actorUserId: userId,
        action: 'user.close',
        publicNote: '用户确认关闭',
      },
      tx
    )

    // 若为冻结单，正式消耗冻结积分并允许商家结算。
    await settleHeldOrder(tx, order, `订单关闭扣款: #${order.id}`)

    await tx.order.update({
      where: { id: orderId },
      data: { confirmedAt: new Date() },
    })

    return updated
  })

  await invalidateProductPublicCache(result.productId, { list: 'coalesced' })
  return getOrderDetail(orderId, userId)
}

/**
 * P6a T3：手动续费预检——只读、无副作用。返回原规格的"当前"商业值
 * （名称/价格/时长），买家经标准结算再次确认价格；实际续费走
 * POST /orders 携带 renewalOfOrderId，事务内另做终检。
 */
export async function renewOrderPrecheck(orderId: number, userId: number) {
  const order = await prisma.order.findFirst({
    // 归属放进查询条件：他人订单与不存在订单统一 404，防枚举。
    where: { id: orderId, userId },
    select: {
      id: true,
      productId: true,
      offerId: true,
      status: true,
      delivery: { select: { expiresAt: true } },
      renewals: { where: { status: { not: 'refunded' } }, select: { id: true }, take: 1 },
    },
  })
  if (!order) throw notFound('订单不存在')

  // 没有到期时刻 = 非订阅交付（永久或尚未交付），无从续费。
  if (order.delivery?.expiresAt == null) {
    throw new HttpError(400, 'RENEW_NOT_SUBSCRIPTION', '该订单不是订阅类订单，无需续费')
  }

  // 退款保留 expiresAt 仅作审计——已退款原单的剩余时长不可被续费免费继承。
  if (order.status === 'refunded') {
    throw new HttpError(400, 'RENEW_INVALID', '订单已退款，无法续费')
  }

  // 续费链约束：已有未退款续费单的订单不可再续（否则两次续费自同一到期
  // 顺延，买家花两份钱只延一份时长），引导买家到链尾（最新订单）操作。
  if (order.renewals.length > 0) {
    throw new HttpError(400, 'RENEW_ALREADY_RENEWED', '该订单已续费，请在最新的续费订单上操作')
  }

  const unavailable = () =>
    new HttpError(400, 'RENEW_OFFER_UNAVAILABLE', '原规格已下架或暂不可购买，无法续费')

  // 原规格必须仍在售：规格/商品任一下架即不可续费（offerId 为空的迁移前
  // 订单同样视为不可续费——无法保证"续的是同一规格"）。
  const offer = order.offerId == null
    ? null
    : await prisma.offer.findUnique({ where: { id: order.offerId } })
  if (!offer || offer.status !== 'active') throw unavailable()
  const product = await prisma.product.findUnique({
    where: { id: order.productId },
    select: { status: true },
  })
  if (!product || product.status !== 'active') throw unavailable()

  // 可购买性预检（与 createOrder 的挡单条件对齐，避免引导买家进入必败结算）：
  // instant_fixed 的固定内容/文件必须可用；限量规格必须仍有库存。
  const deliveryMode = getProductFulfillmentMode(offer.deliveryMode)
  if (deliveryMode === 'instant_fixed') {
    if (offer.fixedContentType === 'file') {
      const file = offer.fixedFileId == null
        ? null
        : await prisma.deliveryFile.findUnique({
            where: { id: offer.fixedFileId },
            select: { status: true },
          })
      if (!file || file.status !== 'active') throw unavailable()
    } else if (!offer.fixedContent) {
      throw unavailable()
    }
  }
  if (deliveryMode !== 'instant_inventory' && offer.stockMode === 'limited' && offer.stock <= 0) {
    throw unavailable()
  }

  return {
    productId: order.productId,
    offerId: offer.id,
    offerName: offer.name,
    price: offer.price,
    validityDays: offer.validityDays ?? null,
    currentExpiresAt: order.delivery.expiresAt,
  }
}
