import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { TrafficResetIntent } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { config } from '../../config/index.js'
import { HttpError, notFound } from '../../lib/httpError.js'
import { callFakaV2Capabilities } from '../../lib/fakaBridge/accountV2.js'
import { callResetPreview } from '../../lib/fakaBridge/resetV2.js'
import { assertActor, listAccounts, type AccountActor } from '../xboardAccounts/queries.js'
import { accountSettings, requireInstance } from '../xboardAccounts/settings.js'
import { BENEFIT_CODE, refreshGrantInTx, type Tx } from './benefits.js'

export function resetUnavailable() { return new HttpError(503, 'TRAFFIC_RESET_UNAVAILABLE', '免费重置暂未开放或服务不可用') }
export function ineligible() { return new HttpError(409, 'TRAFFIC_RESET_INELIGIBLE', '当前没有可用机会或套餐不符合重置条件，请重新查询') }
function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function keyId(secret: string) { return createHash('sha256').update(secret).digest('hex').slice(0, 16) }
function confirmation(intent: TrafficResetIntent) {
  const secret = [config.trafficReset.confirmSecret, config.trafficReset.previousConfirmSecret].find(key => key && keyId(key) === intent.keyId)
  if (!secret) throw resetUnavailable()
  const bytes = createHmac('sha256', secret).update(JSON.stringify([intent.id,intent.userId,intent.chatBindingId,intent.accountLinkId,intent.expiresAt.toISOString()])).digest()
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = bytes.readUInt32BE(0) >>> 2, result = ''
  for (let i = 0; i < 6; i++) { result = alphabet[bits & 31] + result; bits >>>= 5 }
  return result
}
function intentDto(intent: TrafficResetIntent) {
  return { intentId: intent.id, accountLinkId: intent.accountLinkId, confirmationCode: confirmation(intent),
    expiresAt: intent.expiresAt.toISOString(), expired: intent.expiresAt.getTime() <= Date.now(), consumes: 1 }
}
function assertReplay(intent: TrafficResetIntent, actor: AccountActor, requested?: string) {
  if (intent.chatBindingId !== actor.bindingId || intent.requestedAccountLinkId !== (requested ?? null)) {
    throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', '该请求编号已用于其他目标或绑定')
  }
}
export async function actorLock(tx: Tx, actor: AccountActor) {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actor.userId} FOR UPDATE`
  await tx.$queryRaw`SELECT "id" FROM "ChatBinding" WHERE "id" = ${actor.bindingId} FOR UPDATE`
  await assertActor(actor, tx)
}
async function liveLink(tx: Tx, actor: AccountActor, id: string, instanceId: string) {
  const link = await tx.xboardAccountLink.findFirst({ where: { id, userId: actor.userId, instanceId } })
  if (!link) throw notFound()
  if (link.status !== 'active') throw ineligible()
  return link
}
export async function requireResetCapabilities() {
  const caps = await callFakaV2Capabilities()
  if (!caps.ok || !caps.body.capabilities.resolve_by_order || !caps.body.capabilities.subscription_by_user_id
    || !caps.body.capabilities.reset_idempotency || !caps.body.capabilities.reset_status || !caps.body.capabilities.cancel_tombstone) throw resetUnavailable()
}

export async function createIntent(actor: AccountActor, input: { accountLinkId?: string; requestId: string }) {
  await assertActor(actor)
  const settings = await requireInstance()
  const known = await prisma.trafficResetIntent.findUnique({ where: { userId_requestId: { userId: actor.userId, requestId: input.requestId } } })
  if (known) {
    assertReplay(known, actor, input.accountLinkId)
    await prisma.$transaction(async tx => { await liveLink(tx, actor, known.accountLinkId, settings.instanceId); await assertActor(actor, tx) })
    return intentDto(known)
  }
  if (!config.trafficReset.requestsEnabled || !config.trafficReset.confirmSecret) throw resetUnavailable()
  const selected = input.accountLinkId ?? (await listAccounts(actor)).defaultAccountLinkId
  if (!selected) throw ineligible()
  const link = await prisma.$transaction(tx => liveLink(tx, actor, selected, settings.instanceId))
  await requireResetCapabilities()
  const preview = await callResetPreview(link.xboardUserId)
  if (!preview.ok) throw resetUnavailable()
  if (!preview.body.preview.eligible || !preview.body.preview.plan_id) throw ineligible()
  const snapshot = preview.body.preview
  return prisma.$transaction(async tx => {
    await actorLock(tx, actor)
    const grant = await refreshGrantInTx(tx, actor.userId)
    const existing = await tx.trafficResetIntent.findUnique({ where: { userId_requestId: { userId: actor.userId, requestId: input.requestId } } })
    if (existing) { assertReplay(existing, actor, input.accountLinkId); return intentDto(existing) }
    if (!grant || grant.status !== 'active' || grant.reserved + grant.consumed >= grant.granted) throw ineligible()
    const current = await liveLink(tx, actor, selected, settings.instanceId)
    if (current.xboardUserId !== link.xboardUserId) throw ineligible()
    const secret = config.trafficReset.confirmSecret!
    const id = randomUUID(), expiresAt = new Date(Date.now() + 120_000)
    const base = { id, userId: actor.userId, chatBindingId: actor.bindingId, accountLinkId: selected, expiresAt, keyId: keyId(secret) }
    const code = confirmation(base as TrafficResetIntent)
    const intent = await tx.trafficResetIntent.create({ data: { ...base, benefitGrantId: grant.id, instanceIdSnapshot: settings.instanceId,
      tokenHash: digest(code), expectedPlanId: snapshot.plan_id!, expectedFingerprint: snapshot.fingerprint,
      requestId: input.requestId, requestedAccountLinkId: input.accountLinkId ?? null,
      requestHash: digest([BENEFIT_CODE, selected, actor.bindingId, 'reset-intent']) } })
    return intentDto(intent)
  })
}

export async function confirmReset(actor: AccountActor, input: { intentId: string; confirmationCode: string; requestId: string }) {
  const settings = await requireInstance()
  const observed = await prisma.trafficResetIntent.findFirst({ where: { id: input.intentId, userId: actor.userId } })
  if (!observed) throw notFound()
  const requestHash = digest([input.intentId, actor.bindingId, 'confirm-reset'])
  // Existing operations remain readable when new requests are disabled.
  const result = await prisma.$transaction(async tx => {
    await actorLock(tx, actor)
    const grant = await refreshGrantInTx(tx, actor.userId)
    if (!grant || grant.id !== observed.benefitGrantId) throw ineligible()
    await tx.$queryRaw`SELECT "id" FROM "TrafficResetIntent" WHERE "id" = ${input.intentId}::uuid FOR UPDATE`
    const intent = await tx.trafficResetIntent.findUniqueOrThrow({ where: { id: input.intentId } })
    if (intent.chatBindingId !== actor.bindingId || intent.instanceIdSnapshot !== settings.instanceId) throw ineligible()
    const alias = await tx.trafficResetConfirmationRequest.findUnique({ where: { userId_requestId: { userId: actor.userId, requestId: input.requestId } } })
    if (alias && alias.requestHash !== requestHash) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', '请求编号已用于其他重置')
    const reused = alias ? await tx.xboardTrafficResetOperation.findUniqueOrThrow({ where: { id: alias.operationId } })
      : await tx.xboardTrafficResetOperation.findUnique({ where: { userId_requestId: { userId: actor.userId, requestId: input.requestId } } })
    if (reused && (reused.intentId !== intent.id || reused.requestHash !== requestHash)) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', '请求编号已用于其他重置')
    const existing = reused ?? await tx.xboardTrafficResetOperation.findUnique({ where: { intentId: intent.id } })
    if (existing) {
      if (existing.intentId !== intent.id || existing.requestHash !== requestHash) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', '请求编号已用于其他重置')
      if (!alias) await tx.trafficResetConfirmationRequest.create({ data: { userId: actor.userId, requestId: input.requestId, requestHash, operationId: existing.id } })
      return { operationId: existing.id, status: existing.status, replayed: true }
    }
    if (!config.trafficReset.requestsEnabled || !config.trafficReset.confirmSecret) throw resetUnavailable()
    if (intent.expiresAt.getTime() <= Date.now()) throw new HttpError(409, 'TRAFFIC_RESET_INTENT_EXPIRED', '确认已过期，请重新发起')
    if (intent.failedAttempts >= 5) return { invalid: true as const }
    const actual = Buffer.from(digest(input.confirmationCode)), expected = Buffer.from(intent.tokenHash)
    if (!timingSafeEqual(actual, expected)) {
      await tx.trafficResetIntent.update({ where: { id: intent.id }, data: { failedAttempts: { increment: 1 } } })
      return { invalid: true as const }
    }
    if (grant.status !== 'active' || grant.reserved + grant.consumed >= grant.granted) throw ineligible()
    const link = await liveLink(tx, actor, intent.accountLinkId, settings.instanceId)
    await tx.trafficResetBenefitGrant.update({ where: { id: grant.id }, data: { reserved: { increment: 1 }, version: { increment: 1 } } })
    const op = await tx.xboardTrafficResetOperation.create({ data: { id: randomUUID(), userId: actor.userId, intentId: intent.id,
      benefitGrantId: grant.id, accountLinkId: link.id, instanceIdSnapshot: settings.instanceId, originSnapshot: accountSettings().origin,
      clientIdSnapshot: config.trafficReset.clientId, xboardUserIdSnapshot: link.xboardUserId, benefitCodeSnapshot: BENEFIT_CODE,
      sourceOrderId: grant.sourceOrderId, expectedPlanId: intent.expectedPlanId, expectedFingerprint: intent.expectedFingerprint,
      requestId: input.requestId, requestHash } })
    await tx.trafficResetConfirmationRequest.create({ data: { userId: actor.userId, requestId: input.requestId, requestHash, operationId: op.id } })
    return { operationId: op.id, status: op.status, replayed: false }
  })
  if ('invalid' in result) throw new HttpError(400, 'TRAFFIC_RESET_CONFIRMATION_INVALID', '确认码无效或尝试次数过多')
  return result
}

export async function resetStatus(actor: AccountActor, operationId: string) {
  await assertActor(actor)
  const { instanceId } = await requireInstance()
  const op = await prisma.xboardTrafficResetOperation.findFirst({ where: { id: operationId, userId: actor.userId, instanceIdSnapshot: instanceId } })
  if (!op) throw notFound()
  await assertActor(actor)
  return { operationId: op.id, accountLinkId: op.accountLinkId, status: op.status, errorCode: op.errorCode,
    completedAt: op.completedAt?.toISOString() ?? null, before: op.beforeSnapshot, after: op.afterSnapshot }
}

/** Recover an accepted confirmation whose HTTP response was lost. Pure read:
 * null is only "not observed yet", never permission to release/retry as new. */
export async function resetIntentStatus(actor: AccountActor, intentId: string) {
  await assertActor(actor)
  const { instanceId } = await requireInstance()
  const intent = await prisma.trafficResetIntent.findFirst({ where: { id: intentId, userId: actor.userId,
    chatBindingId: actor.bindingId, instanceIdSnapshot: instanceId }, select: { id: true } })
  if (!intent) throw notFound()
  const op = await prisma.xboardTrafficResetOperation.findUnique({ where: { intentId }, select: { id: true } })
  const operation = op ? await resetStatus(actor, op.id) : null
  await assertActor(actor)
  return { intentId: intent.id, operation }
}
