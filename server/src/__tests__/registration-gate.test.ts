import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { getSystemConfigValue } from '../lib/systemConfig.js'
import { isRegistrationEnabled, registerUser } from '../modules/auth/service.js'

const CONFIG_KEY = 'registrationEnabled'

/**
 * SystemConfig 不在 setup.ts 的 TRUNCATE 名单内：本套件必须自己清开关行，
 * 否则残留的 0 会让后续每一个注册相关套件莫名 403。
 */
async function clearRegistrationSwitch() {
  await prisma.systemConfig.deleteMany({ where: { key: CONFIG_KEY } })
}

async function loginAdmin(email: string) {
  const { user, password } = await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(user.email, password)
  return { user, accessToken }
}

function putSwitch(accessToken: string, value: unknown) {
  return api
    .put(`/api/admin/config/${CONFIG_KEY}`)
    .set(authHeader(accessToken))
    .send({ value } as Record<string, unknown>)
}

/** REG-03 点名的五张表：关闭态下它们必须一行都不增。 */
async function snapshotRowCounts() {
  const [users, pointAccounts, pointLogs, inviteRelations, refreshTokens] = await Promise.all([
    prisma.user.count(),
    prisma.pointAccount.count(),
    prisma.pointLog.count(),
    prisma.inviteRelation.count(),
    prisma.refreshToken.count(),
  ])
  return { users, pointAccounts, pointLogs, inviteRelations, refreshTokens }
}

describe('GET /api/auth/registration-status', () => {
  beforeEach(clearRegistrationSwitch)
  afterEach(clearRegistrationSwitch)

  it('defaults to enabled and never caches when the config row is absent', async () => {
    const res = await api.get('/api/auth/registration-status').expect(200)

    expect(res.body).toEqual({
      registrationEnabled: true,
      registrationAvailable: true,
      challenge: null,
    })
    expect(res.headers['cache-control']).toBe('no-store')
    // 公开接口只暴露兼容布尔和安全的 availability/challenge DTO，不得
    // 顺带泄漏其他 SystemConfig、Redis、Turnstile secret 或 SMTP 细节。
    expect(Object.keys(res.body)).toEqual([
      'registrationEnabled',
      'registrationAvailable',
      'challenge',
    ])
  })

  it('reflects the administrator switch without authentication', async () => {
    const { accessToken } = await loginAdmin('reg-status-admin@test.local')

    await putSwitch(accessToken, 0).expect(200)
    expect((await api.get('/api/auth/registration-status').expect(200)).body).toEqual({
      registrationEnabled: false,
      registrationAvailable: false,
      challenge: null,
    })

    await putSwitch(accessToken, 1).expect(200)
    expect((await api.get('/api/auth/registration-status').expect(200)).body).toEqual({
      registrationEnabled: true,
      registrationAvailable: true,
      challenge: null,
    })
  })

  it('treats a hand-corrupted value as disabled (C2 fail-closed)', async () => {
    // API 拒绝 2，但运维直连数据库改坏是现实场景：读取侧必须 fail-closed。
    await prisma.systemConfig.create({ data: { key: CONFIG_KEY, value: 2 } })

    expect(await isRegistrationEnabled()).toBe(false)
    expect((await api.get('/api/auth/registration-status').expect(200)).body).toEqual({
      registrationEnabled: false,
      registrationAvailable: false,
      challenge: null,
    })
  })
})

describe('registration gate (REG-03)', () => {
  beforeEach(clearRegistrationSwitch)
  afterEach(clearRegistrationSwitch)

  it('keeps registration working with the default row absent', async () => {
    const { user: inviter } = await createTestUser('gate-default-inviter@test.local', 'pass123', 'user', 0)

    const res = await api
      .post('/api/auth/register')
      .send({
        email: 'gate-default@test.local',
        password: 'pass123',
        inviteCode: inviter.inviteCode,
      })
      .expect(201)

    expect(res.body.user.points).toBe(config.registerReward)
    expect(res.body.accessToken).toBeTruthy()
    // 邀请语义不变：邀请人拿到奖励，关系落库。
    const relation = await prisma.inviteRelation.findFirstOrThrow({ where: { inviterId: inviter.id } })
    expect(relation.inviteeId).toBe(res.body.user.id)
    const inviterAccount = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: inviter.id } })
    expect(inviterAccount.balance).toBe(config.inviteReward)
  })

  it('keeps registration working after the switch is explicitly enabled', async () => {
    const { accessToken } = await loginAdmin('gate-enabled-admin@test.local')
    await putSwitch(accessToken, 1).expect(200)

    const res = await api
      .post('/api/auth/register')
      .send({ email: 'gate-enabled@test.local', password: 'pass123' })
      .expect(201)
    expect(res.body.user.email).toBe('gate-enabled@test.local')
  })

  it('rejects registration with 403 and zero side effects once disabled (P.2)', async () => {
    const { accessToken } = await loginAdmin('gate-disabled-admin@test.local')
    const { user: inviter } = await createTestUser('gate-disabled-inviter@test.local', 'pass123', 'user', 0)
    await putSwitch(accessToken, 0).expect(200)

    // 生成的合法载荷集合：邀请码有 / 无 / 不存在三种变体，密码与邮箱长度各异。
    const payloads = Array.from({ length: 12 }, (_, i) => ({
      email: `gate-blocked-${i}-${'x'.repeat(i % 5)}@test.local`,
      password: 'p'.repeat(6 + (i % 7)),
      ...(i % 3 === 0
        ? {}
        : { inviteCode: i % 3 === 1 ? inviter.inviteCode : `NOPE-${i}` }),
    }))

    const before = await snapshotRowCounts()

    for (const payload of payloads) {
      const res = await api.post('/api/auth/register').send(payload).expect(403)

      expect(res.body.error.code).toBe('REGISTRATION_DISABLED')
      expect(res.body.error.message).toBe('当前已关闭新用户注册')
      expect(res.body.accessToken).toBeUndefined()
      expect(res.headers['set-cookie']).toBeUndefined()
    }

    expect(await snapshotRowCounts()).toEqual(before)
    // 连"该邮箱已注册"这类探测口子也不给：关闭态下查重根本没执行。
    expect(await prisma.user.findUnique({ where: { email: payloads[0].email } })).toBeNull()
  })

  it('enforces the gate at the service boundary, not only on the HTTP route (REG-04)', async () => {
    await prisma.systemConfig.create({ data: { key: CONFIG_KEY, value: 0 } })

    await expect(
      registerUser('gate-service-level@test.local', 'pass123')
    ).rejects.toMatchObject({ status: 403, code: 'REGISTRATION_DISABLED' })

    expect(await prisma.user.findUnique({ where: { email: 'gate-service-level@test.local' } })).toBeNull()
  })
})

describe('registrationEnabled validation (P.1)', () => {
  beforeEach(clearRegistrationSwitch)
  afterEach(clearRegistrationSwitch)

  it('accepts exactly the integers 0 and 1 and persists nothing otherwise', async () => {
    const { accessToken } = await loginAdmin('reg-validate-admin@test.local')

    const rejected: unknown[] = [-1, 2, 3, 42, 1.5, 0.5, -0.5, '1', '0', true, false, null, [], {}]
    for (const value of rejected) {
      await putSwitch(accessToken, value).expect(400)
      expect(await prisma.systemConfig.findUnique({ where: { key: CONFIG_KEY } })).toBeNull()
    }

    // 完全缺 value 字段同样是 400。
    await api
      .put(`/api/admin/config/${CONFIG_KEY}`)
      .set(authHeader(accessToken))
      .send({})
      .expect(400)
    expect(await prisma.systemConfig.findUnique({ where: { key: CONFIG_KEY } })).toBeNull()

    for (const value of [0, 1]) {
      const res = await putSwitch(accessToken, value).expect(200)
      expect(res.body).toMatchObject({ key: CONFIG_KEY, value, defaultValue: 1, group: '账户与注册' })
      expect((await prisma.systemConfig.findUniqueOrThrow({ where: { key: CONFIG_KEY } })).value).toBe(value)
    }
  })

  it('does not regress validation on the other numeric config keys', async () => {
    const { accessToken } = await loginAdmin('reg-validate-others@test.local')

    try {
      // 2 对布尔 key 非法，对普通数值 key 完全合法——key-aware 校验不能误伤。
      await api
        .put('/api/admin/config/checkinReward')
        .set(authHeader(accessToken))
        .send({ value: 2 })
        .expect(200)
      await api
        .put('/api/admin/config/autoProvisionMaxAttempts')
        .set(authHeader(accessToken))
        .send({ value: 6 })
        .expect(400)
      await api
        .put('/api/admin/config/memberTierGoldThreshold')
        .set(authHeader(accessToken))
        .send({ value: 500 })
        .expect(400)
    } finally {
      await prisma.systemConfig.deleteMany({
        where: { key: { in: ['checkinReward', 'autoProvisionMaxAttempts', 'memberTierGoldThreshold'] } },
      })
    }
  })
})

describe('registration switch authorization', () => {
  beforeEach(clearRegistrationSwitch)
  afterEach(clearRegistrationSwitch)

  it('keeps the switch behind admin MFA while the public status stays open', async () => {
    const { user: admin } = await loginAdmin('reg-authz-admin@test.local')
    await createTestUser('reg-authz-user@test.local', 'pass123', 'user')
    const normalUser = await loginAs('reg-authz-user@test.local', 'pass123')
    const session = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: admin.id, revoked: false },
      orderBy: { id: 'desc' },
    })
    // 有 admin 角色但缺 MFA 声明的 token：必须被 requireAdminMfa 挡下。
    const adminWithoutMfa = jwt.sign(
      { userId: admin.id, role: 'admin', sid: session.sessionId },
      config.jwtSecret,
      { expiresIn: '15m' }
    )

    await api.get('/api/admin/config').expect(401)
    await api.put(`/api/admin/config/${CONFIG_KEY}`).send({ value: 0 }).expect(401)
    await putSwitch(normalUser.accessToken, 0).expect(403)
    await api.get('/api/admin/config').set(authHeader(normalUser.accessToken)).expect(403)
    const mfaResult = await putSwitch(adminWithoutMfa, 0).expect(403)
    expect(mfaResult.body.error.code).toBe('MFA_REQUIRED')

    // 一次都没写进去。
    expect(await prisma.systemConfig.findUnique({ where: { key: CONFIG_KEY } })).toBeNull()
    await api.get('/api/auth/registration-status').expect(200)
  })
})

describe('registration switch round trip (P.3)', () => {
  beforeEach(clearRegistrationSwitch)
  afterEach(clearRegistrationSwitch)

  it('keeps DB row, service read, public status and admin list in agreement', async () => {
    const { accessToken } = await loginAdmin('reg-roundtrip-admin@test.local')

    // 删行 / 写 0 / 写 1 的任意交错序列。
    const sequence: Array<0 | 1 | 'delete'> = [1, 0, 0, 'delete', 0, 1, 'delete', 1, 0]

    for (const step of sequence) {
      if (step === 'delete') {
        await clearRegistrationSwitch()
      } else {
        await putSwitch(accessToken, step).expect(200)
      }

      const expectedValue = step === 'delete' ? 1 : step
      const row = await prisma.systemConfig.findUnique({ where: { key: CONFIG_KEY } })
      const listed = (await api.get('/api/admin/config').set(authHeader(accessToken)).expect(200)).body
        .find((item: { key: string }) => item.key === CONFIG_KEY)
      const status = (await api.get('/api/auth/registration-status').expect(200)).body

      expect(step === 'delete' ? row : row?.value).toEqual(step === 'delete' ? null : step)
      expect(await getSystemConfigValue(CONFIG_KEY)).toBe(expectedValue)
      expect(listed.value).toBe(expectedValue)
      expect(status.registrationEnabled).toBe(expectedValue === 1)
      expect(status.registrationAvailable).toBe(expectedValue === 1)
      expect(status.challenge).toBeNull()
    }
  })
})

describe('registration switch monotonicity (P.4 / REG-05)', () => {
  beforeEach(clearRegistrationSwitch)
  afterEach(clearRegistrationSwitch)

  it('blocks every registration started after the disable response, until re-enabled', async () => {
    const { accessToken } = await loginAdmin('reg-monotonic-admin@test.local')

    await api
      .post('/api/auth/register')
      .send({ email: 'monotonic-before@test.local', password: 'pass123' })
      .expect(201)

    await putSwitch(accessToken, 0).expect(200)
    for (let i = 0; i < 3; i++) {
      await api
        .post('/api/auth/register')
        .send({ email: `monotonic-during-${i}@test.local`, password: 'pass123' })
        .expect(403)
    }

    await putSwitch(accessToken, 1).expect(200)
    await api
      .post('/api/auth/register')
      .send({ email: 'monotonic-after@test.local', password: 'pass123' })
      .expect(201)
  })

  it('lets an in-flight registration that already passed the gate finish (REG-05)', async () => {
    // 门在 registerUser 第一步读完就放行，之后是 bcrypt（数百毫秒）+ 两个
    // 事务；在这段窗口里关开关，不撤销已经通过检查的请求。
    const inFlight = registerUser('inflight-registration@test.local', 'pass123')
      .then(result => ({ result, finishedAt: Date.now() }))

    await new Promise(resolve => setTimeout(resolve, 150))
    await prisma.systemConfig.upsert({
      where: { key: CONFIG_KEY },
      create: { key: CONFIG_KEY, value: 0 },
      update: { value: 0 },
    })
    const disabledAt = Date.now()

    const { result, finishedAt } = await inFlight
    expect(result.user.email).toBe('inflight-registration@test.local')
    // 断言这次交叠确实成立，否则上面的期望是空跑。
    expect(disabledAt).toBeLessThan(finishedAt)

    // 关闭生效之后开始的调用必须失败。
    await expect(registerUser('after-disable@test.local', 'pass123')).rejects.toMatchObject({
      code: 'REGISTRATION_DISABLED',
    })
  })
})
