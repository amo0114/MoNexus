import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { TOTP } from 'otpauth'
import { prisma } from '../lib/prisma.js'
import { encryptMfaSecret } from '../modules/auth/mfa.js'
import {
  STAGING_D02_RECORD_REF,
  STAGING_D02_RECORD_SHA256,
  STAGING_D03_RECORD_REF,
  STAGING_D03_RECORD_SHA256,
  STAGING_DISCLOSURE_VERSION,
  assertStagingGovernanceEnvironment,
  parseStagingGovernanceInput,
  type StagingGovernanceInput,
} from '../modules/valuePolicy/stagingGovernanceInput.js'

const MAX_STDIN_BYTES = 16 * 1024
const LOCAL_API_ORIGIN = 'http://127.0.0.1:3000'

class StagingGovernanceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StagingGovernanceError'
  }
}

async function readJsonStdin(): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_STDIN_BYTES) throw new StagingGovernanceError('staging governance input is too large')
    chunks.push(buffer)
  }
  if (total === 0) throw new StagingGovernanceError('staging governance input is required')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new StagingGovernanceError('staging governance input is invalid JSON')
  }
}

async function provisionActor(actor: StagingGovernanceInput['maker']) {
  const passwordHash = await bcrypt.hash(actor.password, 10)
  const mfaSecretEncrypted = encryptMfaSecret(actor.totpSecret)
  const now = new Date()

  return prisma.$transaction(async tx => {
    const existing = await tx.user.findUnique({ where: { email: actor.email } })
    const user = existing
      ? await tx.user.update({
          where: { id: existing.id },
          data: {
            password: passwordHash,
            role: 'admin',
            status: '正常',
            emailVerified: existing.emailVerified ?? now,
            mfaEnabled: true,
            mfaSecretEncrypted,
            mfaVerifiedAt: now,
            mfaVersion: { increment: 1 },
          },
        })
      : await tx.user.create({
          data: {
            email: actor.email,
            password: passwordHash,
            role: 'admin',
            status: '正常',
            emailVerified: now,
            mfaEnabled: true,
            mfaSecretEncrypted,
            mfaVerifiedAt: now,
            mfaVersion: 0,
          },
        })

    await tx.refreshToken.updateMany({
      where: { userId: user.id, revoked: false },
      data: { revoked: true, revokedAt: now, revokeReason: 'staging_value_policy_actor_rotation' },
    })
    await tx.authChallenge.deleteMany({ where: { userId: user.id } })
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } })
    return { id: user.id, email: user.email }
  })
}

function currentTotp(secret: string, email: string): string {
  return new TOTP({
    issuer: 'MoNexus',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  }).generate({ timestamp: Date.now() })
}

async function postJson(path: string, body: unknown, options: { token?: string; idempotencyKey?: string } = {}) {
  const response = await fetch(`${LOCAL_API_ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  return { response, payload }
}

async function loginWithMfa(actor: StagingGovernanceInput['maker']): Promise<string> {
  const login = await postJson('/api/auth/login', { email: actor.email, password: actor.password })
  if (login.response.status !== 202 || login.payload?.status !== 'mfa_required' || typeof login.payload.challengeId !== 'string') {
    throw new StagingGovernanceError(`administrator MFA login challenge failed (${login.response.status})`)
  }
  const verified = await postJson('/api/auth/mfa/verify', {
    challengeId: login.payload.challengeId,
    method: 'totp',
    code: currentTotp(actor.totpSecret, actor.email),
  })
  if (verified.response.status !== 200 || typeof verified.payload?.accessToken !== 'string') {
    throw new StagingGovernanceError(`administrator MFA verification failed (${verified.response.status})`)
  }
  return verified.payload.accessToken
}

function requirePolicyResult(result: Awaited<ReturnType<typeof postJson>>, allowedStatuses: number[]) {
  if (!allowedStatuses.includes(result.response.status)) {
    throw new StagingGovernanceError(`ValuePolicy governance command failed (${result.response.status})`)
  }
  const policy = result.payload?.policy
  if (typeof policy !== 'object' || policy === null) {
    throw new StagingGovernanceError('ValuePolicy governance response did not contain a policy')
  }
  return policy as Record<string, unknown>
}

async function runSchedule(input: StagingGovernanceInput, makerToken: string, checkerToken: string) {
  const create = await postJson('/api/admin/value-policies', {
    id: input.policy.id,
    version: input.policy.version,
    referenceAtomicPerPointNumerator: '1',
    referenceAtomicPerPointDenominator: '1',
    effectiveAt: input.policy.effectiveAt,
    d02DecisionRecordRef: STAGING_D02_RECORD_REF,
    d02DecisionRecordSha256: STAGING_D02_RECORD_SHA256,
    d03DecisionRecordRef: STAGING_D03_RECORD_REF,
    d03DecisionRecordSha256: STAGING_D03_RECORD_SHA256,
    disclosureVersion: STAGING_DISCLOSURE_VERSION,
    reason: 'Create approved 100 PTS per CNY staging rehearsal policy',
  }, { token: makerToken, idempotencyKey: `${input.policy.id}:create:v1` })
  requirePolicyResult(create, [200, 201])

  const approve = await postJson(`/api/admin/value-policies/${input.policy.id}/approve`, {
    reason: 'Independent staging checker approval for the owner-approved decision records',
  }, { token: checkerToken, idempotencyKey: `${input.policy.id}:approve:v1` })
  requirePolicyResult(approve, [200])

  const schedule = await postJson(`/api/admin/value-policies/${input.policy.id}/schedule`, {
    reason: 'Schedule the staging rehearsal after maker-checker approval',
  }, { token: checkerToken, idempotencyKey: `${input.policy.id}:schedule:v1` })
  return requirePolicyResult(schedule, [200])
}

async function runActivate(input: StagingGovernanceInput, checkerToken: string) {
  const activate = await postJson(`/api/admin/value-policies/${input.policy.id}/activate`, {
    reason: 'Activate the due staging policy before enabling shadow mode',
  }, { token: checkerToken, idempotencyKey: `${input.policy.id}:activate:v1` })
  return requirePolicyResult(activate, [200])
}

async function main() {
  assertStagingGovernanceEnvironment({
    nodeEnv: process.env.NODE_ENV,
    deployEnv: process.env.MONEXUS_DEPLOY_ENV,
    databaseUrl: process.env.DATABASE_URL,
  })
  const input = parseStagingGovernanceInput(await readJsonStdin())

  const maker = await provisionActor(input.maker)
  const checker = await provisionActor(input.checker)
  if (maker.id === checker.id) throw new StagingGovernanceError('maker and checker resolved to the same user')

  const makerToken = await loginWithMfa(input.maker)
  const checkerToken = await loginWithMfa(input.checker)
  const policy = input.operation === 'schedule'
    ? await runSchedule(input, makerToken, checkerToken)
    : await runActivate(input, checkerToken)

  process.stdout.write(`${JSON.stringify({
    operation: input.operation,
    makerUserId: maker.id,
    checkerUserId: checker.id,
    policy: {
      id: policy.id,
      version: policy.version,
      status: policy.status,
      effectiveAt: policy.effectiveAt,
      createdByUserId: policy.createdByUserId,
      approvedByUserId: policy.approvedByUserId,
      scheduledByUserId: policy.scheduledByUserId,
      activatedByUserId: policy.activatedByUserId,
    },
  })}\n`)
}

main()
  .catch(error => {
    const message = error instanceof StagingGovernanceError
      ? error.message
      : 'ValuePolicy staging governance failed closed'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
