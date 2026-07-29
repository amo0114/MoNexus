import { describe, expect, it, beforeEach } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  MAX_PROVISION_EMAIL_SENDS_PER_USER_PER_DAY,
  sendProvisionEmailCode,
  confirmProvisionEmailCode,
  isProvisionEmailTrusted,
  assertProvisionEmailTrusted,
} from '../lib/fakaBridge/provisionEmailProof.js'
import { __setMailerForTesting } from '../lib/mailer/index.js'
import type { Mailer } from '../lib/mailer/types.js'
import { createTestUser } from './helpers.js'

const sent: { to: string; text: string }[] = []

beforeEach(async () => {
  sent.length = 0
  __setMailerForTesting({
    send: async (msg) => {
      sent.push({ to: msg.to, text: msg.text ?? '' })
    },
  } as Mailer)
  await prisma.fakaProvisionEmailProof.deleteMany({})
  await prisma.$executeRawUnsafe('DELETE FROM "FakaProvisionEmailSendBudget"')
})

describe('provision email ownership', () => {
  it('trusts verified account email without OTP', async () => {
    const user = await prisma.user.findFirst({ where: { email: 'test@moyuan.net' } })
    if (!user) return // skip if seed missing
    // ensure verified
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } })
    expect(await isProvisionEmailTrusted(user.id, user.email)).toBe(true)
    await expect(assertProvisionEmailTrusted(user.id, user.email)).resolves.toBe(user.email.toLowerCase())
  })

  it('requires OTP for foreign email then permanently binds', async () => {
    const user = await prisma.user.findFirst({ where: { email: 'test@moyuan.net' } })
    if (!user) return
    const foreign = `owned-${Date.now()}@example.com`
    expect(await isProvisionEmailTrusted(user.id, foreign)).toBe(false)
    await sendProvisionEmailCode(user.id, foreign)
    expect(sent.length).toBe(1)
    const m = sent[0].text.match(/验证码：(\d{6})/)
    expect(m).toBeTruthy()
    const confirmed = await confirmProvisionEmailCode(user.id, foreign, m![1])
    expect(confirmed.bound).toBe(true)
    expect(confirmed.proofExpiresAt).toBeNull()
    expect(await isProvisionEmailTrusted(user.id, foreign)).toBe(true)
    // Second session: still trusted without new OTP
    expect(await isProvisionEmailTrusted(user.id, foreign)).toBe(true)
    const row = await prisma.fakaProvisionEmailProof.findUnique({
      where: { userId_email: { userId: user.id, email: foreign } },
    })
    expect(row?.verifiedAt).toBeTruthy()
    expect(row?.proofExpiresAt).toBeNull()
  })

  it('serializes the rolling daily quota across distinct target emails', async () => {
    const { user } = await createTestUser(
      `faka-otp-budget-${Date.now()}@example.com`,
      'pass123',
      'user',
      100
    )
    const targets = Array.from(
      { length: MAX_PROVISION_EMAIL_SENDS_PER_USER_PER_DAY + 2 },
      (_, i) => `faka-otp-target-${Date.now()}-${i}@example.com`
    )

    const outcomes = await Promise.allSettled(
      targets.map(email => sendProvisionEmailCode(user.id, email))
    )
    const fulfilled = outcomes.filter(
      (
        outcome
      ): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof sendProvisionEmailCode>>> =>
        outcome.status === 'fulfilled'
    )
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
    )

    expect(fulfilled).toHaveLength(MAX_PROVISION_EMAIL_SENDS_PER_USER_PER_DAY)
    expect(fulfilled.every(outcome => outcome.value.sent)).toBe(true)
    expect(rejected).toHaveLength(2)
    expect(rejected.every(outcome => String(outcome.reason).includes('已达上限'))).toBe(true)
    expect(sent).toHaveLength(MAX_PROVISION_EMAIL_SENDS_PER_USER_PER_DAY)

    const budget = await prisma.$queryRaw<Array<{ sendCount: number }>>`
      SELECT "sendCount" FROM "FakaProvisionEmailSendBudget" WHERE "userId" = ${user.id}`
    expect(budget).toEqual([{ sendCount: MAX_PROVISION_EMAIL_SENDS_PER_USER_PER_DAY }])
  })

  it('keeps a failed SMTP attempt retryable without releasing its reserved quota', async () => {
    const { user } = await createTestUser(
      `faka-otp-retry-${Date.now()}@example.com`,
      'pass123',
      'user',
      100
    )
    const target = `faka-otp-failure-${Date.now()}@example.com`
    __setMailerForTesting({
      send: async () => {
        throw new Error('SMTP unavailable')
      },
    } as Mailer)

    await expect(sendProvisionEmailCode(user.id, target)).rejects.toThrow('SMTP unavailable')
    const first = await prisma.fakaProvisionEmailProof.findUniqueOrThrow({
      where: { userId_email: { userId: user.id, email: target } },
    })
    expect(first.sendCount).toBe(1)

    // The original 60s interval remains the retry gate.  Move it past that
    // interval rather than releasing the committed mail reservation.
    await prisma.fakaProvisionEmailProof.update({
      where: { id: first.id },
      data: { lastSentAt: new Date(Date.now() - 61_000) },
    })
    __setMailerForTesting({
      send: async message => {
        sent.push({ to: message.to, text: message.text ?? '' })
      },
    } as Mailer)

    await expect(sendProvisionEmailCode(user.id, target)).resolves.toMatchObject({ sent: true })
    const budget = await prisma.$queryRaw<Array<{ sendCount: number }>>`
      SELECT "sendCount" FROM "FakaProvisionEmailSendBudget" WHERE "userId" = ${user.id}`
    expect(budget).toEqual([{ sendCount: 2 }])
    expect(sent).toHaveLength(1)
  })
})
