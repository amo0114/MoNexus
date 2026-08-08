import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, createTestUser } from './helpers.js'
import { logger } from '../lib/logger.js'
import { prisma } from '../lib/prisma.js'
import { CaptureMailer } from '../lib/mailer/capture.js'
import { __setMailerForTesting, type Mailer, type MailMessage } from '../lib/mailer/index.js'
import { lockUserRefreshSessionMutations } from '../modules/auth/sessionService.js'

class FailingMailer implements Mailer {
  rawToken: string | undefined

  async send(msg: MailMessage): Promise<void> {
    this.rawToken = rawTokenFrom(msg)
    const err = new Error(`provider echoed message body: ${msg.text}`) as Error & { code: string }
    err.code = 'EAUTH'
    throw err
  }
}

type MailOutcome = 'success' | 'failure'

class GatedMailer implements Mailer {
  readonly sent: MailMessage[] = []
  private readonly sentWaiters: Array<{
    min: number
    resolve: () => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []
  private releaseGate: () => void = () => undefined
  private readonly released = new Promise<void>(resolve => { this.releaseGate = resolve })

  constructor(private readonly outcomes: MailOutcome[]) {}

  async send(msg: MailMessage): Promise<void> {
    const index = this.sent.push(msg) - 1
    this.notifySentWaiters()
    await this.released
    if ((this.outcomes[index] ?? 'success') === 'failure') {
      const err = new Error('controlled SMTP timeout') as Error & { code: string }
      err.code = 'ETIMEDOUT'
      throw err
    }
  }

  async waitForSent(min: number): Promise<void> {
    if (this.sent.length >= min) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`mailer did not receive ${min} messages`)), 5000)
      this.sentWaiters.push({ min, resolve, reject, timer })
    })
  }

  releaseAll() {
    this.releaseGate()
  }

  private notifySentWaiters() {
    for (let i = this.sentWaiters.length - 1; i >= 0; i--) {
      const waiter = this.sentWaiters[i]
      if (this.sent.length < waiter.min) continue
      clearTimeout(waiter.timer)
      this.sentWaiters.splice(i, 1)
      waiter.resolve()
    }
  }
}

function rawTokenFrom(msg: MailMessage): string {
  const match = msg.text.match(/reset-password\/([a-f0-9]+)/)
  if (!match) throw new Error('reset email did not contain a token')
  return match[1]
}

function tokenHash(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

async function waitForAdvisoryLockWaiters(min: number): Promise<void> {
  for (let i = 0; i < 250; i++) {
    const rows = await prisma.$queryRaw<{ query: string }[]>`
      SELECT query FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND query LIKE '%pg_advisory_xact_lock%'`
    if (rows.length >= min) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`barrier: 没有观察到 ${min} 个密码重置签发锁等待者`)
}

function holdPasswordResetIssuanceLock(userId: number) {
  let releaseLock!: () => void
  const release = new Promise<void>(resolve => { releaseLock = resolve })
  let markHeld!: () => void
  const held = new Promise<void>(resolve => { markHeld = resolve })
  const transaction = prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, userId)
    markHeld()
    await release
  }, { timeout: 15_000 })
  return { held, release: releaseLock, transaction }
}

describe('password reset mail delivery consistency', () => {
  let mailer: CaptureMailer

  beforeEach(() => {
    mailer = new CaptureMailer()
    __setMailerForTesting(mailer)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('preserves an existing reset link and leaves no unseen active token when delivery fails', async () => {
    const { user } = await createTestUser('reset-mail-failure@test.local')

    await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200)
    const firstRawToken = mailer.lastTo(user.email)!.text.match(/reset-password\/([a-f0-9]+)/)![1]
    const firstStoredToken = await prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id, used: false },
    })

    __setMailerForTesting(new FailingMailer())
    await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200)

    const tokens = await prisma.passwordResetToken.findMany({
      where: { userId: user.id },
      orderBy: { id: 'asc' },
    })
    expect(tokens.filter(token => !token.used).map(token => token.id)).toEqual([firstStoredToken.id])

    await api
      .post('/api/auth/reset-password')
      .send({ token: firstRawToken, password: 'recovered-after-smtp-failure' })
      .expect(200)
  })

  it('serializes two successful concurrent requests to one final active token', async () => {
    const { user } = await createTestUser('reset-mail-concurrent-success@test.local')
    const gatedMailer = new GatedMailer(['success', 'success'])
    __setMailerForTesting(gatedMailer)

    const attempts = Promise.all([
      api.post('/api/auth/forgot-password').send({ email: user.email }),
      api.post('/api/auth/forgot-password').send({ email: user.email }),
    ])
    await gatedMailer.waitForSent(2)

    const pending = await prisma.passwordResetToken.findMany({ where: { userId: user.id } })
    expect(pending).toHaveLength(2)
    expect(pending.every(token => token.used)).toBe(true)

    const holder = holdPasswordResetIssuanceLock(user.id)
    await holder.held
    gatedMailer.releaseAll()
    try {
      await waitForAdvisoryLockWaiters(2)
    } finally {
      holder.release()
    }
    await holder.transaction

    const responses = await attempts
    expect(responses.map(response => response.status)).toEqual([200, 200])

    const sentRawTokens = gatedMailer.sent.map(rawTokenFrom)
    const tokens = await prisma.passwordResetToken.findMany({ where: { userId: user.id } })
    const activeTokens = tokens.filter(token => !token.used)
    expect(activeTokens).toHaveLength(1)
    expect(sentRawTokens.map(tokenHash)).toContain(activeTokens[0].tokenHash)

    const activeRawToken = sentRawTokens.find(raw => tokenHash(raw) === activeTokens[0].tokenHash)!
    const inactiveRawToken = sentRawTokens.find(raw => raw !== activeRawToken)!
    await api
      .post('/api/auth/reset-password')
      .send({ token: inactiveRawToken, password: 'inactive-concurrent-link' })
      .expect(400)
    await api
      .post('/api/auth/reset-password')
      .send({ token: activeRawToken, password: 'active-concurrent-link' })
      .expect(200)
  })

  it('keeps the successful concurrent request authoritative when the other delivery fails', async () => {
    const { user } = await createTestUser('reset-mail-concurrent-mixed@test.local')
    await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200)
    const oldRawToken = rawTokenFrom(mailer.lastTo(user.email)!)
    const oldStoredToken = await prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id, used: false },
    })

    const gatedMailer = new GatedMailer(['success', 'failure'])
    __setMailerForTesting(gatedMailer)
    const attempts = Promise.all([
      api.post('/api/auth/forgot-password').send({ email: user.email }),
      api.post('/api/auth/forgot-password').send({ email: user.email }),
    ])
    await gatedMailer.waitForSent(2)

    const holder = holdPasswordResetIssuanceLock(user.id)
    await holder.held
    gatedMailer.releaseAll()
    try {
      await waitForAdvisoryLockWaiters(1)
    } finally {
      holder.release()
    }
    await holder.transaction

    const responses = await attempts
    expect(responses.map(response => response.status)).toEqual([200, 200])

    const successfulRawToken = rawTokenFrom(gatedMailer.sent[0])
    const failedRawToken = rawTokenFrom(gatedMailer.sent[1])
    const activeTokens = await prisma.passwordResetToken.findMany({
      where: { userId: user.id, used: false },
    })
    expect(activeTokens).toHaveLength(1)
    expect(activeTokens[0].tokenHash).toBe(tokenHash(successfulRawToken))
    expect(activeTokens[0].id).not.toBe(oldStoredToken.id)

    await api
      .post('/api/auth/reset-password')
      .send({ token: oldRawToken, password: 'old-link-must-be-invalid' })
      .expect(400)
    await api
      .post('/api/auth/reset-password')
      .send({ token: failedRawToken, password: 'failed-link-must-be-invalid' })
      .expect(400)
    await api
      .post('/api/auth/reset-password')
      .send({ token: successfulRawToken, password: 'successful-link-remains-valid' })
      .expect(200)
  })

  it('rolls back old-token invalidation when activation fails after mail delivery', async () => {
    const { user } = await createTestUser('reset-mail-db-failure@test.local')
    await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200)
    const oldRawToken = rawTokenFrom(mailer.lastTo(user.email)!)
    const oldStoredToken = await prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id, used: false },
    })

    const gatedMailer = new GatedMailer(['success'])
    __setMailerForTesting(gatedMailer)
    const attempt = Promise.resolve(api.post('/api/auth/forgot-password').send({ email: user.email }))
    await gatedMailer.waitForSent(1)
    const newRawToken = rawTokenFrom(gatedMailer.sent[0])

    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS reject_test_reset_activation ON "PasswordResetToken"'
    )
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS reject_test_reset_activation()')
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION reject_test_reset_activation()
      RETURNS trigger AS $$
      BEGIN
        IF OLD."used" = true AND NEW."used" = false THEN
          RAISE EXCEPTION 'controlled password reset activation failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)

    let response
    try {
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER reject_test_reset_activation
        BEFORE UPDATE OF "used" ON "PasswordResetToken"
        FOR EACH ROW EXECUTE FUNCTION reject_test_reset_activation()
      `)
      gatedMailer.releaseAll()
      response = await attempt
    } finally {
      gatedMailer.releaseAll()
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS reject_test_reset_activation ON "PasswordResetToken"'
      )
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS reject_test_reset_activation()')
    }

    expect(response!.status).toBe(200)
    const activeTokens = await prisma.passwordResetToken.findMany({
      where: { userId: user.id, used: false },
    })
    expect(activeTokens.map(token => token.id)).toEqual([oldStoredToken.id])

    await api
      .post('/api/auth/reset-password')
      .send({ token: newRawToken, password: 'new-db-failed-link' })
      .expect(400)
    await api
      .post('/api/auth/reset-password')
      .send({ token: oldRawToken, password: 'old-db-recovery-link' })
      .expect(200)
  })

  it('keeps a failed-delivery candidate unusable even when compensating deletion fails', async () => {
    const { user } = await createTestUser('reset-mail-cleanup-failure@test.local')
    await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200)
    const oldRawToken = rawTokenFrom(mailer.lastTo(user.email)!)
    const oldStoredToken = await prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id, used: false },
    })

    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS reject_test_reset_candidate_delete ON "PasswordResetToken"'
    )
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS reject_test_reset_candidate_delete()')
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION reject_test_reset_candidate_delete()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'controlled password reset candidate delete failure';
      END;
      $$ LANGUAGE plpgsql
    `)

    const failingMailer = new FailingMailer()
    __setMailerForTesting(failingMailer)
    try {
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER reject_test_reset_candidate_delete
        BEFORE DELETE ON "PasswordResetToken"
        FOR EACH ROW EXECUTE FUNCTION reject_test_reset_candidate_delete()
      `)
      await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200)
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS reject_test_reset_candidate_delete ON "PasswordResetToken"'
      )
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS reject_test_reset_candidate_delete()')
    }

    const tokens = await prisma.passwordResetToken.findMany({ where: { userId: user.id } })
    expect(tokens.filter(token => !token.used).map(token => token.id)).toEqual([oldStoredToken.id])
    expect(tokens.find(token => token.tokenHash === tokenHash(failingMailer.rawToken!))?.used).toBe(true)

    await api
      .post('/api/auth/reset-password')
      .send({ token: failingMailer.rawToken, password: 'cleanup-failed-candidate' })
      .expect(400)
    await api
      .post('/api/auth/reset-password')
      .send({ token: oldRawToken, password: 'cleanup-failed-old-link' })
      .expect(200)
  })

  it('does not reactivate a pending issuance after an older link already reset the password', async () => {
    const { user } = await createTestUser('reset-mail-password-race@test.local')
    await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200)
    const oldRawToken = rawTokenFrom(mailer.lastTo(user.email)!)

    const gatedMailer = new GatedMailer(['success'])
    __setMailerForTesting(gatedMailer)
    const issuance = Promise.resolve(api.post('/api/auth/forgot-password').send({ email: user.email }))
    await gatedMailer.waitForSent(1)
    const pendingRawToken = rawTokenFrom(gatedMailer.sent[0])

    await api
      .post('/api/auth/reset-password')
      .send({ token: oldRawToken, password: 'password-won-before-activation' })
      .expect(200)

    gatedMailer.releaseAll()
    const issuanceResponse = await issuance
    expect(issuanceResponse.status).toBe(200)
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id, used: false } })).toBe(0)
    await api
      .post('/api/auth/reset-password')
      .send({ token: pendingRawToken, password: 'must-not-reactivate' })
      .expect(400)
  })

  it('logs only a mail failure category even when the adapter error echoes the raw token', async () => {
    const { user } = await createTestUser('reset-mail-log-redaction@test.local')
    const failingMailer = new FailingMailer()
    __setMailerForTesting(failingMailer)
    const warnSpy = vi.spyOn(logger, 'warn')
    const errorSpy = vi.spyOn(logger, 'error')

    const response = await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200)

    expect(failingMailer.rawToken).toBeDefined()
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(failingMailer.rawToken)
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(failingMailer.rawToken)
    expect(JSON.stringify(response.body)).not.toContain(failingMailer.rawToken)
    expect(JSON.stringify(warnSpy.mock.calls)).toContain('EAUTH')
    expect(errorSpy).not.toHaveBeenCalled()
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(0)
  })
})
