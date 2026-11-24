import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { randomUUID } from 'node:crypto'
import { cp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import request from 'supertest'

const release = resolve(process.argv[2] ?? '')
const core = join(release, 'core')
const plugin = join(release, 'faka-bridge')
const url = process.env.TEST_DATABASE_URL
if (!url || !new URL(url).pathname.includes('monexus_test')) {
  throw new Error('Use a dedicated, already migrated monexus_test database')
}
process.env.DATABASE_URL = url
const load = file => import(pathToFileURL(join(core, 'dist', file)).href)
const { app } = await load('app.js')
const { prisma } = await load('lib/prisma.js')
const { createOrder, getOrderDetail } = await load('modules/orders/service.js')
const { cancelUnacceptedOrder } = await load('modules/orders/cancellation.js')
const { publishProduct } = await load('modules/catalog/productPublication.js')
const { ensureSeedCategories } = await load('modules/catalog/bootstrap.js')
const { optionalFulfillmentStatus, refreshOptionalFulfillment, setOptionalFulfillmentMounted } =
  await load('bootstrap/optionalFulfillment.js')

const childCode = `
  import { createInterface } from 'node:readline';
  import { prisma } from './dist/lib/prisma.js';
  import { optionalFulfillmentStatus, refreshOptionalFulfillment } from './dist/bootstrap/optionalFulfillment.js';
  for await (const line of createInterface({ input: process.stdin })) {
    await refreshOptionalFulfillment(true);
    process.stdout.write('plugin-status:' + JSON.stringify(optionalFulfillmentStatus()) + '\\n');
  }
  await prisma.$disconnect();
`

let child
try {
  assert.deepEqual(optionalFulfillmentStatus(), { id: 'faka_bridge', installed: false, mounted: false })
  const [schema] = await prisma.$queryRaw`
    SELECT to_regclass('"FakaBridgeTask"') IS NULL
       AND to_regclass('"XboardTrafficResetOperation"') IS NULL AS clean
  `
  assert.equal(schema.clean, true)
  await request(app).get('/api/faka-bridge/provision-email/bound').expect(404)

  const actor = await prisma.user.create({ data: { email: 'plugin-release-admin@example.test', password: 'fixture', role: 'admin' } })
  const buyer = await prisma.user.create({ data: { email: 'plugin-release-buyer@example.test', password: 'fixture', emailVerified: new Date() } })
  await prisma.pointAccount.create({ data: { userId: buyer.id, balance: 1_000 } })
  await ensureSeedCategories(actor.id)
  const category = await prisma.productCategory.findFirstOrThrow({ where: { label: '网络节点', status: 'active' } })
  const cover = 'https://example.test/smoke.png'

  async function makeProduct(mode) {
    const product = await prisma.product.create({ data: {
      name: `Pure core ${mode}`, type: category.label, categoryId: category.id,
      price: 100, imageUrl: cover, images: [cover], description: 'Standalone package fixture',
      status: 'draft', stock: 1, deliveryMode: mode, stockMode: 'limited',
    } })
    const offer = await prisma.offer.create({ data: {
      productId: product.id, name: 'default', isDefault: true, price: 100, stock: 1,
      deliveryMode: mode, stockMode: 'limited',
    } })
    if (mode === 'instant_inventory') await prisma.inventoryItem.create({
      data: { productId: product.id, offerId: offer.id, content: 'fixture delivery', status: 'available' },
    })
    assert.equal((await publishProduct(product.id)).product.status, 'active')
    return { product, offer }
  }

  const instant = await makeProduct('instant_inventory')
  const placed = await createOrder(buyer.id, instant.product.id, { offerId: instant.offer.id, expectedPrice: 100, idempotencyKey: randomUUID() })
  assert.equal((await getOrderDetail(placed.orderId, buyer.id)).delivery.content, 'fixture delivery')
  const manual = await makeProduct('manual_service')
  const pending = await createOrder(buyer.id, manual.product.id, { offerId: manual.offer.id, expectedPrice: 100, idempotencyKey: randomUUID() })
  assert.equal(await cancelUnacceptedOrder(pending.orderId, { kind: 'buyer', userId: buyer.id }), 'cancelled')
  assert.equal((await prisma.pointAccount.findUniqueOrThrow({ where: { userId: buyer.id } })).balance, 900)
  console.log('Core without plugin: publish, purchase, deliver and refund passed.')

  child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
    cwd: core, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, PROCESS_ROLE: 'worker' },
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  async function statusOnWorker() {
    child.stdin.write('status\n')
    for (;;) {
      const line = await lines.next()
      if (line.done) throw new Error('Worker process ended before returning status')
      if (line.value.startsWith('plugin-status:')) return JSON.parse(line.value.slice('plugin-status:'.length))
    }
  }
  assert.equal((await statusOnWorker()).installed, false)

  // Install data and files separately while both core processes stay running.
  await cp(join(plugin, 'prisma/faka-bridge.sql'), join(core, 'prisma/faka-bridge.sql'))
  const installer = join(core, 'scripts/install-faka-schema.mjs')
  await cp(join(plugin, 'scripts/install-faka-schema.mjs'), installer)
  for (let i = 0; i < 2; i++) execFileSync(process.execPath, [installer], { cwd: core, stdio: 'inherit' })
  await cp(join(plugin, 'dist'), join(core, 'dist'), { recursive: true })
  await refreshOptionalFulfillment(true)
  assert.equal(optionalFulfillmentStatus().mounted, false)

  await setOptionalFulfillmentMounted(true, actor.id)
  assert.equal(optionalFulfillmentStatus().mounted, true)
  assert.equal((await statusOnWorker()).mounted, true)
  await request(app).get('/api/faka-bridge/provision-email/bound').expect(401)

  await setOptionalFulfillmentMounted(false, actor.id)
  assert.equal((await statusOnWorker()).mounted, false)
  await request(app).get('/api/faka-bridge/provision-email/bound').expect(404)
  console.log('API and worker: independent runtime attach and safe detach passed.')
} finally {
  child?.stdin.end()
  await prisma.$disconnect()
}
