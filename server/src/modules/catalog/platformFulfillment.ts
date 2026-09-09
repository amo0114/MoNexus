import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import {
  canonicalDeliveryText,
  parseStoredDeliveryFields,
  validateDeliveryValues,
  type StructuredDeliveryContent,
} from '../../lib/deliveryFields.js'
import { isFakaBridgeOffer } from '../../lib/fakaBridge/offerIntegration.js'
import {
  createOrderStatusEvent,
  getProductFulfillmentMode,
  transitionOrderStatus,
} from '../orders/fulfillment.js'
import { releaseHeldOrder } from '../orders/accounting.js'
import { applyRefundInventoryPolicy } from '../orders/refundInventory.js'

const EXTERNAL_FAKA_MANUAL_OVERRIDE_MESSAGE = '外部开通订单不能由平台人工替代交付'

function isExternalFakaFulfillment(order: {
  offer: { externalIntegration: string | null } | null
  fakaBridgeTask: { id: number } | null
}): boolean {
  // FakaBridge/Xboard snapshots as manual_service; offer flag, outbox row, or
  // leftover task after the offer is later unlinked all mean external provision.
  return isFakaBridgeOffer(order.offer ?? {}) || order.fakaBridgeTask != null
}

async function assertPlatformOrder(orderId: number, tx: Prisma.TransactionClient) {
  const order = await tx.order.findFirst({
    where: { id: orderId, merchantId: null, product: { merchantId: null } },
    select: {
      id: true,
      status: true,
      userId: true,
      holdingPoints: true,
      fundsHeld: true,
      deliveryModeSnapshot: true,
      offerId: true,
      deliveryFieldsSnapshot: true,
      productId: true,
      merchantId: true,
      product: { select: { deliveryMode: true, merchantId: true } },
      offer: { select: { externalIntegration: true } },
      fakaBridgeTask: { select: { id: true } },
    },
  })
  if (!order) throw notFound('订单不存在')
  if (isExternalFakaFulfillment(order)) {
    throw badRequest(EXTERNAL_FAKA_MANUAL_OVERRIDE_MESSAGE)
  }
  return order
}

async function assertPlatformFile(tx: Prisma.TransactionClient, fileId: number) {
  const file = await tx.deliveryFile.findFirst({
    where: { id: fileId, merchantId: null },
    select: { status: true },
  })
  if (!file) throw notFound('交付文件不存在')
  if (file.status !== 'active') throw badRequest('交付文件已不可用，请重新上传')
}

export async function startPlatformFulfillment(adminUserId: number, orderId: number) {
  await prisma.$transaction(async tx => {
    const order = await assertPlatformOrder(orderId, tx)
    if (order.status !== 'pending') throw badRequest('只有待处理的平台订单可以开始履约')
    await transitionOrderStatus({
      orderId,
      toStatus: 'processing',
      actorRole: 'admin',
      actorUserId: adminUserId,
      action: 'admin.fulfillment.start',
    }, tx)
  })
  return { id: orderId, status: 'processing' }
}

export async function postPlatformProgress(adminUserId: number, orderId: number, publicNote: string) {
  await prisma.$transaction(async tx => {
    const order = await assertPlatformOrder(orderId, tx)
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`
    const fresh = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } })
    if (fresh.status !== 'processing') throw badRequest('只有履约中的平台订单可以更新进度')
    await createOrderStatusEvent(tx, {
      orderId: order.id,
      actorUserId: adminUserId,
      actorRole: 'admin',
      fromStatus: 'processing',
      toStatus: 'processing',
      action: 'admin.progress',
      publicNote,
    })
  })
  return { id: orderId, status: 'processing' }
}

export async function deliverPlatformOrder(
  adminUserId: number,
  orderId: number,
  input: {
    content?: string
    structuredValues?: Record<string, string>
    attachmentFileId?: number
    publicNote?: string
  },
) {
  await prisma.$transaction(async tx => {
    const order = await assertPlatformOrder(orderId, tx)
    if (getProductFulfillmentMode(order.deliveryModeSnapshot) !== 'manual_service') {
      throw badRequest('只有人工服务订单可由平台履约交付')
    }
    if (input.attachmentFileId != null) {
      await assertPlatformFile(tx, input.attachmentFileId)
    }
    const fields = parseStoredDeliveryFields(order.deliveryFieldsSnapshot)
    const hasStructured = input.structuredValues != null && Object.keys(input.structuredValues).length > 0
    const hasText = (input.content ?? '').trim().length > 0
    if (hasStructured && hasText) throw badRequest('结构化字段与纯文本发货内容只能提交其一')
    let deliveryContent = input.content
    let deliveryStructuredContent: StructuredDeliveryContent | null = null
    if (fields.length > 0) {
      if (!hasStructured) throw badRequest('该订单需按交付字段模板逐项发货')
      const values = validateDeliveryValues(fields, input.structuredValues)
      deliveryContent = canonicalDeliveryText(fields, values)
      deliveryStructuredContent = { fields, values }
    } else if (hasStructured) {
      throw badRequest('该订单为纯文本交付，请提交发货内容')
    } else if (!hasText && input.attachmentFileId == null) {
      throw badRequest('发货内容不能为空')
    }
    await transitionOrderStatus({
      orderId,
      toStatus: 'delivered',
      actorRole: 'admin',
      actorUserId: adminUserId,
      action: 'admin.fulfillment.deliver',
      deliveryContent,
      deliveryStructuredContent,
      deliveryFileId: input.attachmentFileId ?? null,
      publicNote: input.publicNote,
    }, tx)
  })
  return { id: orderId, status: 'delivered' }
}

export async function rejectPlatformOrder(
  adminUserId: number,
  orderId: number,
  reason: string,
) {
  await prisma.$transaction(async tx => {
    const order = await assertPlatformOrder(orderId, tx)
    if (getProductFulfillmentMode(order.deliveryModeSnapshot) !== 'manual_service') {
      throw badRequest('只有人工服务订单可以拒单')
    }
    await transitionOrderStatus({
      orderId,
      toStatus: 'refunded',
      actorRole: 'admin',
      actorUserId: adminUserId,
      action: 'admin.fulfillment.reject',
      publicNote: reason,
    }, tx)
    await releaseHeldOrder(tx, order, `平台拒单释放冻结积分: #${order.id}`)
    // Unfilled platform reject (pending or processing, never delivered) uses
    // fromStatus pending so limited manual_service quota restocks. disputed
    // is only for post-delivery arbitration. Faka is already forbidden above.
    await applyRefundInventoryPolicy(tx, order, {
      fromStatus: 'pending',
      actorUserId: adminUserId,
    })
  })
  return { id: orderId, status: 'refunded' }
}
