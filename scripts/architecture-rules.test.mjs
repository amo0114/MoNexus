import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkBoundaries, readDependencies } from './architecture-rules.mjs'

test('parses multiline imports, aliases, re-exports, and dynamic imports', () => {
  const dependencies = readDependencies(`
    import { one as two,\n three } from './a.js'
    export { four } from './b.js'
    export type { Five } from './types.js'
    import { type Six } from './other-types.js'
    const lazy = () => import('./lazy.js')
    // import { ignored } from './comment.js'
  `)
  assert.deepEqual(dependencies.map(({ specifier, runtime, dynamic }) => [specifier, Boolean(runtime), dynamic]), [
    ['./a.js', true, false], ['./b.js', true, false], ['./types.js', false, false],
    ['./other-types.js', false, false], ['./lazy.js', true, true],
  ])
})

test('rejects infrastructure importing domain code through a re-export', () => {
  const errors = checkBoundaries(new Map([
    ['server/src/lib/bridge.ts', "export { run } from '../modules/orders/service.js'"],
  ]))
  assert.match(errors.join('\n'), /infrastructure must not import/)
})

test('checks lazy imports and implementation imports of its own facade', () => {
  const errors = checkBoundaries(new Map([
    ['server/src/modules/merchant/offerService.ts', "const load = () => import('./service.js')"],
  ]))
  assert.match(errors.join('\n'), /own public service facade/)
})

test('allows merchant identity lookup but rejects self-service internals', () => {
  const file = 'server/src/modules/catalog/actors.ts'
  assert.deepEqual(checkBoundaries(new Map([[file, "import { lookup } from '../merchant/identity.js'"]])), [])
  assert.match(checkBoundaries(new Map([[file, "import { lookup } from '../merchant/profileService.js'"]])).join('\n'), /merchant self-service internals/)
})

test('rejects catalog importing the products read module but allows the reverse', () => {
  const errors = checkBoundaries(new Map([
    ['server/src/modules/catalog/productWrite.ts', "import { list } from '../products/service.js'"],
    ['server/src/modules/products/service.ts', "export const list = 1"],
  ]))
  assert.match(errors.join('\n'), /catalog must not import the products read module/)
  assert.deepEqual(checkBoundaries(new Map([
    ['server/src/modules/products/service.ts', "import { load } from '../catalog/assurance/service.js'"],
    ['server/src/modules/catalog/assurance/service.ts', "import type { Row } from '../../products/service.js'\nexport const load = 1"],
  ])), [])
})

test('rejects points importing chatbot but allows chatbot to use points', () => {
  const errors = checkBoundaries(new Map([
    ['server/src/modules/points/routes.ts', "import * as bot from '../chatbot/bindController.js'"],
    ['server/src/modules/chatbot/bindController.ts', "export const status = 1"],
  ]))
  assert.match(errors.join('\n'), /points must not import chatbot/)
  assert.deepEqual(checkBoundaries(new Map([
    ['server/src/modules/chatbot/checkinBridge.ts', "import { checkin } from '../points/service.js'"],
    ['server/src/modules/points/service.ts', "export const checkin = 1"],
  ])), [])
})

test('keeps pure policy dependencies separate from query services', () => {
  const errors = checkBoundaries(new Map([
    ['server/src/modules/merchantFinance/settlementPolicy.ts', "import { normalize } from '../orders/fulfillment.js'"],
  ]))
  assert.match(errors.join('\n'), /pure rules/)
  assert.match(checkBoundaries(new Map([
    ['server/src/modules/orders/statusPolicy.ts', "import { PrismaClient } from '@prisma/client'"],
  ])).join('\n'), /runtime packages/)
})

test('rejects static cycles and permits type-only reverse edges', () => {
  const sources = new Map([
    ['server/src/lib/a.ts', "import { b } from './b.js'"],
    ['server/src/lib/b.ts', "export { a } from './a.js'"],
  ])
  assert.match(checkBoundaries(sources).join('\n'), /dependency cycle/)
  sources.set('server/src/lib/b.ts', "import type { A } from './a.js'")
  assert.deepEqual(checkBoundaries(sources), [])
})

test('only wallet writes point balances and ledger rows', () => {
  assert.match(checkBoundaries(new Map([
    ['server/src/modules/orders/service.ts', 'await tx.pointLog.create({ data })'],
  ])).join('\n'), /outside wallet/)
  assert.deepEqual(checkBoundaries(new Map([
    ['server/src/modules/wallet/commands.ts', 'await tx.pointLog.create({ data })'],
  ])), [])
})

const check = (file, source) => checkBoundaries(new Map([[file, source]])).join('\n')

test('AG-01 rejects filtered relation counts but allows plain counts and groupBy', () => {
  const file = 'server/src/modules/products/service.ts'
  assert.match(check(file, "select: { _count: {\n  select: { inventory: { where: { status: 'available' } } },\n} }"), /AG-01/)
  assert.doesNotMatch(check(file, 'select: { _count: { select: { inventory: true } } }'), /AG-01/)
  assert.doesNotMatch(check(file, "prisma.inventoryItem.groupBy({ by: ['offerId'], _count: { _all: true } })"), /AG-01/)
})

test('AG-02 rejects host-local date APIs unless a timeZone is given', () => {
  const file = 'server/src/lib/report.ts'
  assert.match(check(file, 'const h = new Date().getHours()'), /AG-02 host-local date API getHours/)
  assert.match(check(file, "d.toLocaleString('zh-CN')"), /AG-02/)
  assert.doesNotMatch(check(file, "d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })"), /AG-02/)
  assert.doesNotMatch(check(file, 'const ms = d.getTime() + d.getUTCHours()'), /AG-02/)
  assert.doesNotMatch(check('server/src/lib/businessTime.ts', 'd.getHours()'), /AG-02/)
})

test('AG-03 requires a lease for interval loops outside reviewed row-claim workers', () => {
  const loop = 'timer = setInterval(() => void tick(), 60_000)'
  assert.match(check('server/src/modules/reports/cron.ts', loop), /AG-03/)
  assert.doesNotMatch(check('server/src/modules/reports/cron.ts', `import { defineLeasedCron } from '../../lib/leasedCron.js'\n${loop}`), /AG-03/)
  assert.doesNotMatch(check('server/src/lib/reportCron.ts', `import { acquireCronLeaseWithHeartbeat } from './cronLease.js'\n${loop}`), /AG-03/)
  assert.doesNotMatch(check('server/src/modules/orders/provisionCron.ts', loop), /AG-03/)
})

test('AG-04 requires awaits in async controllers to be inside try/catch', () => {
  const file = 'server/src/modules/orders/controller.ts'
  assert.match(check(file, 'export async function list(req, res, next) {\n  res.json(await load())\n}'), /AG-04/)
  assert.match(check(file, 'export const list = async (req, res, next) => { try { await a() } finally { await b() } }'), /AG-04/)
  assert.deepEqual(checkBoundaries(new Map([[file, [
    'export async function list(req, res, next) {',
    '  try { res.json(await load()) } catch (err) { await cleanup(); next(err) }',
    '  const later = async () => { await ignoredBecauseNested() }',
    '}',
  ].join('\n')]])), [])
})

test('AG-05 rejects a module joining a cycle but tolerates baseline cycles', () => {
  const grown = checkBoundaries(new Map([
    ['server/src/modules/shops/service.ts', "import { a } from '../storefront/service.js'"],
    ['server/src/modules/storefront/service.ts', "import { b } from '../shops/helpers.js'"],
    ['server/src/modules/shops/helpers.ts', 'export const b = 1'],
  ]))
  assert.match(grown.join('\n'), /AG-05 module dependency cycle grew: shops, storefront/)
  const baseline = checkBoundaries(new Map([
    ['server/src/modules/payment/service.ts', "import { a } from '../recharge/service.js'"],
    ['server/src/modules/recharge/service.ts', "import { b } from '../payment/helpers.js'"],
    ['server/src/modules/payment/helpers.ts', 'export const b = 1'],
  ]))
  assert.doesNotMatch(baseline.join('\n'), /AG-05/)
})

test('FE-01 only pages and the app root may import pages', () => {
  const page = ['src/pages/storePageCache.ts', 'export const x = 1']
  assert.match(checkBoundaries(new Map([page, ['src/stores/authStore.ts', "import { x } from '../pages/storePageCache'"]])).join('\n'), /FE-01/)
  assert.match(checkBoundaries(new Map([page, ['src/api/recharge.ts', "import type { X } from '../pages/storePageCache'"]])).join('\n'), /FE-01/)
  assert.deepEqual(checkBoundaries(new Map([page, ['src/App.tsx', "import { x } from './pages/storePageCache'"]])), [])
  assert.deepEqual(checkBoundaries(new Map([page, ['src/pages/StorePage.tsx', "import { x } from './storePageCache'"]])), [])
})

test('FE-02 HTTP client is used through api modules', () => {
  const client = ['src/api/client.ts', 'export default {}']
  assert.match(checkBoundaries(new Map([client, ['src/components/NewPanel.tsx', "import api from '../api/client'"]])).join('\n'), /FE-02/)
  assert.deepEqual(checkBoundaries(new Map([client, ['src/api/orders.ts', "import api from './client'"]])), [])
  assert.deepEqual(checkBoundaries(new Map([client, ['src/lib/webPush.ts', "import api from '../api/client'"]])), [])
})

test('FE-03 dates render through utils/datetime', () => {
  const file = 'src/components/OrderRow.tsx'
  assert.match(check(file, 'new Date(o.createdAt).toLocaleString()'), /FE-03/)
  assert.match(check(file, 'value.toLocaleDateString()'), /FE-03/)
  assert.match(check(file, "new Intl.DateTimeFormat('zh-CN', { month: 'short' })"), /FE-03/)
  assert.doesNotMatch(check(file, "points.toLocaleString('zh-CN')"), /FE-03/)
  assert.doesNotMatch(check(file, "new Date(x).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })"), /FE-03/)
  assert.doesNotMatch(check('src/utils/datetime.ts', "date.toLocaleDateString('zh-CN')"), /FE-03/)
})

test('frontend static cycles are rejected', () => {
  const errors = checkBoundaries(new Map([
    ['src/stores/authStore.ts', "import { a } from '../api/registry'"],
    ['src/api/registry.ts', "import { b } from '../stores/authStore'"],
  ]))
  assert.match(errors.join('\n'), /Static runtime dependency cycle: src\/api\/registry.ts, src\/stores\/authStore.ts/)
})
