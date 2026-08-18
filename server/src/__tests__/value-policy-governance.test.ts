import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  approveValuePolicy,
  createDraftValuePolicy,
  isPrismaClient,
  lockValuePolicyGovernance,
  withGovernanceTransaction,
} from '../modules/valuePolicy/governance.js'
import { createTestValuePolicyActors, TEST_VALUE_POLICY_EVIDENCE } from './helpers.js'

const past = new Date('2020-01-01T00:00:00.000Z')

describe('ValuePolicy governance transactions', () => {
  it('treats the exported prisma singleton as a PrismaClient', () => {
    expect(isPrismaClient(prisma)).toBe(true)
  })

  it('PrismaClient entry points wrap lock/read/update in one $transaction', async () => {
    const { creator, approver } = await createTestValuePolicyActors()
    const draft = await createDraftValuePolicy(prisma, {
      id: 'vp_gov_wrap',
      version: 16001,
      effectiveAt: past,
      createdAt: past,
      createdByUserId: creator.id,
      ...TEST_VALUE_POLICY_EVIDENCE,
    })

    const original = prisma.$transaction.bind(prisma)
    let wrapped = false
    prisma.$transaction = ((fn: Parameters<typeof prisma.$transaction>[0], options?: Parameters<typeof prisma.$transaction>[1]) => {
      wrapped = true
      return original(fn as never, options)
    }) as typeof prisma.$transaction
    try {
      const approved = await approveValuePolicy(prisma, draft.id, approver.id, past)
      expect(wrapped).toBe(true)
      expect(approved.status).toBe('approved')
    } finally {
      prisma.$transaction = original
    }
  })

  it('keeps the advisory lock on the same txid across lock, read, and update', async () => {
    const { creator, approver } = await createTestValuePolicyActors()
    const draft = await createDraftValuePolicy(prisma, {
      id: 'vp_gov_txid',
      version: 16002,
      effectiveAt: past,
      createdAt: past,
      createdByUserId: creator.id,
      ...TEST_VALUE_POLICY_EVIDENCE,
    })

    await withGovernanceTransaction(prisma, async tx => {
      expect(isPrismaClient(tx)).toBe(false)
      const [{ txid: before }] = await tx.$queryRaw<Array<{ txid: bigint }>>`SELECT txid_current() AS txid`
      await lockValuePolicyGovernance(tx)
      const held = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::bigint AS n
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND classid = 88170001
          AND objid = 1
          AND granted`
      expect(Number(held[0]!.n)).toBeGreaterThan(0)
      const [{ txid: mid }] = await tx.$queryRaw<Array<{ txid: bigint }>>`SELECT txid_current() AS txid`
      const approved = await approveValuePolicy(tx, draft.id, approver.id, past)
      expect(approved.status).toBe('approved')
      const [{ txid: after }] = await tx.$queryRaw<Array<{ txid: bigint }>>`SELECT txid_current() AS txid`
      expect(mid).toBe(before)
      expect(after).toBe(before)
    })
  })
})
