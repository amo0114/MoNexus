import { describe, expect, it, beforeEach } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  sendProvisionEmailCode,
  confirmProvisionEmailCode,
  isProvisionEmailTrusted,
  assertProvisionEmailTrusted,
} from '../lib/fakaBridge/provisionEmailProof.js'
import { __setMailerForTesting } from '../lib/mailer/index.js'
import type { Mailer } from '../lib/mailer/types.js'

const sent: { to: string; text: string }[] = []

beforeEach(async () => {
  sent.length = 0
  __setMailerForTesting({
    send: async (msg) => {
      sent.push({ to: msg.to, text: msg.text ?? '' })
    },
  } as Mailer)
  await prisma.fakaProvisionEmailProof.deleteMany({})
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
})
