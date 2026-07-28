import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const fixtureEmailPrefix = 'm3-ish-e2e-'
const fixtureEmailSuffix = '@test.invalid'
const fixtureDatabaseName = 'monexus_m3_ish_test'

type FixturePrisma = {
  user: {
    create: (args: unknown) => Promise<{ id: number; email: string }>
    findMany: (args: unknown) => Promise<Array<{ id: number }>>
    deleteMany: (args: unknown) => Promise<unknown>
  }
  securityEvent: { deleteMany: (args: unknown) => Promise<unknown> }
  authChallenge: { deleteMany: (args: unknown) => Promise<unknown> }
  mfaRecoveryCode: { deleteMany: (args: unknown) => Promise<unknown> }
  refreshToken: { deleteMany: (args: unknown) => Promise<unknown> }
  $transaction: (operations: Promise<unknown>[]) => Promise<unknown>
  $disconnect: () => Promise<void>
}

type FixturePrismaConstructor = new (options: {
  datasources: { db: { url: string } }
}) => FixturePrisma

type Bcrypt = {
  hash: (value: string, rounds: number) => Promise<string>
}

function isolatedDatabaseUrl() {
  const value = process.env.M3_ISH_DATABASE_URL
  if (!value) throw new Error('M3_ISH_DATABASE_URL is required for M3-ISH real E2E fixtures')

  try {
    const url = new URL(value)
    const databaseName = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    if (databaseName !== fixtureDatabaseName) throw new Error('wrong database')
    return value
  } catch {
    throw new Error('M3-ISH real E2E fixtures require the isolated monexus_m3_ish_test database')
  }
}

const serverRequire = createRequire(new URL('../../server/package.json', import.meta.url))
const { PrismaClient } = serverRequire('@prisma/client') as { PrismaClient: FixturePrismaConstructor }
const bcrypt = serverRequire('bcryptjs') as Bcrypt
const prisma = new PrismaClient({ datasources: { db: { url: isolatedDatabaseUrl() } } })

export type M3IshAdminFixture = {
  userId: number
  email: string
  password: string
  cleanup: () => Promise<void>
}

function fixtureEmail() {
  return `${fixtureEmailPrefix}${randomUUID()}${fixtureEmailSuffix}`
}

async function cleanupUserIds(userIds: number[]) {
  if (userIds.length === 0) return

  const where = { userId: { in: userIds } }
  await prisma.$transaction([
    prisma.securityEvent.deleteMany({ where }),
    prisma.authChallenge.deleteMany({ where }),
    prisma.mfaRecoveryCode.deleteMany({ where }),
    prisma.refreshToken.deleteMany({ where }),
    prisma.user.deleteMany({
      where: {
        id: { in: userIds },
        email: { startsWith: fixtureEmailPrefix, endsWith: fixtureEmailSuffix },
      },
    }),
  ])
}

/** Only removes deliberately namespaced, short-lived real-E2E fixtures. */
export async function cleanupStaleM3IshFixtures() {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: fixtureEmailPrefix, endsWith: fixtureEmailSuffix } },
    select: { id: true },
  })
  await cleanupUserIds(users.map((user) => user.id))
}

/**
 * This is direct database setup, not an HTTP endpoint or application switch.
 * The fixture is scoped to the isolated database, carries a generated password
 * only in the Playwright process, and starts with MFA disabled so the browser
 * must exercise the real enrollment API.
 */
export async function createM3IshAdminFixture(): Promise<M3IshAdminFixture> {
  const password = randomBytes(32).toString('base64url')
  const email = fixtureEmail()
  const user = await prisma.user.create({
    data: {
      email,
      password: await bcrypt.hash(password, 12),
      role: 'admin',
    },
    select: { id: true, email: true },
  })

  return {
    userId: user.id,
    email: user.email,
    password,
    cleanup: () => cleanupUserIds([user.id]),
  }
}

export async function disconnectM3IshFixtureDb() {
  await prisma.$disconnect()
}
