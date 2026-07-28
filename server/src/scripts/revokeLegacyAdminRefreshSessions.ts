import { prisma } from '../lib/prisma.js'
import { revokeLegacyAdminRefreshSessions } from '../modules/auth/legacyAdminSessionRevocation.js'

function parseBeforeArg(args: string[]): Date {
  const value = args.find(arg => arg.startsWith('--before='))?.slice('--before='.length)
  const before = value ? new Date(value) : undefined

  if (!before || Number.isNaN(before.getTime())) {
    throw new Error('Usage: tsx src/scripts/revokeLegacyAdminRefreshSessions.ts --before=<ISO-8601 deployment cutoff>')
  }

  return before
}

async function main() {
  const before = parseBeforeArg(process.argv.slice(2))
  await prisma.$connect()
  try {
    const revokedCount = await revokeLegacyAdminRefreshSessions({ before })
    console.log(JSON.stringify({ revokedCount, before: before.toISOString() }))
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Legacy admin session revocation failed')
  process.exitCode = 1
})
