import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import * as bridge from '../../lib/fakaBridge/accountV2.js'
import { accountSettings, unavailable } from './settings.js'
import { ownershipProof, readRecoverySource, sourceBlockReason } from './evidence.js'
import { requireReadCapabilities } from './bridgeQueries.js'

export type RecoveryResult = 'linked' | 'existing' | 'conflict' | 'untrusted_source' | 'source_incomplete' | 'delivery_untrusted' | 'user_unavailable' | 'ownership_proof_missing' | 'remote_unresolved' | 'remote_unavailable'

export type PreviewOwnership = Map<string, { userId: number; blocked: boolean }>

export async function recoverAccount(taskId: number, apply = false, previewOwners?: PreviewOwnership): Promise<RecoveryResult> {
  const settings = accountSettings(), source = await readRecoverySource(taskId)
  const instance = await prisma.xboardInstance.findUnique({ where: { id: settings.instanceId } })
  if (instance && instance.origin !== settings.origin) throw unavailable()
  const blocked = sourceBlockReason(source)
  if (blocked) return blocked
  if (!source || !await ownershipProof(source)) return 'ownership_proof_missing'
  const known = await prisma.xboardAccountEvidence.findUnique({ where: { sourceOrderId: source.order.id }, include: { accountLink: true } })
  if (known) return known.accountLink.instanceId === settings.instanceId && known.accountLink.userId === source.order.userId
    && known.accountLink.status === 'active' ? 'existing' : 'conflict'
  await requireReadCapabilities(settings.instanceId)
  const resolved = await bridge.callFakaV2ResolveAccount(source.requestOrderNo)
  if (!resolved.ok) return resolved.remoteCode === 'ACCOUNT_UNRESOLVED' ? 'remote_unresolved' : 'remote_unavailable'
  // Bind to the original trade too: an order number alone must not retarget a
  // historical task to a different remote transaction.
  if (resolved.body.trade_no !== source.xboardTradeNo) return 'remote_unresolved'
  const remote = resolved.body.account
  if (!apply) {
    const current = await prisma.xboardAccountLink.findUnique({ where: { instanceId_xboardUserId: { instanceId: settings.instanceId, xboardUserId: remote.user_id } } })
    const key = `${settings.instanceId}:${remote.user_id}`
    const projected = previewOwners?.get(key) ?? (current ? { userId: current.userId, blocked: current.status !== 'active' }
      : { userId: source.order.userId, blocked: false })
    if (projected.userId !== source.order.userId) projected.blocked = true
    previewOwners?.set(key, projected)
    return projected.blocked ? 'conflict' : 'linked'
  }
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${source.order.userId} FOR UPDATE`
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`xboard:${settings.instanceId}:${remote.user_id}`}, 0))::text`
    const fresh = await readRecoverySource(taskId, tx), proof = fresh && await ownershipProof(fresh, tx)
    if (!fresh || !proof || fresh.requestOrderNo !== source.requestOrderNo || fresh.xboardTradeNo !== source.xboardTradeNo
      || fresh.emailSnapshot !== source.emailSnapshot || fresh.order.userId !== source.order.userId) return 'untrusted_source'
    await tx.$executeRaw`INSERT INTO "XboardInstance" ("id", "origin") VALUES (${settings.instanceId}, ${settings.origin}) ON CONFLICT ("id") DO NOTHING`
    const instance = await tx.xboardInstance.findUniqueOrThrow({ where: { id: settings.instanceId } })
    if (instance.origin !== settings.origin) throw unavailable()
    const evidence = await tx.xboardAccountEvidence.findUnique({ where: { sourceOrderId: fresh.order.id }, include: { accountLink: true } })
    if (evidence) return evidence.accountLink.userId === fresh.order.userId && evidence.accountLink.instanceId === settings.instanceId
      && evidence.accountLink.status === 'active' ? 'existing' : 'conflict'
    let link = await tx.xboardAccountLink.findUnique({ where: { instanceId_xboardUserId: { instanceId: settings.instanceId, xboardUserId: remote.user_id } } })
    if (!link) link = await tx.xboardAccountLink.create({ data: {
      id: randomUUID(), userId: fresh.order.userId, instanceId: settings.instanceId, xboardUserId: remote.user_id,
      currentEmail: remote.email, emailSnapshot: proof.email, sourceOrderId: fresh.order.id, sourceExternalOrderNo: fresh.requestOrderNo,
    } })
    const conflict = link.userId !== fresh.order.userId || link.status !== 'active'
    if (link.userId !== fresh.order.userId) await tx.xboardAccountLink.update({ where: { id: link.id }, data: { status: 'blocked', blockReason: 'ownership_conflict' } })
    await tx.xboardAccountEvidence.create({ data: { accountLinkId: link.id, userId: fresh.order.userId,
      sourceOrderId: fresh.order.id, externalOrderNo: fresh.requestOrderNo, emailSnapshot: proof.email,
      proofKind: proof.kind, proofVerifiedAt: proof.verifiedAt } })
    return conflict ? 'conflict' : 'linked'
  })
}
