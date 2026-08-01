import jwt from 'jsonwebtoken'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { registerUser } from '../modules/auth/service.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'

const DAY_MS = 24 * 60 * 60 * 1_000

async function loginAdmin(email = 'rap-abuse-admin@test.local') {
  const { user, password } = await createTestUser(email, 'admin123', 'admin')
  const session = await loginAs(user.email, password)
  return { user, accessToken: session.accessToken }
}

async function createQualifiedReferralReward(label: string) {
  const { user: inviter } = await createTestUser(`${label}-inviter@test.local`, 'pass123', 'user', 0)
  const { user: invitee } = await createTestUser(`${label}-invitee@test.local`, 'pass123', 'user', 0)
  await prisma.user.update({
    where: { id: inviter.id },
    data: {
      emailVerified: new Date(),
      createdAt: new Date(Date.now() - 31 * DAY_MS),
    },
  })
  const relation = await prisma.inviteRelation.create({
    data: {
      inviterId: inviter.id,
      inviteeId: invitee.id,
      status: 'qualified',
      qualifiedAt: new Date(),
      qualificationDay: '2026-08-01',
    },
  })
  const reward = await prisma.growthReward.create({
    data: {
      recipientUserId: inviter.id,
      inviteRelationId: relation.id,
      kind: 'referral',
      amount: 200,
      state: 'held',
      availableAt: new Date(Date.now() + DAY_MS),
      dedupeKey: `admin-referral:${relation.id}`,
    },
  })
  return { inviter, invitee, relation, reward }
}

describe('SPEC-RAP-001 /api/admin/abuse MFA operations', () => {
  beforeEach(async () => {
    await prisma.systemConfig.deleteMany()
  })

  afterEach(async () => {
    await prisma.systemConfig.deleteMany()
  })

  it('requires an authenticated administrator with a current MFA session', async () => {
    const { user: admin, accessToken } = await loginAdmin('rap-abuse-mfa-admin@test.local')
    const { user: normalUser, password } = await createTestUser('rap-abuse-mfa-user@test.local')
    const normalSession = await loginAs(normalUser.email, password)
    const activeSession = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: admin.id, revoked: false },
      orderBy: { id: 'desc' },
    })
    const noMfaToken = jwt.sign(
      { userId: admin.id, role: 'admin', sid: activeSession.sessionId },
      config.jwtSecret,
      { expiresIn: '15m' },
    )

    await api.get('/api/admin/abuse/overview').expect(401)
    await api.get('/api/admin/abuse/overview').set(authHeader(normalSession.accessToken)).expect(403)
    const missingMfa = await api.get('/api/admin/abuse/overview').set(authHeader(noMfaToken)).expect(403)
    expect(missingMfa.body.error.code).toBe('MFA_REQUIRED')
    await api.get('/api/admin/abuse/overview').set(authHeader(accessToken)).expect(200)
  })

  it('returns aggregate overview and masked referral/reward projections only', async () => {
    const { accessToken } = await loginAdmin('rap-abuse-projection-admin@test.local')
    const { inviter, invitee, relation, reward } = await createQualifiedReferralReward('rap-abuse-projection')
    await prisma.abuseEvent.createMany({
      data: [
        { type: 'registration_rejected' },
        { type: 'challenge_failed' },
        { type: 'mail_throttled' },
      ],
    })
    await prisma.emailVerificationToken.create({
      data: {
        userId: invitee.id,
        tokenHash: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + DAY_MS),
      },
    })

    const overview = await api
      .get('/api/admin/abuse/overview')
      .query({ window: '1h' })
      .set(authHeader(accessToken))
      .expect(200)
    expect(overview.body).toMatchObject({
      window: '1h',
      registrations: { rejected: 1 },
      challengeFailures: 1,
      verificationEmail: { sent: 1, throttled: 1 },
      referrals: { qualified: 1 },
      rewards: { held: 1 },
    })

    const referrals = await api
      .get('/api/admin/abuse/referrals')
      .query({ state: 'qualified', page: 1, pageSize: 10 })
      .set(authHeader(accessToken))
      .expect(200)
    expect(referrals.body).toMatchObject({ total: 1, page: 1, pageSize: 10 })
    expect(referrals.body.items[0]).toMatchObject({
      id: relation.id,
      inviter: { id: inviter.id, referralSuspended: false },
      invitee: { id: invitee.id },
      reward: { id: reward.id, amount: 200, state: 'held' },
    })

    const rewards = await api
      .get('/api/admin/abuse/rewards')
      .query({ state: 'held', userId: inviter.id, page: 1, pageSize: 10 })
      .set(authHeader(accessToken))
      .expect(200)
    expect(rewards.body).toMatchObject({ total: 1, page: 1, pageSize: 10 })
    expect(rewards.body.items[0]).toMatchObject({ id: reward.id, kind: 'referral', amount: 200, state: 'held' })

    const projectionJson = JSON.stringify({ referrals: referrals.body, rewards: rewards.body })
    expect(projectionJson).not.toContain(inviter.email)
    expect(projectionJson).not.toContain(invitee.email)
    expect(projectionJson).not.toContain('tokenHash')
    expect(projectionJson).not.toContain('ipHash')
    expect(referrals.body.items[0].inviter.email).toContain('***')
    expect(referrals.body.items[0].invitee.email).toContain('***')
  })

  it('suspends future referral qualification, voids held referrals, and leaves base registration available', async () => {
    const { user: admin, accessToken } = await loginAdmin('rap-abuse-suspend-admin@test.local')
    const { inviter, relation, reward } = await createQualifiedReferralReward('rap-abuse-suspend')

    const suspended = await api
      .put(`/api/admin/abuse/users/${inviter.id}/referral-suspension`)
      .set(authHeader(accessToken))
      .send({ suspended: true, caseRef: 'RAP-201' })
      .expect(200)
    expect(suspended.body).toEqual({ userId: inviter.id, suspended: true, voidedRewards: 1 })
    await expect(prisma.user.findUniqueOrThrow({ where: { id: inviter.id } })).resolves.toMatchObject({
      referralSuspended: true,
    })
    await expect(prisma.inviteRelation.findUniqueOrThrow({ where: { id: relation.id } })).resolves.toMatchObject({
      status: 'voided',
    })
    await expect(prisma.growthReward.findUniqueOrThrow({ where: { id: reward.id } })).resolves.toMatchObject({
      state: 'voided',
      voidReason: 'referral_suspended',
    })
    await expect(prisma.adminLog.findFirstOrThrow({
      where: { adminUserId: admin.id, targetType: 'user_referral', targetId: inviter.id },
    })).resolves.toMatchObject({ action: '暂停邀请码资格', detail: expect.stringContaining('RAP-201') })
    await expect(prisma.abuseEvent.findFirstOrThrow({
      where: { type: 'referral_suspended', inviterId: inviter.id },
    })).resolves.toMatchObject({ detailSafe: { caseRef: 'RAP-201' } })

    const newRegistration = await registerUser('rap-abuse-suspended-invitee@test.local', 'pass123', inviter.inviteCode)
    expect(newRegistration.user.points).toBe(0)
    expect(await prisma.inviteRelation.count({ where: { inviteeId: newRegistration.user.id } })).toBe(0)

    await api
      .put(`/api/admin/abuse/users/${inviter.id}/referral-suspension`)
      .set(authHeader(accessToken))
      .send({ suspended: false, caseRef: 'RAP-202' })
      .expect(200)
    await expect(prisma.growthReward.findUniqueOrThrow({ where: { id: reward.id } })).resolves.toMatchObject({
      state: 'voided',
    })
  })

  it('voids only pending/held rewards and writes both administrator and abuse audit records', async () => {
    const { user: admin, accessToken } = await loginAdmin('rap-abuse-void-admin@test.local')
    const user = await createTestUser('rap-abuse-void-user@test.local', 'pass123', 'user', 0)
    const held = await prisma.growthReward.create({
      data: {
        recipientUserId: user.user.id,
        kind: 'registration',
        amount: 300,
        state: 'held',
        availableAt: new Date(Date.now() + DAY_MS),
        dedupeKey: `admin-void-held:${user.user.id}`,
      },
    })
    const granted = await prisma.growthReward.create({
      data: {
        recipientUserId: user.user.id,
        kind: 'registration',
        amount: 1,
        state: 'granted',
        grantedAt: new Date(),
        dedupeKey: `admin-void-granted:${user.user.id}`,
      },
    })

    const invalid = await api
      .post(`/api/admin/abuse/rewards/${held.id}/void`)
      .set(authHeader(accessToken))
      .send({ caseRef: 'bad case' })
      .expect(400)
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR')

    const voided = await api
      .post(`/api/admin/abuse/rewards/${held.id}/void`)
      .set(authHeader(accessToken))
      .send({ caseRef: 'RAP-301' })
      .expect(200)
    expect(voided.body).toEqual({ id: held.id, kind: 'registration', amount: 300, state: 'voided', caseRef: 'RAP-301' })
    await expect(prisma.growthReward.findUniqueOrThrow({ where: { id: held.id } })).resolves.toMatchObject({
      state: 'voided',
      voidReason: 'admin_void',
    })
    expect(await prisma.pointLog.count({ where: { userId: user.user.id } })).toBe(1)
    await expect(prisma.adminLog.findFirstOrThrow({
      where: { adminUserId: admin.id, targetType: 'growthReward', targetId: held.id },
    })).resolves.toMatchObject({ action: '作废未发奖励', detail: expect.stringContaining('RAP-301') })
    await expect(prisma.abuseEvent.findFirstOrThrow({
      where: { type: 'reward_voided', userId: user.user.id },
    })).resolves.toMatchObject({ detailSafe: { kind: 'registration', reason: 'admin_void', caseRef: 'RAP-301' } })

    const grantedResult = await api
      .post(`/api/admin/abuse/rewards/${granted.id}/void`)
      .set(authHeader(accessToken))
      .send({ caseRef: 'RAP-302' })
      .expect(409)
    expect(grantedResult.body.error.code).toBe('CONFLICT')
    await expect(prisma.growthReward.findUniqueOrThrow({ where: { id: granted.id } })).resolves.toMatchObject({
      state: 'granted',
    })
  })
})
