import { callFakaV2Capabilities } from '../../lib/fakaBridge/accountV2.js'
import { callResetPreview } from '../../lib/fakaBridge/resetV2.js'
import { paidResetHistory } from './resetHistory.js'
import { benefitSummary } from '../trafficReset/benefits.js'
import { config } from '../../config/index.js'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { HttpError, notFound } from '../../lib/httpError.js'
import { requireInstance, unresolved } from './settings.js'
import { readSnapshot } from './bridgeQueries.js'

export type AccountActor = { userId: number; bindingId: number; platformId: string }
type DB = typeof prisma | Prisma.TransactionClient
export async function assertActor(actor: AccountActor, db: DB = prisma) {
  const binding = await db.chatBinding.findUnique({ where: { id: actor.bindingId },
    select: { userId: true, platform: true, platformId: true, user: { select: { status: true } } } })
  if (!binding || binding.platform !== 'qq' || binding.platformId !== actor.platformId || binding.userId !== actor.userId
    || binding.user.status !== '正常') throw new HttpError(409, 'XBOARD_BINDING_CHANGED', 'QQ 绑定或账号状态已变化，请重新查询')
}
function mask(email: string) {
  const at = email.lastIndexOf('@')
  return at > 0 ? `${email.slice(0, Math.min(2, at))}***@${email.slice(at + 1)}` : '***'
}
export async function ownedLink(actor: AccountActor, instanceId: string, id: string, db: DB = prisma) {
  const link = await db.xboardAccountLink.findFirst({ where: { id, userId: actor.userId, instanceId } })
  if (!link) throw notFound()
  if (link.status !== 'active') throw unresolved()
  return link
}

/** Compare semantic target after awaited work, not merely current ownership of its UUID. */
export async function assertSelectedAccount(actor: AccountActor, frozen: { id: string; instanceId: string; xboardUserId: string }) {
  await assertActor(actor)
  const { instanceId } = await requireInstance()
  const current = await ownedLink(actor, frozen.instanceId, frozen.id)
  if (instanceId !== frozen.instanceId || current.xboardUserId !== frozen.xboardUserId) {
    throw new HttpError(409, 'CHECKOUT_CHANGED', '套餐账号已变化，请重新查询')
  }
}

export async function listAccounts(actor: AccountActor) {
  await assertActor(actor)
  const { instanceId } = await requireInstance()
  const [links, preference] = await Promise.all([
    prisma.xboardAccountLink.findMany({ where: { userId: actor.userId, instanceId }, orderBy: [{ resolvedAt: 'desc' }, { id: 'asc' }], take: 101 }),
    prisma.xboardAccountPreference.findUnique({ where: { userId_instanceId: { userId: actor.userId, instanceId } } }),
  ])
  await assertActor(actor)
  const active = links.filter(link => link.status === 'active')
  const selected = active.find(link => link.id === preference?.defaultAccountLinkId)?.id
    ?? (active.length === 1 && links.length <= 100 ? active[0].id : null)
  return { accounts: links.slice(0, 100).map(link => ({ id: link.id, maskedEmail: mask(link.currentEmail),
    status: link.status, isDefault: link.id === selected })), defaultAccountLinkId: selected,
  truncated: links.length > 100, associationStatus: links.length ? 'available' : 'pending_sync' }
}

export async function selectedAccount(actor: AccountActor, accountLinkId?: string) {
  await assertActor(actor)
  const { instanceId } = await requireInstance()
  let selected = accountLinkId
  if (!selected) {
    const accounts = await listAccounts(actor)
    if (!accounts.accounts.length) throw unresolved()
    if (!accounts.defaultAccountLinkId) throw new HttpError(409, 'XBOARD_ACCOUNT_SELECTION_REQUIRED', '请先从本人账号列表中选择套餐账号')
    selected = accounts.defaultAccountLinkId
  }
  const link = await ownedLink(actor, instanceId, selected)
  return link
}

export async function profile(actor: AccountActor, accountLinkId?: string) {
  await assertActor(actor)
  const { instanceId, origin } = await requireInstance()
  const link = await selectedAccount(actor, accountLinkId)
  const selected = link.id
  const snapshot = await readSnapshot(instanceId, link.xboardUserId)
  // Shared cached work can finish after an unbind, ban or ownership conflict.
  if (snapshot.body && !snapshot.stale) await prisma.xboardAccountLink.updateMany({
    where: { id: selected, userId: actor.userId, status: 'active', instanceId, xboardUserId: link.xboardUserId },
    data: { currentEmail: snapshot.body.account.email, lastSyncedAt: new Date() },
  })
  await assertSelectedAccount(actor, link)
  const benefits = await benefitSummary(actor.userId, selected)
  const paid = await paidResetHistory(actor.userId, { ...link, origin })
  let canFreeReset = false, resetBlock: string | null = config.trafficReset.requestsEnabled ? 'RESET_INELIGIBLE' : 'RESET_FEATURE_NOT_ENABLED'
  if (config.trafficReset.requestsEnabled && (benefits.freeReset?.available ?? 0) > 0 && !snapshot.stale && !snapshot.unavailable) {
    const caps = await callFakaV2Capabilities()
    if (caps.ok && caps.body.capabilities.reset_idempotency && caps.body.capabilities.reset_status && caps.body.capabilities.cancel_tombstone) {
      const preview = await callResetPreview(link.xboardUserId)
      if (preview.ok) { canFreeReset = preview.body.preview.eligible; resetBlock = preview.body.preview.block_reason }
      else resetBlock = 'RESET_SERVICE_UNAVAILABLE'
    } else resetBlock = 'RESET_SERVICE_UNAVAILABLE'
  }
  await assertSelectedAccount(actor, link)
  const subscription = snapshot.body?.subscription
  return {
    account: { id: link.id, maskedEmail: mask(snapshot.body?.account.email ?? link.currentEmail) },
    subscription: subscription ? { status: subscription.status, planId: subscription.plan_id, planName: subscription.plan_name,
      totalBytes: subscription.total_bytes, uploadBytes: subscription.upload_bytes, downloadBytes: subscription.download_bytes,
      usedBytes: subscription.used_bytes, remainingBytes: subscription.remaining_bytes,
      expiresAtUnix: subscription.expires_at, nextResetAtUnix: subscription.next_reset_at } : null,
    freeReset: benefits.freeReset, canFreeReset, blockReason: resetBlock,
    resetHistory: { platformSuccessfulForAccount: benefits.successful + paid.successful, freeSuccessfulForAccount: benefits.successful,
      paidSuccessfulForAccount: paid.successful, coverageScope: 'verified_v2_only', truncated: paid.truncated,
      xboardAllSources: subscription?.reset_count ?? null, coverageFrom: [benefits.coverageFrom, paid.coverageFrom].filter((v): v is string => v !== null).sort()[0] ?? null },
    freshness: { queriedAt: snapshot.body?.queried_at ?? null, stale: snapshot.stale, unavailable: snapshot.unavailable },
  }
}

export async function selectDefault(actor: AccountActor, accountLinkId: string, requestId: string) {
  const { instanceId } = await requireInstance()
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actor.userId} FOR UPDATE`
    await tx.$queryRaw`SELECT "id" FROM "ChatBinding" WHERE "id" = ${actor.bindingId} FOR UPDATE`
    await assertActor(actor, tx)
    const existing = await tx.xboardAccountSelection.findUnique({ where: { userId_instanceId_requestId: { userId: actor.userId, instanceId, requestId } } })
    if (existing) {
      if (existing.accountLinkId !== accountLinkId || existing.chatBindingId !== actor.bindingId) {
        throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', '该请求编号已用于其他选择，请重新操作')
      }
      await ownedLink(actor, instanceId, existing.accountLinkId, tx)
      return { selectedAccountLinkId: existing.accountLinkId, appliedAt: existing.createdAt.toISOString(), replayed: true }
    }
    await ownedLink(actor, instanceId, accountLinkId, tx)
    await tx.xboardAccountPreference.upsert({ where: { userId_instanceId: { userId: actor.userId, instanceId } },
      create: { userId: actor.userId, instanceId, defaultAccountLinkId: accountLinkId }, update: { defaultAccountLinkId: accountLinkId } })
    const command = await tx.xboardAccountSelection.create({ data: { userId: actor.userId, instanceId, requestId, accountLinkId, chatBindingId: actor.bindingId } })
    return { selectedAccountLinkId: accountLinkId, appliedAt: command.createdAt.toISOString(), replayed: false }
  })
}
