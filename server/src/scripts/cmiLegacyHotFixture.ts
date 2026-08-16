import { prisma } from '../lib/prisma.js'

const MANAGED_DEMO_NAMES = [
  '稳定专线节点订阅 (30天)',
  'ChatGPT Plus 共享车位',
  'Netflix 4K 高级合租位',
  'Apple ID 美区全新空白号',
  '商家自营高速节点包',
]

async function main() {
  const mode = process.argv[2]
  if (mode !== 'prepare' && mode !== 'verify') {
    throw new Error('usage: cmiLegacyHotFixture.ts prepare|verify')
  }

  const rows = await prisma.product.findMany({
    where: { name: { in: MANAGED_DEMO_NAMES } },
    select: { id: true, name: true, isHot: true },
  })
  if (rows.length !== MANAGED_DEMO_NAMES.length) {
    throw new Error(`expected ${MANAGED_DEMO_NAMES.length} seed-managed demo products, found ${rows.length}`)
  }

  if (mode === 'prepare') {
    await prisma.product.updateMany({
      where: { id: { in: rows.map(row => row.id) } },
      data: { isHot: true },
    })
  }

  const hotCount = await prisma.product.count({
    where: { id: { in: rows.map(row => row.id) }, isHot: true },
  })
  console.log(`legacy_is_hot_${mode === 'prepare' ? 'before' : 'after'}=${hotCount}`)

  if (mode === 'prepare' && hotCount !== rows.length) {
    throw new Error(`fixture preparation expected ${rows.length} legacy hot rows, found ${hotCount}`)
  }
  if (mode === 'verify' && hotCount !== 0) {
    throw new Error(`seed cleanup left ${hotCount} legacy hot rows`)
  }
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : 'legacy isHot fixture failed')
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
