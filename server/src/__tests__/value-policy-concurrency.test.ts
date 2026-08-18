import { afterEach, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { prisma } from '../lib/prisma.js'
import {
  activateValuePolicy,
  provisionValuePolicy,
} from '../modules/valuePolicy/governance.js'
import { createTestValuePolicyActors, TEST_VALUE_POLICY_EVIDENCE } from './helpers.js'

const ROUNDS = 12
const past = new Date('2020-01-01T00:00:00.000Z')
const TX = { timeout: 8000, maxWait: 3000 } as const

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.message} ${JSON.stringify(err)}` : String(err)
}

function isDeadlock(err: unknown): boolean {
  const text = errorText(err)
  return text.includes('40P01') || /deadlock detected/i.test(text)
}

function isLockTimeout(err: unknown): boolean {
  const text = errorText(err)
  return text.includes('55P03') || /lock timeout|canceling statement due to lock timeout/i.test(text)
}

function isBusinessRejection(err: unknown): boolean {
  const text = errorText(err)
  return /value_policy_active_asset_must_be_enabled|asset_definition_in_use_by_active_policy|effective_at_not_reached|asset_definition_identity_immutable|value_policy_insert_must_be_draft|23514/.test(text)
}

async function resetAssetsAndPolicies() {
  await prisma.valuePolicy.deleteMany()
  await prisma.assetDefinition.update({
    where: { code: 'CNY' },
    data: { enabled: true, retiredAt: null },
  })
  await prisma.assetDefinition.update({
    where: { code: 'RP' },
    data: { enabled: true, retiredAt: null },
  })
}

async function seedScheduled(id: string, version: number, creatorId: number, approverId: number) {
  return provisionValuePolicy(prisma, {
    id,
    version,
    effectiveAt: past,
    createdAt: past,
    status: 'scheduled',
    createdByUserId: creatorId,
    approvedByUserId: approverId,
    ...TEST_VALUE_POLICY_EVIDENCE,
  })
}

async function assertInvariant() {
  const active = await prisma.valuePolicy.findMany({
    where: { status: 'active' },
    include: { pointAsset: true, referenceAsset: true },
  })
  expect(active.length).toBeLessThanOrEqual(1)
  for (const policy of active) {
    expect(policy.pointAsset.enabled).toBe(true)
    expect(policy.referenceAsset.enabled).toBe(true)
    expect(policy.pointAsset.retiredAt).toBeNull()
    expect(policy.referenceAsset.retiredAt).toBeNull()
  }
}

afterEach(async () => {
  await prisma.assetDefinition.updateMany({
    where: { code: { in: ['RP', 'CNY'] } },
    data: { enabled: true, retiredAt: null },
  }).catch(() => {})
})

describe('ValuePolicy / AssetDefinition concurrency', () => {
  it(`scheduled → active vs CNY enabled=false has no deadlock over ${ROUNDS} rounds`, async () => {
    const { creator, approver } = await createTestValuePolicyActors()
    for (let round = 0; round < ROUNDS; round += 1) {
      await resetAssetsAndPolicies()
      await seedScheduled(`vp_race_cny_${round}`, 12000 + round, creator.id, approver.id)

      const results = await Promise.allSettled([
        prisma.$transaction(async tx => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`
          await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`
          return activateValuePolicy(tx, `vp_race_cny_${round}`, approver.id)
        }, TX),
        prisma.$transaction(async tx => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`
          await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`
          return tx.assetDefinition.update({
            where: { code: 'CNY' },
            data: { enabled: false },
          })
        }, TX),
      ])

      expect(results.some(isDeadlockResult), `deadlock round ${round}`).toBe(false)
      const fulfilled = results.filter(result => result.status === 'fulfilled')
      const rejected = results.filter(result => result.status === 'rejected')
      expect(fulfilled.length, `round ${round} successes`).toBe(1)
      expect(rejected.length, `round ${round} rejections`).toBe(1)
      if (rejected[0]?.status === 'rejected') {
        expect(isBusinessRejection(rejected[0].reason), `round ${round} ${String(rejected[0].reason)}`).toBe(true)
      }
      await assertInvariant()
    }
  })

  it(`scheduled → active vs RP retiredAt has no deadlock over ${ROUNDS} rounds`, async () => {
    const { creator, approver } = await createTestValuePolicyActors()
    for (let round = 0; round < ROUNDS; round += 1) {
      await resetAssetsAndPolicies()
      await seedScheduled(`vp_race_rp_${round}`, 13000 + round, creator.id, approver.id)

      const results = await Promise.allSettled([
        prisma.$transaction(async tx => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`
          await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`
          return activateValuePolicy(tx, `vp_race_rp_${round}`, approver.id)
        }, TX),
        prisma.$transaction(async tx => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`
          await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`
          return tx.assetDefinition.update({
            where: { code: 'RP' },
            data: { retiredAt: new Date() },
          })
        }, TX),
      ])

      expect(results.some(isDeadlockResult), `deadlock round ${round}`).toBe(false)
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
      await assertInvariant()
    }
  })

  it('raw SQL activate vs disable has exactly one winner and no 40P01/lock timeout', async () => {
    const { creator, approver } = await createTestValuePolicyActors()
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is required')

    for (let round = 0; round < ROUNDS; round += 1) {
      await resetAssetsAndPolicies()
      await seedScheduled(`vp_raw_${round}`, 14000 + round, creator.id, approver.id)

      const a = new Client({ connectionString: url })
      const b = new Client({ connectionString: url })
      await a.connect()
      await b.connect()
      try {
        await a.query("SET lock_timeout = '2s'")
        await a.query("SET statement_timeout = '5s'")
        await b.query("SET lock_timeout = '2s'")
        await b.query("SET statement_timeout = '5s'")

        const raced = await Promise.allSettled([
          runAutocommitTx(a, () => a.query(
            `UPDATE "ValuePolicy" SET status = 'active', "activatedAt" = NOW(), "activatedByUserId" = $2 WHERE id = $1`,
            [`vp_raw_${round}`, approver.id],
          )),
          runAutocommitTx(b, () => b.query(`UPDATE "AssetDefinition" SET enabled = false WHERE code = 'CNY'`)),
        ])
        expect(raced.some(isDeadlockResult), `raw deadlock begin round ${round}`).toBe(false)
        expect(raced.some(result => result.status === 'rejected' && isLockTimeout(result.reason)), `raw lock timeout round ${round}`).toBe(false)
        expect(raced.filter(result => result.status === 'fulfilled'), `round ${round} successes`).toHaveLength(1)
        const rejected = raced.filter(result => result.status === 'rejected')
        expect(rejected, `round ${round} rejections`).toHaveLength(1)
        expect(isBusinessRejection(rejected[0]!.reason), `round ${round} ${errorText(rejected[0]!.reason)}`).toBe(true)

        await assertInvariant()
        const policy = await prisma.valuePolicy.findUniqueOrThrow({ where: { id: `vp_raw_${round}` } })
        const cny = await prisma.assetDefinition.findUniqueOrThrow({ where: { code: 'CNY' } })
        expect(policy.status === 'active').not.toBe(cny.enabled === false)
        if (policy.status === 'active') {
          expect(cny.enabled).toBe(true)
          expect(cny.retiredAt).toBeNull()
        } else {
          expect(policy.status).toBe('scheduled')
          expect(cny.enabled).toBe(false)
        }
      } finally {
        await a.end()
        await b.end()
      }
    }
  })

  it(`policy INSERT vs AssetDefinition identity update has one winner over ${ROUNDS} rounds`, async () => {
    const { creator, approver } = await createTestValuePolicyActors()
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is required')

    for (let round = 0; round < ROUNDS; round += 1) {
      await resetAssetsAndPolicies()
      const assetCode = `RP_LOCK_${round}`
      await prisma.assetDefinition.upsert({
        where: { code: assetCode },
        update: { enabled: true, retiredAt: null, kind: 'reward_point', scale: 0 },
        create: { code: assetCode, kind: 'reward_point', scale: 0, enabled: true },
      })
      await provisionValuePolicy(prisma, {
        id: `vp_share_${round}`,
        version: 17000 + round,
        pointAssetCode: assetCode,
        effectiveAt: past,
        createdAt: past,
        status: 'draft',
        createdByUserId: creator.id,
        approvedByUserId: approver.id,
        ...TEST_VALUE_POLICY_EVIDENCE,
      })

      const a = new Client({ connectionString: url })
      const b = new Client({ connectionString: url })
      await a.connect()
      await b.connect()
      try {
        await a.query("SET lock_timeout = '2s'")
        await a.query("SET statement_timeout = '5s'")
        await b.query("SET lock_timeout = '2s'")
        await b.query("SET statement_timeout = '5s'")

        const raced = await Promise.allSettled([
          runAutocommitTx(a, () => a.query(
            `INSERT INTO "ValuePolicy" (
              id, version, "pointAssetCode", "referenceAssetCode",
              "referenceAtomicPerPointNumerator", "referenceAtomicPerPointDenominator",
              "roundingMode", status, "effectiveAt", "createdAt", "createdByUserId",
              "d02DecisionRecordRef", "d02DecisionRecordSha256",
              "d03DecisionRecordRef", "d03DecisionRecordSha256", "disclosureVersion"
            ) VALUES ($1, $2, $3, 'CNY', 1, 1, 'HALF_EVEN', 'draft', $4, $4, $5,
              'test-fixture/d02', repeat('a', 64), 'test-fixture/d03', repeat('b', 64), 'test-v1')`,
            [`vp_share_ins_${round}`, 18000 + round, assetCode, past, creator.id],
          )),
          runAutocommitTx(b, () => b.query(
            `UPDATE "AssetDefinition" SET scale = 1 WHERE code = $1`,
            [assetCode],
          )),
        ])

        expect(raced.some(isDeadlockResult), `identity deadlock round ${round}`).toBe(false)
        expect(raced.some(result => result.status === 'rejected' && isLockTimeout(result.reason)), `identity lock timeout round ${round}`).toBe(false)
        expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        const rejected = raced.filter(result => result.status === 'rejected')
        expect(rejected).toHaveLength(1)
        expect(isBusinessRejection(rejected[0]!.reason), errorText(rejected[0]!.reason)).toBe(true)

        const asset = await prisma.assetDefinition.findUniqueOrThrow({ where: { code: assetCode } })
        const policies = await prisma.valuePolicy.findMany({
          where: { pointAssetCode: assetCode },
        })
        if (policies.length > 0) {
          expect(asset.scale).toBe(0)
          expect(asset.kind).toBe('reward_point')
        }
      } finally {
        await a.query('ROLLBACK').catch(() => {})
        await b.query('ROLLBACK').catch(() => {})
        await a.end()
        await b.end()
      }
    }
  })
})

function isDeadlockResult(result: PromiseSettledResult<unknown>): boolean {
  return result.status === 'rejected' && isDeadlock(result.reason)
}

async function runAutocommitTx(client: Client, work: () => Promise<unknown>): Promise<unknown> {
  await client.query('BEGIN')
  try {
    const result = await work()
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
}
