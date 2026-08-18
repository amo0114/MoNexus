import jwt from 'jsonwebtoken'
import { describe, expect, it } from 'vitest'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { api, authHeader, createTestUser, loginAs } from '../../__tests__/helpers.js'
import { isGovernanceEnvironmentAllowed } from './governanceCommandService.js'

const CREATE_BODY = {
  id: 'vp_controlled_1',
  version: 20001,
  referenceAtomicPerPointNumerator: '1',
  referenceAtomicPerPointDenominator: '1',
  effectiveAt: '2020-01-01T00:00:00.000Z',
  d02DecisionRecordRef: 'controlled/d02/decision-1',
  d02DecisionRecordSha256: 'a'.repeat(64),
  d03DecisionRecordRef: 'controlled/d03/decision-1',
  d03DecisionRecordSha256: 'b'.repeat(64),
  disclosureVersion: 'zh-CN-v1',
  reason: 'create controlled draft for test',
}

async function loginAdmin(email: string) {
  const { user, password } = await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(user.email, password)
  return { user, token: accessToken }
}

describe('ValuePolicy restricted governance routes', () => {
  it('is unavailable publicly and requires admin plus current MFA', async () => {
    await api.post('/api/value-policy').send(CREATE_BODY).expect(404)
    await api.post('/api/admin/value-policies').send(CREATE_BODY).expect(401)

    const { user, password } = await createTestUser('vp-normal@test.local', 'user1234', 'user')
    const normal = await loginAs(user.email, password)
    await api.post('/api/admin/value-policies')
      .set(authHeader(normal.accessToken))
      .set('Idempotency-Key', 'vp:user:create')
      .send(CREATE_BODY)
      .expect(403)

    const { user: admin } = await createTestUser('vp-no-mfa@test.local', 'admin123', 'admin')
    await loginAs(admin.email, 'admin123')
    const session = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: admin.id, revoked: false },
      orderBy: { id: 'desc' },
    })
    const withoutMfa = jwt.sign(
      { userId: admin.id, role: 'admin', sid: session.sessionId },
      config.jwtSecret,
      { expiresIn: '15m' },
    )
    const blocked = await api.post('/api/admin/value-policies')
      .set(authHeader(withoutMfa))
      .set('Idempotency-Key', 'vp:admin:no-mfa')
      .send(CREATE_BODY)
      .expect(403)
    expect(blocked.body.error.code).toBe('MFA_REQUIRED')
    expect(await prisma.valuePolicy.count()).toBe(0)
  })

  it('requires a valid idempotency key and strict decision evidence', async () => {
    const { token } = await loginAdmin('vp-schema@test.local')
    const missing = await api.post('/api/admin/value-policies')
      .set(authHeader(token))
      .send(CREATE_BODY)
      .expect(400)
    expect(missing.body.error.code).toBe('VALUE_POLICY_IDEMPOTENCY_KEY_REQUIRED')

    await api.post('/api/admin/value-policies')
      .set(authHeader(token))
      .set('Idempotency-Key', 'invalid key')
      .send(CREATE_BODY)
      .expect(400)
    await api.post('/api/admin/value-policies')
      .set(authHeader(token))
      .set('Idempotency-Key', 'vp:schema:bad-hash')
      .send({ ...CREATE_BODY, d02DecisionRecordSha256: 'NOT-A-HASH' })
      .expect(400)
    const invalidTime = await api.post('/api/admin/value-policies')
      .set(authHeader(token))
      .set('Idempotency-Key', 'vp:schema:past-effective')
      .send(CREATE_BODY)
      .expect(400)
    expect(invalidTime.body.error.code).toBe('VALUE_POLICY_EFFECTIVE_AT_INVALID')
    expect(await prisma.valuePolicy.count()).toBe(0)
  })

  it('enforces maker-checker and atomically records idempotency plus two audit trails', async () => {
    const maker = await loginAdmin('vp-maker-api@test.local')
    const checker = await loginAdmin('vp-checker-api@test.local')
    const createBody = {
      ...CREATE_BODY,
      effectiveAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
    }

    const created = await api.post('/api/admin/value-policies')
      .set(authHeader(maker.token))
      .set('Idempotency-Key', 'vp:create:1')
      .send(createBody)
      .expect(201)
    expect(created.body).toMatchObject({ replayed: false, policy: { status: 'draft', createdByUserId: maker.user.id } })

    const replayed = await api.post('/api/admin/value-policies')
      .set(authHeader(maker.token))
      .set('Idempotency-Key', 'vp:create:1')
      .send(createBody)
      .expect(200)
    expect(replayed.body).toEqual({ replayed: true, policy: created.body.policy })

    const changed = await api.post('/api/admin/value-policies')
      .set(authHeader(maker.token))
      .set('Idempotency-Key', 'vp:create:1')
      .send({ ...createBody, reason: 'a different controlled test reason' })
      .expect(409)
    expect(changed.body.error.code).toBe('VALUE_POLICY_IDEMPOTENCY_CONFLICT')

    const selfApprove = await api.post(`/api/admin/value-policies/${CREATE_BODY.id}/approve`)
      .set(authHeader(maker.token))
      .set('Idempotency-Key', 'vp:approve:self')
      .send({ reason: 'self approval must be rejected' })
      .expect(409)
    expect(selfApprove.body.error.code).toBe('VALUE_POLICY_MAKER_CHECKER_REQUIRED')

    await api.post(`/api/admin/value-policies/${CREATE_BODY.id}/approve`)
      .set(authHeader(checker.token))
      .set('Idempotency-Key', 'vp:approve:checker')
      .send({ reason: 'independent checker approval' })
      .expect(200)
    await api.post(`/api/admin/value-policies/${CREATE_BODY.id}/schedule`)
      .set(authHeader(checker.token))
      .set('Idempotency-Key', 'vp:schedule:checker')
      .send({ reason: 'schedule after independent approval' })
      .expect(200)
    const premature = await api.post(`/api/admin/value-policies/${CREATE_BODY.id}/activate`)
      .set(authHeader(checker.token))
      .set('Idempotency-Key', 'vp:activate:checker')
      .send({ reason: 'premature activation must fail closed' })
      .expect(409)
    expect(premature.body.error.code).toBe('VALUE_POLICY_GOVERNANCE_CONFLICT')

    const policy = await prisma.valuePolicy.findUniqueOrThrow({ where: { id: CREATE_BODY.id } })
    expect(policy).toMatchObject({
      status: 'scheduled',
      createdByUserId: maker.user.id,
      approvedByUserId: checker.user.id,
      scheduledByUserId: checker.user.id,
      activatedByUserId: null,
    })
    expect(await prisma.valuePolicyGovernanceCommand.count()).toBe(3)
    expect(await prisma.valuePolicyGovernanceEvent.count()).toBe(3)
    expect(await prisma.adminLog.count({ where: { action: { startsWith: 'value_policy.' } } })).toBe(3)
  })

  it('keeps governance events append-only at the database layer', async () => {
    const maker = await loginAdmin('vp-event-maker@test.local')
    await api.post('/api/admin/value-policies')
      .set(authHeader(maker.token))
      .set('Idempotency-Key', 'vp:event:create')
      .send({
        ...CREATE_BODY,
        id: 'vp_event_immutable',
        version: 20002,
        effectiveAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .expect(201)
    const event = await prisma.valuePolicyGovernanceEvent.findFirstOrThrow()
    const command = await prisma.valuePolicyGovernanceCommand.findUniqueOrThrow({
      where: { id: event.commandId },
    })
    await expect(prisma.valuePolicyGovernanceEvent.update({
      where: { id: event.id },
      data: { reason: 'attempted audit rewrite' },
    })).rejects.toThrow(/value_policy_governance_event_immutable/)
    await expect(prisma.valuePolicyGovernanceEvent.delete({ where: { id: event.id } }))
      .rejects.toThrow(/value_policy_governance_event_immutable/)
    await expect(prisma.valuePolicyGovernanceCommand.update({
      where: { id: command.id },
      data: { idempotencyKey: 'vp:event:rewritten' },
    })).rejects.toThrow(/value_policy_governance_command_immutable/)
    await expect(prisma.valuePolicyGovernanceCommand.delete({ where: { id: command.id } }))
      .rejects.toThrow(/value_policy_governance_command_immutable/)
  })
})

describe('ValuePolicy production governance gate', () => {
  it('fails closed only for the production runtime/deploy combination', () => {
    expect(isGovernanceEnvironmentAllowed('production', 'production')).toBe(false)
    expect(isGovernanceEnvironmentAllowed('production', 'staging')).toBe(true)
    expect(isGovernanceEnvironmentAllowed('test', 'production')).toBe(true)
  })
})
