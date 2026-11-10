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
    ['server/src/modules/orders/settlementPolicy.ts', "import { normalize } from './fulfillment.js'"],
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
