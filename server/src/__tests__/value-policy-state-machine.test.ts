import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  activateValuePolicy,
  approveValuePolicy,
  createDraftValuePolicy,
  provisionValuePolicy,
  retireValuePolicy,
  scheduleValuePolicy,
} from '../modules/valuePolicy/governance.js'
import {
  createTestCnyValuePolicy,
  createTestValuePolicyActors,
  TEST_VALUE_POLICY_EVIDENCE,
} from './helpers.js'

const past = new Date('2020-01-01T00:00:00.000Z')

async function expectRejects(action: () => Promise<unknown>, pattern?: RegExp) {
  await expect(action()).rejects.toThrow(pattern)
}

describe('ValuePolicy legal state machine', () => {
  it('rejects a non-admin lifecycle actor at the database boundary', async () => {
    const user = await prisma.user.create({
      data: { email: 'vp-non-admin-actor@test.local', password: 'test-only', role: 'user' },
    })
    await expect(prisma.valuePolicy.create({
      data: {
        id: 'vp_non_admin_actor',
        version: 11000,
        pointAssetCode: 'RP',
        referenceAssetCode: 'CNY',
        referenceAtomicPerPointNumerator: 1n,
        referenceAtomicPerPointDenominator: 1n,
        roundingMode: 'HALF_EVEN',
        status: 'draft',
        effectiveAt: new Date('2030-01-01T00:00:00.000Z'),
        createdByUserId: user.id,
        ...TEST_VALUE_POLICY_EVIDENCE,
      },
    })).rejects.toThrow(/value_policy_actor_must_be_active_admin/)
  })

  it('walks every legal edge and refuses every illegal edge', async () => {
    const { creator, approver } = await createTestValuePolicyActors()
    const draft = await createDraftValuePolicy(prisma, {
      id: 'vp_sm_legal',
      version: 11001,
      effectiveAt: past,
      createdAt: past,
      createdByUserId: creator.id,
      ...TEST_VALUE_POLICY_EVIDENCE,
    })
    expect(draft.status).toBe('draft')

    await expectRejects(() => scheduleValuePolicy(prisma, draft.id, approver.id), /invalid_status_transition/)
    await expectRejects(() => activateValuePolicy(prisma, draft.id, approver.id), /invalid_activation/)
    await expectRejects(() => retireValuePolicy(prisma, draft.id, approver.id), /retire_requires_active/)
    await expect(prisma.valuePolicy.update({
      where: { id: draft.id },
      data: { status: 'approved', approvedAt: past, approvedByUserId: creator.id },
    })).rejects.toThrow(/approve_requires_independent_actor/)

    const approved = await approveValuePolicy(prisma, draft.id, approver.id, past)
    expect(approved.status).toBe('approved')
    expect(approved.approvedAt).not.toBeNull()

    await expectRejects(
      () => prisma.valuePolicy.update({ where: { id: draft.id }, data: { status: 'draft' } }),
      /invalid_status_transition/,
    )
    await expectRejects(() => activateValuePolicy(prisma, draft.id, approver.id), /invalid_activation/)
    await expectRejects(() => retireValuePolicy(prisma, draft.id, approver.id), /retire_requires_active/)

    const scheduled = await scheduleValuePolicy(prisma, draft.id, approver.id)
    expect(scheduled.status).toBe('scheduled')

    await expectRejects(
      () => prisma.valuePolicy.update({ where: { id: draft.id }, data: { status: 'approved' } }),
      /invalid_status_transition/,
    )
    await expectRejects(
      () => prisma.valuePolicy.update({ where: { id: draft.id }, data: { status: 'draft' } }),
      /invalid_status_transition/,
    )
    await expectRejects(() => retireValuePolicy(prisma, draft.id, approver.id), /retire_requires_active/)

    const active = await activateValuePolicy(prisma, draft.id, approver.id, new Date())
    expect(active.status).toBe('active')
    expect(active.activatedAt).not.toBeNull()

    await expectRejects(
      () => prisma.valuePolicy.update({ where: { id: draft.id }, data: { status: 'scheduled' } }),
      /invalid_status_transition/,
    )
    await expectRejects(
      () => prisma.valuePolicy.update({ where: { id: draft.id }, data: { status: 'approved' } }),
      /invalid_status_transition/,
    )
    await expectRejects(
      () => prisma.valuePolicy.update({ where: { id: draft.id }, data: { status: 'draft' } }),
      /invalid_status_transition/,
    )

    const retired = await retireValuePolicy(prisma, draft.id, approver.id, new Date())
    expect(retired.status).toBe('retired')
    await expectRejects(
      () => prisma.valuePolicy.update({
        where: { id: draft.id },
        data: { status: 'active', retiredAt: null },
      }),
      /retired_immutable/,
    )
  })

  it('rejects INSERT of every non-draft status, including active and retired', async () => {
    const { creator, approver } = await createTestValuePolicyActors()
    for (const [status, version] of [
      ['approved', 11101],
      ['scheduled', 11102],
      ['active', 11103],
      ['retired', 11104],
    ] as const) {
      await expect(prisma.valuePolicy.create({
        data: {
          id: `vp_insert_${status}`,
          version,
          pointAssetCode: 'RP',
          referenceAssetCode: 'CNY',
          referenceAtomicPerPointNumerator: 1n,
          referenceAtomicPerPointDenominator: 1n,
          roundingMode: 'HALF_EVEN',
          status,
          effectiveAt: past,
          createdAt: past,
          approvedAt: status === 'approved' || status === 'scheduled' ? past : status === 'active' || status === 'retired' ? past : null,
          activatedAt: status === 'active' || status === 'retired' ? past : null,
          retiredAt: status === 'retired' ? past : null,
          createdByUserId: creator.id,
          approvedByUserId: approver.id,
          scheduledByUserId: status === 'scheduled' || status === 'active' || status === 'retired' ? approver.id : null,
          activatedByUserId: status === 'active' || status === 'retired' ? approver.id : null,
          retiredByUserId: status === 'retired' ? approver.id : null,
          ...TEST_VALUE_POLICY_EVIDENCE,
        },
      })).rejects.toThrow(/value_policy_insert_must_be_draft|value_policy_retire_requires_active/)
    }
  })

  it('rejects missing approvedAt/activatedAt and activation before effectiveAt', async () => {
    const { creator, approver } = await createTestValuePolicyActors()
    const draft = await createDraftValuePolicy(prisma, {
      id: 'vp_sm_times',
      version: 11201,
      effectiveAt: past,
      createdAt: past,
      createdByUserId: creator.id,
      ...TEST_VALUE_POLICY_EVIDENCE,
    })

    await expect(prisma.valuePolicy.update({
      where: { id: draft.id },
      data: { status: 'approved', approvedAt: null },
    })).rejects.toThrow()

    await approveValuePolicy(prisma, draft.id, approver.id, past)
    await scheduleValuePolicy(prisma, draft.id, approver.id)

    await expect(prisma.valuePolicy.update({
      where: { id: draft.id },
      data: { status: 'active', activatedAt: null },
    })).rejects.toThrow()

    const future = await createDraftValuePolicy(prisma, {
      id: 'vp_sm_future',
      version: 11202,
      effectiveAt: new Date('2099-01-01T00:00:00.000Z'),
      createdByUserId: creator.id,
      ...TEST_VALUE_POLICY_EVIDENCE,
    })
    await approveValuePolicy(prisma, future.id, approver.id, new Date())
    await scheduleValuePolicy(prisma, future.id, approver.id)
    await expect(activateValuePolicy(prisma, future.id, approver.id, new Date())).rejects.toThrow(/effective_at_not_reached/)
  })

  it('locks every economic and audit field on active and retired rows', async () => {
    const { approver } = await createTestValuePolicyActors()
    const policy = await createTestCnyValuePolicy({ id: 'vp_sm_lock', version: 11301 })
    const forbidden = [
      { referenceAtomicPerPointNumerator: 2n },
      { referenceAtomicPerPointDenominator: 2n },
      { version: 11399 },
      { effectiveAt: new Date('2021-01-01T00:00:00.000Z') },
      { approvedAt: new Date('2021-01-01T00:00:00.000Z') },
      { activatedAt: new Date('2021-01-01T00:00:00.000Z') },
      { createdAt: new Date('2019-01-01T00:00:00.000Z') },
    ]
    for (const data of forbidden) {
      await expect(prisma.valuePolicy.update({ where: { id: policy.id }, data })).rejects.toThrow()
    }

    const retired = await retireValuePolicy(prisma, policy.id, approver.id, new Date())
    expect(retired.status).toBe('retired')
    for (const data of [...forbidden, { retiredAt: new Date('2022-01-01T00:00:00.000Z') }]) {
      await expect(prisma.valuePolicy.update({ where: { id: policy.id }, data })).rejects.toThrow(/retired_immutable/)
    }
  })

  it('enforces retiredAt against createdAt/effectiveAt/activatedAt', async () => {
    const { approver } = await createTestValuePolicyActors()
    const policy = await createTestCnyValuePolicy({ id: 'vp_sm_retired_at', version: 11401 })
    await expect(prisma.valuePolicy.update({
      where: { id: policy.id },
      data: {
        status: 'retired',
        retiredAt: new Date('2019-01-01T00:00:00.000Z'),
        retiredByUserId: approver.id,
      },
    })).rejects.toThrow(/retired_at_invalid/)
  })

  it('rejects concurrent activation of two scheduled policies', async () => {
    const { creator, approver } = await createTestValuePolicyActors()
    await provisionValuePolicy(prisma, {
      id: 'vp_sm_one',
      version: 11501,
      effectiveAt: past,
      createdAt: past,
      status: 'scheduled',
      createdByUserId: creator.id,
      approvedByUserId: approver.id,
      ...TEST_VALUE_POLICY_EVIDENCE,
    })
    await provisionValuePolicy(prisma, {
      id: 'vp_sm_two',
      version: 11502,
      effectiveAt: past,
      createdAt: past,
      status: 'scheduled',
      createdByUserId: creator.id,
      approvedByUserId: approver.id,
      ...TEST_VALUE_POLICY_EVIDENCE,
    })

    const results = await Promise.allSettled([
      prisma.$transaction(tx => activateValuePolicy(tx, 'vp_sm_one', approver.id)),
      prisma.$transaction(tx => activateValuePolicy(tx, 'vp_sm_two', approver.id)),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await prisma.valuePolicy.count({ where: { status: 'active' } })).toBe(1)
  })
})
