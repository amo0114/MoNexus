import { prisma } from '../lib/prisma.js'
import { auditValuePolicies } from '../modules/valuePolicy/audit.js'

function parseSince(args: string[]): Date | undefined {
  const flag = args.find(arg => arg.startsWith('--since='))?.slice('--since='.length)
    ?? process.env.VALUE_POLICY_AUDIT_SINCE
  if (!flag) return undefined
  const since = new Date(flag)
  if (Number.isNaN(since.getTime())) {
    throw new Error('Usage: tsx src/scripts/auditValuePolicy.ts [--since=<ISO-8601>]')
  }
  return since
}

async function main() {
  const since = parseSince(process.argv.slice(2))
  await prisma.$connect()
  try {
    const report = await auditValuePolicies(prisma, { since })
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
