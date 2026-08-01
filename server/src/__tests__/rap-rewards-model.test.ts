import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { prisma } from '../lib/prisma.js'

const migrationSql = readFileSync(
  fileURLToPath(
    new URL('../../prisma/migrations/20260731170039_registration_abuse_prevention/migration.sql', import.meta.url),
  ),
  'utf8',
)

const createUser = (label: string) =>
  prisma.user.create({
    data: {
      email: `rap-model-${label}@example.test`,
      password: 'test-password-hash',
    },
  })

// This suite is intentionally run only after the T20 migration has been
// generated and replayed against the dedicated RAP test database. It asserts
// the Prisma model contract; migration-era data preservation is exercised by
// the documented preflight procedure alongside the replay.
describe('RAP reward and abuse data models', () => {
  it('backfills historical relations as legacy without changing the point ledger', () => {
    expect(migrationSql).toMatch(/ADD COLUMN\s+"status" TEXT NOT NULL DEFAULT 'legacy'/)
    expect(migrationSql).not.toMatch(/(?:ALTER|CREATE|DROP|INSERT INTO|UPDATE|DELETE FROM) TABLE "Point(?:Account|Log)"/)
    expect(migrationSql).not.toContain('INSERT INTO "GrowthReward"')
  })

  it('defaults invite relations to legacy without creating point-side effects', async () => {
    const inviter = await createUser('legacy-inviter')
    const invitee = await createUser('legacy-invitee')

    const relation = await prisma.inviteRelation.create({
      data: {
        inviterId: inviter.id,
        inviteeId: invitee.id,
      },
    })

    expect(inviter.referralSuspended).toBe(false)
    expect(relation).toMatchObject({
      status: 'legacy',
      qualifiedAt: null,
      voidedAt: null,
      qualificationDay: null,
    })
    expect(await prisma.pointAccount.count()).toBe(0)
    expect(await prisma.pointLog.count()).toBe(0)
    expect(await prisma.growthReward.count()).toBe(0)
  })

  it('keeps reward records unique by dedupe key and invite relation', async () => {
    const inviter = await createUser('reward-inviter')
    const invitee = await createUser('reward-invitee')
    const relation = await prisma.inviteRelation.create({
      data: {
        inviterId: inviter.id,
        inviteeId: invitee.id,
        status: 'pending_verification',
      },
    })

    const registrationReward = await prisma.growthReward.create({
      data: {
        recipientUserId: invitee.id,
        kind: 'registration',
        amount: 500,
        dedupeKey: `registration:${invitee.id}`,
      },
    })
    const referralReward = await prisma.growthReward.create({
      data: {
        recipientUserId: inviter.id,
        inviteRelationId: relation.id,
        kind: 'referral',
        amount: 200,
        dedupeKey: `referral:${relation.id}`,
      },
      include: {
        recipient: true,
        inviteRelation: true,
      },
    })

    expect(registrationReward).toMatchObject({
      state: 'pending_verification',
      availableAt: null,
      grantedAt: null,
      voidedAt: null,
    })
    expect(referralReward.recipient.id).toBe(inviter.id)
    expect(referralReward.inviteRelation?.id).toBe(relation.id)
    expect(referralReward.createdAt).toBeInstanceOf(Date)
    expect(referralReward.updatedAt).toBeInstanceOf(Date)

    await expect(
      prisma.growthReward.create({
        data: {
          recipientUserId: invitee.id,
          kind: 'registration',
          amount: 500,
          dedupeKey: registrationReward.dedupeKey,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })

    await expect(
      prisma.growthReward.create({
        data: {
          recipientUserId: inviter.id,
          inviteRelationId: relation.id,
          kind: 'referral',
          amount: 200,
          dedupeKey: `referral-duplicate:${relation.id}`,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })
  })

  it('retains abuse evidence while nulling each deleted user relation', async () => {
    const [eventUser, eventInviter, eventInvitee] = await Promise.all([
      createUser('event-user'),
      createUser('event-inviter'),
      createUser('event-invitee'),
    ])

    const [userEvent, inviterEvent, inviteeEvent] = await Promise.all([
      prisma.abuseEvent.create({
        data: {
          type: 'registration_rejected',
          userId: eventUser.id,
          ipHash: 'test-ip-hash',
          detailSafe: { reason: 'test' },
        },
      }),
      prisma.abuseEvent.create({
        data: {
          type: 'referral_qualified',
          inviterId: eventInviter.id,
          emailHash: 'test-email-hash',
          detailSafe: { count: 1 },
        },
      }),
      prisma.abuseEvent.create({
        data: {
          type: 'referral_quota_exhausted',
          inviteeId: eventInvitee.id,
          detailSafe: { reason: 'test' },
        },
      }),
    ])

    await prisma.user.delete({ where: { id: eventUser.id } })
    await prisma.user.delete({ where: { id: eventInviter.id } })
    await prisma.user.delete({ where: { id: eventInvitee.id } })

    await expect(prisma.abuseEvent.findUniqueOrThrow({ where: { id: userEvent.id } })).resolves.toMatchObject({
      userId: null,
      ipHash: 'test-ip-hash',
    })
    await expect(prisma.abuseEvent.findUniqueOrThrow({ where: { id: inviterEvent.id } })).resolves.toMatchObject({
      inviterId: null,
      emailHash: 'test-email-hash',
    })
    await expect(prisma.abuseEvent.findUniqueOrThrow({ where: { id: inviteeEvent.id } })).resolves.toMatchObject({
      inviteeId: null,
      type: 'referral_quota_exhausted',
    })
  })
})
