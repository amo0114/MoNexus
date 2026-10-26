import { parseArgs } from 'node:util'
import { runAccountBackfill } from '../modules/xboardAccounts/backfill.js'
import { prisma } from '../lib/prisma.js'

try {
  const { values } = parseArgs({ options: {
    apply: { type: 'boolean', default: false }, limit: { type: 'string' },
    'after-user-id': { type: 'string' }, 'after-task-id': { type: 'string' },
  }, strict: true, allowPositionals: false })
  function integer(value: string | undefined) {
    if (value === undefined) return undefined
    if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('invalid integer')
    return Number(value)
  }
  console.log(JSON.stringify(await runAccountBackfill({ apply: values.apply, limit: integer(values.limit),
    afterUserId: integer(values['after-user-id']), afterTaskId: integer(values['after-task-id']) })))
} catch {
  console.error('Xboard account backfill failed; check configuration, dependencies and cursor arguments. No account data is printed.')
  process.exitCode = 1
} finally { await prisma.$disconnect() }
