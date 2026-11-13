import type { Prisma, Merchant } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { forbidden, notFound, badRequest } from '../../lib/httpError.js'
import {
  lockUserRefreshSessionMutations,
  revokeAllUserRefreshTokens,
} from '../auth/sessionService.js'
import { isAccountBanned } from '../accountGovernance/status.js'
import { assertPermission } from '../adminAuthorization/service.js'
import { governanceConflict, requestHash, writeGovernanceAudit } from '../governance/common.js'

export function merchantCapabilities(status: string | null, banned = false) {
  if (banned || !status) return [] as string[]
  if (status === 'active')
    return [
      'application.read',
      'history.read',
      'catalog.write',
      'inventory.write',
      'orders.accept',
      'orders.existing.write',
      'marketing.write',
    ]
  if (status === 'suspended') return ['application.read', 'history.read', 'orders.existing.write']
  return status === 'rejected'
    ? ['application.read', 'application.resubmit', 'history.read']
    : ['application.read', 'history.read']
}
export async function merchantContext(userId: number, db: Prisma.TransactionClient = prisma) {
  const m = await db.merchant.findUnique({
    where: { userId },
    select: { status: true, lifecycleVersion: true },
  })
  return {
    merchantStatus: m?.status ?? null,
    merchantLifecycleVersion: m?.lifecycleVersion ?? null,
    merchantCapabilities: merchantCapabilities(
      m?.status ?? null,
      await isAccountBanned(userId, db),
    ),
  }
}
export async function merchantApplication(
  userId: number,
  db: Prisma.TransactionClient = prisma,
  admin = false,
) {
  const merchant = await db.merchant.findUnique({
    where: { userId },
    include: {
      applications: { orderBy: { version: 'desc' }, take: 1 },
      lifecycleEvents: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  })
  const banned = await isAccountBanned(userId, db)
  const m = merchant
  return {
    merchantId: m?.id ?? null,
    status: m?.status ?? null,
    lifecycleVersion: m?.lifecycleVersion ?? 0,
    applicationVersion: m?.currentApplicationVersion ?? 0,
    currentApplication: m?.applications[0] ?? null,
    history: m?.lifecycleEvents.map(({ requestKey, requestHash, evidenceRef, ...e }) => e) ?? [],
    merchantCapabilities: merchantCapabilities(m?.status ?? null, banned),
    allowedActions: banned
      ? []
      : admin
        ? m?.status === 'pending'
          ? ['approve', 'reject']
          : m?.status === 'active'
            ? ['suspend']
            : m?.status === 'suspended'
              ? ['restore']
              : []
        : !m
          ? ['submit']
          : m.status === 'rejected'
            ? ['resubmit']
            : [],
    blockers: banned ? [{ code: 'ACCOUNT_BANNED', message: '账号被封禁' }] : [],
  }
}
async function adminApplication(
  userId: number,
  db: Prisma.TransactionClient,
  permissions: string[],
) {
  const application = await merchantApplication(userId, db, true)
  return {
    ...application,
    allowedActions: application.allowedActions.filter((action) =>
      permissions.includes(
        ['suspend', 'restore'].includes(action) ? 'merchants.suspend' : 'merchants.review',
      ),
    ),
  }
}
async function baseline(tx: Prisma.TransactionClient, m: Merchant) {
  if (m.currentApplicationVersion > 0) return m
  await tx.merchantApplicationRevision.create({
    data: {
      merchantId: m.id,
      version: 1,
      name: m.name,
      description: m.description ?? '',
      contactEmail: m.contactEmail ?? '',
      contactPhone: m.contactPhone ?? '',
      isLegacyBaseline: true,
      submittedAt: new Date(),
    },
  })
  return tx.merchant.update({ where: { id: m.id }, data: { currentApplicationVersion: 1 } })
}
export async function submitMerchantApplication(
  userId: number,
  data: { name: string; description?: string; contactEmail?: string; contactPhone?: string },
  key: string,
  expectedLifecycleVersion?: number,
) {
  return prisma.$transaction(async (tx) => {
    await lockUserRefreshSessionMutations(tx, userId)
    const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true } })
    if (!user || user.role === 'admin' || (await isAccountBanned(userId, tx)))
      throw forbidden('当前账号不能申请商家')
    let m = await tx.merchant.findUnique({ where: { userId } })
    if (m) await tx.$queryRaw`SELECT id FROM "Merchant" WHERE id=${m.id} FOR UPDATE`
    const hash = requestHash({ userId, data, expectedLifecycleVersion })
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`merchant-event:${key}`}, 0))`
    const prior = await tx.merchantLifecycleEvent.findUnique({ where: { requestKey: key } })
    if (prior) {
      if (prior.requestHash !== hash)
        throw governanceConflict('IDEMPOTENCY_KEY_REUSED', '幂等键已经使用')
      return merchantApplication(userId, tx)
    }
    if (
      m &&
      (m.status !== 'rejected' ||
        expectedLifecycleVersion === undefined ||
        m.lifecycleVersion !== expectedLifecycleVersion)
    )
      throw governanceConflict('STATE_CONFLICT', '申请状态或版本已经变化')
    if (!m && expectedLifecycleVersion !== undefined) throw notFound('尚无可重新提交的申请')
    const fromStatus = m?.status ?? null
    if (m) m = await baseline(tx, m)
    m = m
      ? await tx.merchant.update({
          where: { id: m.id, lifecycleVersion: expectedLifecycleVersion },
          data: {
            ...data,
            status: 'pending',
            lifecycleVersion: { increment: 1 },
            currentApplicationVersion: { increment: 1 },
          },
        })
      : await tx.merchant.create({ data: { userId, ...data, currentApplicationVersion: 1 } })
    const application = await tx.merchantApplicationRevision.create({
      data: {
        merchantId: m.id,
        version: m.currentApplicationVersion,
        name: m.name,
        description: m.description ?? '',
        contactEmail: m.contactEmail ?? '',
        contactPhone: m.contactPhone ?? '',
        submittedByUserId: userId,
      },
    })
    await tx.merchantLifecycleEvent.create({
      data: {
        merchantId: m.id,
        applicationRevisionId: application.id,
        action: fromStatus ? 'resubmit' : 'submit',
        fromStatus,
        toStatus: 'pending',
        reasonCode: fromStatus ? 'resubmitted' : 'submitted',
        note: '',
        actorUserId: userId,
        requestKey: key,
        requestHash: hash,
        versionAfter: m.lifecycleVersion,
      },
    })
    return merchantApplication(userId, tx)
  })
}
export type MerchantDecision = {
  expectedLifecycleVersion?: number
  applicationVersion?: number
  reasonCode: string
  note: string
  evidenceRef?: string | null
}
export async function decideMerchant(
  actor: number,
  id: number,
  action: 'approve' | 'reject' | 'suspend' | 'restore',
  input: MerchantDecision,
  key?: string,
) {
  return prisma.$transaction(async (tx) => {
    const auth = await assertPermission(
      actor,
      ['suspend', 'restore'].includes(action) ? 'merchants.suspend' : 'merchants.review',
      tx,
    )
    const pointer = await tx.merchant.findUnique({ where: { id }, select: { userId: true } })
    if (!pointer) throw notFound('商家不存在')
    await lockUserRefreshSessionMutations(tx, pointer.userId)
    await tx.$queryRaw`SELECT id FROM "Merchant" WHERE id=${id} FOR UPDATE`
    let m = await tx.merchant.findUniqueOrThrow({ where: { id } })
    const hash = requestHash({ actor, id, action, input })
    const actualKey = key ?? `legacy-merchant:${actor}:${id}:${action}:${m.lifecycleVersion}`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`merchant-event:${actualKey}`}, 0))`
    const prior = await tx.merchantLifecycleEvent.findUnique({ where: { requestKey: actualKey } })
    if (prior) {
      if (prior.requestHash !== hash)
        throw governanceConflict('IDEMPOTENCY_KEY_REUSED', '幂等键已经使用')
      return adminApplication(pointer.userId, tx, auth.permissions)
    }
    if (
      input.expectedLifecycleVersion !== undefined &&
      m.lifecycleVersion !== input.expectedLifecycleVersion
    )
      throw governanceConflict('STATE_CONFLICT', '商家生命周期版本已经变化')
    m = await baseline(tx, m)
    const expectedFrom = {
      approve: 'pending',
      reject: 'pending',
      suspend: 'active',
      restore: 'suspended',
    }[action]
    if (m.status !== expectedFrom) throw governanceConflict('STATE_CONFLICT', '商家状态已经变化')
    if (
      ['approve', 'reject'].includes(action) &&
      input.applicationVersion !== undefined &&
      input.applicationVersion !== m.currentApplicationVersion
    )
      throw governanceConflict('APPLICATION_VERSION_CHANGED', '申请资料已经变化')
    const user = await tx.user.findUniqueOrThrow({
      where: { id: m.userId },
      select: { role: true },
    })
    if (user.role === 'admin') throw badRequest('不能通过商家审核改写管理员身份')
    if (['approve', 'restore'].includes(action) && (await isAccountBanned(m.userId, tx)))
      throw forbidden('封禁账号不能激活商家')
    const nextStatus = {
      approve: 'active',
      reject: 'rejected',
      suspend: 'suspended',
      restore: 'active',
    }[action]
    const updated = await tx.merchant.update({
      where: { id, status: expectedFrom, lifecycleVersion: m.lifecycleVersion },
      data: {
        status: nextStatus,
        lifecycleVersion: { increment: 1 },
        ...(['approve', 'restore'].includes(action)
          ? { approvedAt: new Date(), approvedBy: actor }
          : {}),
      },
    })
    if (['approve', 'restore'].includes(action))
      await tx.user.update({ where: { id: m.userId }, data: { role: 'merchant' } })
    if (action !== 'reject') await revokeAllUserRefreshTokens(m.userId, tx)
    const application = ['approve', 'reject'].includes(action)
      ? await tx.merchantApplicationRevision.findUniqueOrThrow({
          where: { merchantId_version: { merchantId: id, version: m.currentApplicationVersion } },
        })
      : null
    await tx.merchantLifecycleEvent.create({
      data: {
        merchantId: id,
        applicationRevisionId: application?.id,
        action,
        fromStatus: expectedFrom,
        toStatus: nextStatus,
        reasonCode: input.reasonCode,
        note: input.note,
        evidenceRef: input.evidenceRef,
        actorUserId: actor,
        requestKey: actualKey,
        requestHash: hash,
        versionAfter: updated.lifecycleVersion,
      },
    })
    await writeGovernanceAudit(tx, actor, `merchant.${action}`, 'merchant', id, {
      reasonCode: input.reasonCode,
      note: input.note,
      fromStatus: expectedFrom,
      toStatus: nextStatus,
      versionAfter: updated.lifecycleVersion,
    })
    return adminApplication(m.userId, tx, auth.permissions)
  })
}
