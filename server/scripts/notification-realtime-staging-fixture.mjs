#!/usr/bin/env node
/**
 * SPEC-NOTIFY-RT-001 — staging-only synthetic fixture lifecycle.
 *
 * This script is streamed into the already-running staging server container;
 * it is never used by the application process. Creation emits credential-free
 * metadata on stdout. The workflow authenticates through the real login API,
 * so no JWT or password is written into the fixture snapshot. Cleanup discovers
 * only the exact run namespace, checks every order belongs to that fixture, and
 * deletes the fixture transactionally.
 *
 * Required environment:
 *   RT_STAGING_FIXTURE_CONFIRM=monexus-staging-notification-realtime
 *   RT_STAGING_RUN_ID=<GitHub run id/attempt namespace>
 *   RT_STAGING_FIXTURE_MODE=create|cleanup
 *   RT_STAGING_HEAD=<40 character feature commit>
 *   RT_STAGING_FIXTURE_PASSWORD=<random workflow-only password> (create only)
 */

const CONFIRMATION = 'monexus-staging-notification-realtime'
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const SHA_RE = /^[0-9a-f]{40}$/

function assertRunId(value) {
  if (!RUN_ID_RE.test(value ?? '')) throw new Error('invalid staging fixture run id')
  return value
}

function assertStagingDatabase(databaseUrl) {
  let parsed
  try {
    parsed = new URL(databaseUrl)
  } catch {
    throw new Error('invalid staging database configuration')
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('staging fixture requires PostgreSQL')
  }
  // The isolated staging Compose stack always reaches its private database by
  // the service name `postgres`.  Refuse external/direct production endpoints.
  if (parsed.hostname !== 'postgres') {
    throw new Error('staging fixture requires the isolated Compose database')
  }
}

if (process.argv.includes('--self-test')) {
  assertRunId('31300000000.1')
  assertStagingDatabase('postgresql://fixture:redacted@postgres:5432/monexus_staging?schema=public')
  const rejected = [
    () => assertRunId('../escape'),
    () => assertRunId(''),
    () => assertStagingDatabase('postgresql://fixture:redacted@production-db.example/monexus'),
  ]
  if (rejected.some((candidate) => {
    try {
      candidate()
      return true
    } catch {
      return false
    }
  })) process.exit(1)
  console.log('[PASS] staging fixture safety self-test')
  process.exit(0)
}

if (process.env.RT_STAGING_FIXTURE_CONFIRM !== CONFIRMATION) {
  throw new Error('staging fixture confirmation is missing')
}

const mode = process.env.RT_STAGING_FIXTURE_MODE
if (mode !== 'create' && mode !== 'cleanup') throw new Error('invalid staging fixture mode')
const runId = assertRunId(process.env.RT_STAGING_RUN_ID)
const head = process.env.RT_STAGING_HEAD ?? ''
if (!SHA_RE.test(head)) throw new Error('staging fixture requires a full commit SHA')
assertStagingDatabase(process.env.DATABASE_URL ?? '')

const namespace = `rt-stage-${runId}`
const merchantEmail = `${namespace}-merchant@fixture.invalid`
const buyerEmail = `${namespace}-buyer@fixture.invalid`
const productName = `${namespace}-manual-product`
const expectedSamples = Number.parseInt(process.env.RT_STAGING_SAMPLE_COUNT ?? '100', 10)
if (!Number.isSafeInteger(expectedSamples) || expectedSamples < 100 || expectedSamples > 120) {
  throw new Error('staging fixture sample count must be between 100 and 120')
}

const [{ PrismaClient }, bcryptModule] = await Promise.all([
  import('@prisma/client'),
  import('bcryptjs'),
])
const bcrypt = bcryptModule.default
const prisma = new PrismaClient()

async function createFixture() {
  const password = process.env.RT_STAGING_FIXTURE_PASSWORD ?? ''
  if (password.length < 20) throw new Error('staging fixture password is missing or too short')

  const [existingUsers, existingProducts] = await Promise.all([
    prisma.user.count({ where: { email: { in: [merchantEmail, buyerEmail] } } }),
    prisma.product.count({ where: { name: productName } }),
  ])
  if (existingUsers !== 0 || existingProducts !== 0) {
    throw new Error('staging fixture namespace already exists; cleanup it before retrying')
  }

  const hashed = await bcrypt.hash(password, 10)
  const fixture = await prisma.$transaction(async (tx) => {
    const merchantUser = await tx.user.create({
      data: {
        email: merchantEmail,
        password: hashed,
        role: 'merchant',
        nickname: `RT staging merchant ${runId.slice(-8)}`,
      },
    })
    const merchant = await tx.merchant.create({
      data: {
        userId: merchantUser.id,
        name: `RT staging merchant ${runId.slice(-8)}`,
        status: 'active',
        commissionRate: 0.1,
        contactEmail: merchantEmail,
        approvedAt: new Date(),
      },
    })
    const capacity = expectedSamples + 10
    const product = await tx.product.create({
      data: {
        name: productName,
        description: 'Disposable notification realtime staging canary fixture',
        type: '网络节点',
        price: 100,
        status: 'active',
        stock: capacity,
        deliveryMode: 'manual_service',
        stockMode: 'limited',
        merchantId: merchant.id,
      },
    })
    const offer = await tx.offer.create({
      data: {
        productId: product.id,
        name: 'Staging canary manual service',
        isDefault: true,
        price: 100,
        stock: capacity,
        stockMode: 'limited',
        deliveryMode: 'manual_service',
      },
    })
    const buyer = await tx.user.create({
      data: {
        email: buyerEmail,
        password: hashed,
        role: 'user',
        nickname: `RT staging buyer ${runId.slice(-8)}`,
      },
    })
    await tx.pointAccount.create({
      data: { userId: buyer.id, balance: 100_000 },
    })
    return { merchantUser, merchant, product, offer, buyer }
  })

  console.log(JSON.stringify({
    runId,
    head,
    merchant: {
      userId: fixture.merchantUser.id,
      email: fixture.merchantUser.email,
    },
    buyer: {
      userId: fixture.buyer.id,
      email: fixture.buyer.email,
    },
    productId: fixture.product.id,
    offerId: fixture.offer.id,
    expectedPrice: 100,
  }))
}

async function cleanupFixture() {
  const merchantUser = await prisma.user.findUnique({ where: { email: merchantEmail } })
  const buyer = await prisma.user.findUnique({ where: { email: buyerEmail } })
  const products = await prisma.product.findMany({ where: { name: productName }, take: 2 })
  if (products.length > 1) throw new Error('ambiguous staging fixture product namespace')
  const product = products[0] ?? null
  if (!merchantUser && !buyer && !product) {
    console.log(JSON.stringify({ runId, head, result: 'ALREADY_CLEAN' }))
    return
  }
  if (!merchantUser || !buyer || !product) throw new Error('partial staging fixture requires manual review')
  const merchant = await prisma.merchant.findUnique({ where: { userId: merchantUser.id } })
  if (!merchant || product.merchantId !== merchant.id) throw new Error('staging fixture ownership mismatch')
  const offers = await prisma.offer.findMany({ where: { productId: product.id, isDefault: true }, take: 2 })
  if (offers.length !== 1) throw new Error('staging fixture default offer is missing or ambiguous')
  const [offer] = offers

  await prisma.$transaction(async (tx) => {
    const orders = await tx.order.findMany({
      where: {
        OR: [
          { userId: buyer.id },
          { productId: product.id },
          { offerId: offer.id },
          { merchantId: merchant.id },
        ],
      },
      select: {
        id: true,
        userId: true,
        productId: true,
        offerId: true,
        merchantId: true,
        renewalOfOrderId: true,
      },
    })
    if (orders.length > expectedSamples + 5) throw new Error('staging fixture order bound exceeded')
    if (orders.some((order) => (
      order.userId !== buyer.id
      || order.productId !== product.id
      || order.offerId !== offer.id
      || order.merchantId !== merchant.id
      || order.renewalOfOrderId !== null
    ))) {
      throw new Error('staging fixture order ownership mismatch')
    }
    const orderIds = orders.map(({ id }) => id)

    // Every delete is constrained by IDs whose complete ownership tuple was
    // checked above.  The order is deliberate: several audit relations use
    // Restrict and must be removed before the synthetic parent row.
    if (orderIds.length > 0) {
      const ids = { in: orderIds }
      const renewalCount = await tx.order.count({ where: { renewalOfOrderId: ids } })
      if (renewalCount !== 0) {
        throw new Error('staging fixture order has a renewal reference; refusing cleanup')
      }
      const attachedDelivery = await tx.deliveryRecord.findFirst({
        where: { orderId: ids, fileId: { not: null } },
        select: { id: true },
      })
      if (attachedDelivery) {
        throw new Error('staging fixture has a delivery file; object cleanup requires manual review')
      }
      await tx.orderAgreementAcceptance.deleteMany({ where: { orderId: ids } })
      await tx.fileGrantLog.deleteMany({ where: { orderId: ids } })
      await tx.subscriptionReminder.deleteMany({ where: { orderId: ids } })
      await tx.bookingReminder.deleteMany({ where: { orderId: ids } })
      await tx.slaReminder.deleteMany({ where: { orderId: ids } })
      await tx.fakaBridgeTask.deleteMany({ where: { orderId: ids } })
      await tx.provisionTask.deleteMany({ where: { orderId: ids } })
      await tx.deliveryRecord.deleteMany({ where: { orderId: ids } })
      await tx.review.deleteMany({ where: { orderId: ids } })
      await tx.inventoryItem.deleteMany({ where: { orderId: ids } })
      await tx.inventoryLog.deleteMany({ where: { orderId: ids } })
      await tx.pointLog.deleteMany({ where: { orderId: ids } })
      await tx.orderStatusEvent.deleteMany({ where: { orderId: ids } })
      await tx.settlement.deleteMany({ where: { orderId: ids } })
      await tx.notification.deleteMany({ where: { relatedOrderId: ids } })
      await tx.order.deleteMany({ where: { id: ids } })
    }
    const fixtureUserIds = { in: [merchantUser.id, buyer.id] }
    await tx.refreshToken.deleteMany({ where: { userId: fixtureUserIds } })
    await tx.idempotencyRecord.deleteMany({ where: { userId: fixtureUserIds } })
    await tx.userAgreementConsent.deleteMany({ where: { userId: fixtureUserIds } })
    await tx.securityEvent.deleteMany({ where: { userId: fixtureUserIds } })
    await tx.lowStockNotice.deleteMany({ where: { offerId: offer.id } })
    await tx.inventoryLog.deleteMany({ where: { productId: product.id } })
    await tx.inventoryItem.deleteMany({ where: { productId: product.id } })
    await tx.offer.delete({ where: { id: offer.id } })
    await tx.product.delete({ where: { id: product.id } })
    await tx.pointAccount.deleteMany({ where: { userId: buyer.id } })
    await tx.merchant.delete({ where: { id: merchant.id } })
    await tx.user.deleteMany({ where: { id: { in: [merchantUser.id, buyer.id] } } })
  })

  console.log(JSON.stringify({ runId, head, result: 'CLEAN' }))
}

try {
  if (mode === 'create') await createFixture()
  else await cleanupFixture()
} finally {
  await prisma.$disconnect()
}
