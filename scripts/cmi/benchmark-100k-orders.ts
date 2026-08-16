import { performance } from 'node:perf_hooks'
import { prisma } from '../../server/src/lib/prisma.js'
import { getSummary, getTimeseries } from '../../server/src/modules/dashboard/service.js'
import { getActiveNetworkNodeCategoryId } from '../../server/src/__tests__/catalogFixture.js'

const orderCount = 100_000
const samples = Number(process.env.CMI_BENCH_SAMPLES ?? 30)
if (!Number.isInteger(samples) || samples < 5) throw new Error('CMI_BENCH_SAMPLES must be an integer >= 5')

async function main() {
  const user = await prisma.user.create({ data: { email: 'cmi-bench-buyer@test.local', password: 'test-password', role: 'user' } })
  const merchantUser = await prisma.user.create({ data: { email: 'cmi-bench-merchant@test.local', password: 'test-password', role: 'merchant' } })
  const merchant = await prisma.merchant.create({
    data: { userId: merchantUser.id, name: 'CMI 100k Benchmark Merchant', status: 'active', commissionRate: 0.1, contactEmail: merchantUser.email, approvedAt: new Date() },
  })
  const product = await prisma.product.create({ data: { merchantId: merchant.id, name: 'CMI 100k Benchmark Product', type: 'network', categoryId: await getActiveNetworkNodeCategoryId(), price: 100, status: 'active', stock: orderCount } })
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  for (let offset = 0; offset < orderCount; offset += 10_000) {
    await prisma.order.createMany({
      data: Array.from({ length: Math.min(10_000, orderCount - offset) }, (_, index) => ({
        userId: user.id, merchantId: merchant.id, productId: product.id, price: 100 + ((offset + index) % 5),
        status: (offset + index) % 11 === 0 ? 'refunded' : 'delivered', commissionRate: 0.1, commissionAmount: 10,
        createdAt: new Date(today.getTime() - ((offset + index) % 30) * 86_400_000),
      })),
    })
  }

  const measure = async (fn: () => Promise<unknown>) => {
    const values: number[] = []
    for (let index = 0; index < samples; index += 1) {
      const started = performance.now()
      await fn()
      values.push(performance.now() - started)
    }
    values.sort((a, b) => a - b)
    const percentile = (p: number) => values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]
    return { count: values.length, p50: percentile(0.5), p95: percentile(0.95), max: values.at(-1) }
  }
  const summary = await measure(() => getSummary(merchant.id))
  const timeseries = await measure(() => getTimeseries(merchant.id, '30d'))
  console.log(JSON.stringify({ order_count: orderCount, samples, summary_ms: summary, timeseries_30d_ms: timeseries }))
}

try { await main() } finally { await prisma.$disconnect() }
