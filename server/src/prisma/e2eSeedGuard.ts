/**
 * e2eSeedGuard.ts
 *
 * Pure, dependency-free guard for the E2E administrator MFA seed path.
 *
 * Rationale:
 *  - seed.ts delegates its MFA safety checks here so this module can be unit
 *    tested in isolation, and so importing it never pulls in prisma/server
 *    code (this module has no imports at all).
 *  - All original safety conditions from the former inline logic in seed.ts
 *    are preserved verbatim; the only change is that the database pathname
 *    allowlist is extended to exactly two dedicated test databases:
 *    `/monexus_test` and `/monexus_test_catalog_merch_integration`.
 *
 * Safety contract:
 *  1. factor absent            -> return null (ordinary seed path, no gate)
 *  2. forceReset must be true  AND NODE_ENV === 'test'
 *  3. DATABASE_URL must parse as a URL
 *  4. URL pathname must be EXACTLY one of the allowlisted dedicated test
 *     databases. No includes/startsWith/regex broad matching, no case
 *     variants, no similar prefixes/suffixes, no production databases, and
 *     no query/path tricks can satisfy the allowlist.
 *  5. factor must match /^[A-Z2-7]{32}$/ (32-char Base32 TOTP secret)
 *
 * Error messages are static and never echo the factor, the URL, or any
 * credential.
 */

export const ALLOWED_E2E_DATABASE_PATHNAMES: readonly string[] = [
  '/monexus_test',
  '/monexus_test_catalog_merch_integration',
]

const E2E_TOTP_FACTOR_PATTERN = /^[A-Z2-7]{32}$/

export interface E2eAdminMfaGuardInput {
  forceReset: boolean
  nodeEnv: string | undefined
  factor: string | undefined
  databaseUrl: string | undefined
}

export function resolveE2eAdminMfaFactor(input: E2eAdminMfaGuardInput): string | null {
  const { forceReset, nodeEnv, factor, databaseUrl } = input

  // Factor absent -> ordinary seed path is unaffected; nothing to gate.
  if (!factor) return null

  // E2E MFA is only allowed for an explicit test-mode force reset.
  if (!forceReset || nodeEnv !== 'test') {
    throw new Error('E2E administrator MFA seed is only allowed in test mode')
  }

  // DATABASE_URL must be a parseable URL.
  let parsedUrl: URL
  try {
    parsedUrl = new URL(databaseUrl ?? '')
  } catch {
    throw new Error('E2E administrator MFA seed requires the dedicated test database')
  }

  // The database pathname must be EXACTLY an allowlisted dedicated test
  // database and the factor must be a well-formed 32-char Base32 secret.
  if (
    !ALLOWED_E2E_DATABASE_PATHNAMES.includes(parsedUrl.pathname) ||
    !E2E_TOTP_FACTOR_PATTERN.test(factor)
  ) {
    throw new Error('E2E administrator MFA seed configuration is invalid')
  }

  return factor
}
