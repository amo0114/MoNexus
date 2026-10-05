import 'dotenv/config'
import { prisma } from '../lib/prisma.js'
import { backfillFakaOrderPayment, listFakaPaymentBackfillCandidates } from '../lib/fakaBridge/paymentBackfill.js'

const USAGE = 'tsx src/scripts/backfillFakaPayments.ts [--order-ids=123,456] [--limit=100] [--apply --operator=change-ticket]'

async function main() {
  const argumentsList = process.argv.slice(2)
  if (argumentsList.length === 1 && argumentsList[0] === '--help') {
    console.log(`${USAGE}\nDefault: read-only preview. Apply requires explicit order IDs and an operator reference.`)
    return
  }
  const recognizedArguments = /^(--apply|--order-ids=.+|--limit=\d+|--operator=.+)$/
  const argumentNames = argumentsList.map(argument => argument.split('=')[0])
  if (argumentsList.some(argument => !recognizedArguments.test(argument)) || new Set(argumentNames).size !== argumentsList.length) {
    throw new Error(USAGE)
  }
  const apply = argumentsList.includes('--apply')
  const orderIdsValue = argumentsList.find(argument => argument.startsWith('--order-ids='))?.slice('--order-ids='.length)
  const operator = argumentsList.find(argument => argument.startsWith('--operator='))?.slice('--operator='.length).trim()
  const limitValue = argumentsList.find(argument => argument.startsWith('--limit='))?.slice('--limit='.length)
  const limit = limitValue ? Number(limitValue) : 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Limit must be 1-1000')
  if (orderIdsValue && !/^[1-9]\d*(,[1-9]\d*)*$/.test(orderIdsValue)) throw new Error('Invalid order ID list')
  const explicitOrderIds = orderIdsValue ? [...new Set(orderIdsValue.split(',').map(Number))] : null
  if (explicitOrderIds?.some(orderId => !Number.isSafeInteger(orderId)) || (explicitOrderIds?.length ?? 0) > 1000) {
    throw new Error('Order IDs must be safe integers; at most 1000 per invocation')
  }
  if (apply && (!explicitOrderIds || !operator || operator.length > 160 || /[\x00-\x1f]/.test(operator))) {
    throw new Error('Apply requires --order-ids and --operator (1-160 characters)')
  }
  if (apply && limitValue) throw new Error('--limit is preview-only; apply uses explicit order IDs')

  await prisma.$connect()
  try {
    const orderIds = explicitOrderIds ?? await listFakaPaymentBackfillCandidates(limit)
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', selectedCount: orderIds.length, discoveryLimit: explicitOrderIds ? null : limit }))
    for (const orderId of orderIds) {
      try {
        const result = await backfillFakaOrderPayment(orderId, { apply, operator })
        console.log(JSON.stringify(result))
        if (apply && result.status === 'skipped' && result.reason !== 'no_active_reservation') process.exitCode = 1
      } catch {
        // Never echo database URLs or delivery/account data on a failure.
        console.error(JSON.stringify({ orderId, status: 'failed', reason: 'transaction_failed_review_before_retry' }))
        process.exitCode = 1
        break
      }
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(() => {
  console.error('Backfill command failed; use --help to check arguments and verify the database configuration')
  process.exitCode = 1
})
