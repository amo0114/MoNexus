import { pathToFileURL } from 'node:url'
import { prisma } from '../lib/prisma.js'
import { resetAdminMfaForBreakGlass } from '../modules/auth/service.js'

const CASE_REF_PATTERN = /^[A-Z][A-Z0-9_]{1,15}-[0-9]{1,12}$/

export type BreakGlassCommandInput = {
  userId: number
  caseRef: string
}

function usage(): never {
  throw new Error('Usage: npm --prefix server run auth:break-glass-reset -- --user-id=<positive-integer> --case-ref=<OPS-123>')
}

/**
 * Deliberately accepts only the two audited inputs. The service itself owns
 * every credential mutation; this offline runner must never accept a seed,
 * recovery code, password, token, arbitrary SQL, or free-form detail.
 */
export function parseBreakGlassCommandInput(args: string[]): BreakGlassCommandInput {
  if (args.length !== 2) usage()

  const values = new Map<string, string>()
  for (const arg of args) {
    const match = /^--(user-id|case-ref)=(.+)$/.exec(arg)
    if (!match || values.has(match[1])) usage()
    values.set(match[1], match[2])
  }

  const userIdRaw = values.get('user-id')
  const caseRef = values.get('case-ref')
  if (!userIdRaw || !caseRef || !/^\d+$/.test(userIdRaw)) usage()

  const userId = Number(userIdRaw)
  if (!Number.isSafeInteger(userId) || userId < 1 || !CASE_REF_PATTERN.test(caseRef)) usage()

  return { userId, caseRef }
}

export async function runBreakGlassCommand(input: BreakGlassCommandInput) {
  await prisma.$connect()
  try {
    const result = await resetAdminMfaForBreakGlass(input)
    // caseRef is the approved ticket-like identifier already validated by the
    // security-event serializer. Do not add credentials or connection details.
    console.log(JSON.stringify({
      userId: input.userId,
      caseRef: input.caseRef,
      revokedCount: result.revokedCount,
      mfaVersion: result.mfaVersion,
    }))
  } finally {
    await prisma.$disconnect()
  }
}

async function main() {
  await runBreakGlassCommand(parseBreakGlassCommandInput(process.argv.slice(2)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Break-glass MFA reset failed')
    process.exitCode = 1
  })
}
