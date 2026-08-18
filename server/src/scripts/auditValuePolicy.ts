import { prisma } from '../lib/prisma.js'
import { auditValuePolicies } from '../modules/valuePolicy/audit.js'

async function main() {
  await prisma.$connect()
  try {
    const report = await auditValuePolicies(prisma)
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 2
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Value policy audit failed')
  process.exitCode = 1
})
