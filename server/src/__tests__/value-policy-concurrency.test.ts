import { afterEach, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { prisma } from '../lib/prisma.js'
import {
  activateValuePolicy,
  provisionValuePolicy,
} from '../modules/valuePolicy/governance.js'

const ROUNDS = 12
const past = new Date('2020-01-01T00:00:00.000Z')
const TX = { timeout: 8000, maxWait: 3000 } as const

function isDeadlock(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${JSON.stringify(err)}` : String(err)
  return text.includes('40P01') || /deadlock detected/i.test(text)
}

function isBusinessRejection(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${JSON.stringify(err)}` : String(err)
  return /value_policy_active_asset_must_be_enabled|asset_definition_in_use_by_active_policy|effective_at_not_reached|23514/.test(text)
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

async function seedScheduled(id: string, version: number) {
  return provisionValuePolicy(prisma, {
    id,
    version,
    effectiveAt: past,
    createdAt: past,
    status: 'scheduled',
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
    for (let round = 0; round < ROUNDS; round += 1) {
      await resetAssetsAndPolicies()
      await seedScheduled(`vp_race_cny_${round}`, 12000 + round)

      const results = await Promise.allSettled([
        prisma.$transaction(async tx => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`
          await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`
          return activateValuePolicy(tx, `vp_race_cny_${round}`)
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
    for (let round = 0; round < ROUNDS; round += 1) {
      await resetAssetsAndPolicies()
      await seedScheduled(`vp_race_rp_${round}`, 13000 + round)

      const results = await Promise.allSettled([
        prisma.$transaction(async tx => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`
          await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`
          return activateValuePolicy(tx, `vp_race_rp_${round}`)
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

  it('raw SQL activate vs disable does not produce 40P01', async () => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is required')

    for (let round = 0; round < ROUNDS; round += 1) {
      await resetAssetsAndPolicies()
      await seedScheduled(`vp_raw_${round}`, 14000 + round)

      const a = new Client({ connectionString: url })
      const b = new Client({ connectionString: url })
      await a.connect()
      await b.connect()
      try {
        await a.query("SET lock_timeout = '2s'")
        await a.query("SET statement_timeout = '5s'")
        await b.query("SET lock_timeout = '2s'")
        await b.query("SET statement_timeout = '5s'")
        await a.query('BEGIN')
        await b.query('BEGIN')

        const raced = await Promise.allSettled([
          a.query(
            `UPDATE "ValuePolicy" SET status = 'active', "activatedAt" = NOW() WHERE id = $1`,
            [`vp_raw_${round}`],
          ),
          b.query(`UPDATE "AssetDefinition" SET enabled = false WHERE code = 'CNY'`),
        ])
        expect(raced.some(isDeadlockResult), `raw deadlock begin round ${round}`).toBe(false)

        const commits = await Promise.allSettled([a.query('COMMIT'), b.query('COMMIT')])
        expect(commits.some(isDeadlockResult), `raw deadlock commit round ${round}`).toBe(false)
        await assertInvariant()
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
