import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { config } from '../config/index.js'
import * as bridge from '../lib/fakaBridge/accountV2.js'
import { recoverAccount } from '../modules/xboardAccounts/recovery.js'
import { runAccountBackfill } from '../modules/xboardAccounts/backfill.js'
import { enableAccountTests, purchase, instanceId } from './xboardAccountFixture.js'

let restore: () => void
beforeEach(() => { restore = enableAccountTests() })
afterEach(() => restore())

describe('Xboard historical association with real PostgreSQL', () => {
  it('uses checkout ownership proof for a different email and dry-run writes nothing', async () => {
    const p = await purchase()
    expect(p.user.email).not.toBe(p.email)
    expect(await recoverAccount(p.task.id)).toBe('linked')
    expect(await prisma.xboardInstance.count()).toBe(0)
    expect(await prisma.xboardAccountLink.count()).toBe(0)
    expect(await recoverAccount(p.task.id, true)).toBe('linked')
    const link = await prisma.xboardAccountLink.findFirstOrThrow()
    expect(link).toMatchObject({ userId: p.user.id, xboardUserId: '42', currentEmail: 'changed@example.com', emailSnapshot: p.email })
    expect(await recoverAccount(p.task.id, true)).toBe('existing')
    expect(await prisma.xboardAccountEvidence.count()).toBe(1)
  })

  it.each(['after_checkout', 'expired_at_checkout', 'missing'] as const)('rejects %s ownership proof before remote resolution', async kind => {
    const p = await purchase()
    const where = { userId_email: { userId: p.user.id, email: p.email } }
    if (kind === 'missing') await prisma.fakaProvisionEmailProof.delete({ where })
    else await prisma.fakaProvisionEmailProof.update({ where, data: kind === 'after_checkout'
      ? { verifiedAt: new Date('2026-03-01') } : { proofExpiresAt: new Date('2026-02-01') } })
    expect(await recoverAccount(p.task.id, true)).toBe('ownership_proof_missing')
    expect(bridge.callFakaV2ResolveAccount).not.toHaveBeenCalled()
    expect(await prisma.xboardAccountLink.count()).toBe(0)
  })

  it('accepts proof expired now but valid at checkout and retains refunded historical identity', async () => {
    const p = await purchase()
    await prisma.fakaProvisionEmailProof.update({ where: { userId_email: { userId: p.user.id, email: p.email } }, data: { proofExpiresAt: new Date('2026-02-10') } })
    await prisma.order.update({ where: { id: p.order.id }, data: { status: 'refunded' } })
    expect(await recoverAccount(p.task.id, true)).toBe('linked')
    expect(await prisma.xboardAccountEvidence.count()).toBe(1)
  })

  it.each(['pending', 'failed', 'cancelled'])('does not recover %s tasks', async status => {
    const p = await purchase()
    await prisma.fakaBridgeTask.update({ where: { id: p.task.id }, data: { status } })
    expect(await recoverAccount(p.task.id, true)).toBe('source_incomplete')
    expect(bridge.callFakaV2ResolveAccount).not.toHaveBeenCalled()
  })

  it('rejects absent delivery and remote transaction retargeting', async () => {
    const p = await purchase()
    await prisma.deliveryRecord.delete({ where: { orderId: p.order.id } })
    expect(await recoverAccount(p.task.id, true)).toBe('delivery_untrusted')
    await prisma.deliveryRecord.create({ data: { orderId: p.order.id, userId: p.user.id, productId: p.product.id, deliveredAt: new Date() } })
    await prisma.fakaBridgeTask.update({ where: { id: p.task.id }, data: { xboardTradeNo: 'OTHER-TRADE' } })
    expect(await recoverAccount(p.task.id, true)).toBe('remote_unresolved')
    expect(await prisma.xboardAccountEvidence.count()).toBe(0)
  })

  it('deduplicates concurrent same-owner orders without losing source evidence', async () => {
    const a = await purchase(), b = await purchase(a.user.id)
    expect(await Promise.all([recoverAccount(a.task.id, true), recoverAccount(b.task.id, true), recoverAccount(a.task.id, true)]))
      .toEqual(expect.arrayContaining(['linked', 'existing']))
    expect(await prisma.xboardAccountLink.count()).toBe(1)
    expect(await prisma.xboardAccountEvidence.count()).toBe(2)
  })

  it('blocks concurrent cross-owner claims without reassigning either account', async () => {
    const a = await purchase(), b = await purchase()
    expect((await Promise.all([recoverAccount(a.task.id, true), recoverAccount(b.task.id, true)])).sort()).toEqual(['conflict', 'linked'])
    const link = await prisma.xboardAccountLink.findFirstOrThrow()
    expect([a.user.id, b.user.id]).toContain(link.userId)
    expect(link.status).toBe('blocked')
    expect(await prisma.xboardAccountEvidence.count()).toBe(2)
    expect(await recoverAccount(a.task.id, true)).toBe('conflict')
    expect((await prisma.xboardAccountLink.findFirstOrThrow()).userId).toBe(link.userId)
  })

  it('pins the instance origin and refuses retargeting', async () => {
    const p = await purchase()
    await recoverAccount(p.task.id, true)
    config.fakaBridge.url = 'https://other.test/plugin/faka-bridge/order-paid'
    await expect(recoverAccount(p.task.id, true)).rejects.toMatchObject({ status: 503 })
    expect((await prisma.xboardInstance.findUniqueOrThrow({ where: { id: instanceId } })).origin).toBe('https://xboard.test')
  })

  it('persists only safe progress, retries outage, resumes and cycles for late-success tasks', async () => {
    const a = await purchase(), b = await purchase(a.user.id)
    const resolve = vi.mocked(bridge.callFakaV2ResolveAccount), normal = resolve.getMockImplementation()!
    resolve.mockImplementation(async no => no === b.task.requestOrderNo ? { ok: false, code: 'NETWORK', httpStatus: 0 } : normal(no))
    const preview = await runAccountBackfill()
    expect(preview).toMatchObject({ previewNext: { userId: a.user.id, taskId: a.task.id }, counts: { linked: 1, remote_unavailable: 1 } })
    expect(await prisma.xboardAccountLink.count()).toBe(0)
    expect(await runAccountBackfill({ apply: true })).toMatchObject({ checkpoint: { cursorUserId: a.user.id, cursorTaskId: a.task.id } })
    resolve.mockImplementation(normal)
    expect(await runAccountBackfill({ apply: true })).toMatchObject({ counts: { linked: 1 }, checkpoint: { cursorTaskId: b.task.id } })
    expect(await runAccountBackfill({ apply: true })).toMatchObject({ scanned: 0, checkpoint: { cursorUserId: 0, cursorTaskId: 0, cycle: 1 } })
    expect(await runAccountBackfill({ apply: true })).toMatchObject({ counts: { existing: 2 } })
    await expect(runAccountBackfill({ apply: true, afterTaskId: 0 })).rejects.toThrow('checkpoint')
  })
  it('detects conflicting claimants within a dry-run batch without writing ownership', async () => {
    await purchase()
    await purchase()
    expect(await runAccountBackfill()).toMatchObject({ counts: { linked: 1, conflict: 1 } })
    expect(await prisma.xboardAccountLink.count()).toBe(0)
    expect(await prisma.xboardAccountEvidence.count()).toBe(0)
    expect(await prisma.xboardAccountBackfillState.count()).toBe(0)
  })

  it('accepts already verified site email without a separate proof, and rejects unavailable users', async () => {
    const p = await purchase()
    await prisma.user.update({ where: { id: p.user.id }, data: { email: p.email } })
    await prisma.fakaProvisionEmailProof.deleteMany()
    expect(await recoverAccount(p.task.id, true)).toBe('linked')
    await prisma.user.update({ where: { id: p.user.id }, data: { status: '封禁' } })
    expect(await recoverAccount(p.task.id, true)).toBe('user_unavailable')
  })

  it('rechecks changed delivery ownership after remote work before persisting a link', async () => {
    const p = await purchase(), other = await purchase()
    const resolve = vi.mocked(bridge.callFakaV2ResolveAccount), original = resolve.getMockImplementation()!
    resolve.mockImplementation(async no => {
      await prisma.deliveryRecord.update({ where: { orderId: p.order.id }, data: { userId: other.user.id } })
      return original(no)
    })
    expect(await recoverAccount(p.task.id, true)).toBe('untrusted_source')
    expect(await prisma.xboardAccountLink.count()).toBe(0)
    expect(await runAccountBackfill()).toMatchObject({ anomalies: [{ taskId: p.task.id, reason: 'delivery_untrusted' }] })
  })

})
