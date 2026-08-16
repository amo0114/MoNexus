import { describe, expect, it } from 'vitest'
import {
  ALLOWED_E2E_DATABASE_PATHNAMES,
  resolveE2eAdminMfaFactor,
  type E2eAdminMfaGuardInput,
} from './e2eSeedGuard.js'

// 32-char Base32 secret drawn from the alphabet [A-Z2-7].
const VALID_FACTOR = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
// A password embedded in every test DATABASE_URL below; used to prove that
// error messages never leak credentials.
const DB_CREDENTIAL = 'monexus_dev_2026'

const BASE_URL = `postgresql://monexus:${DB_CREDENTIAL}@localhost:5432`

function makeInput(overrides: Partial<E2eAdminMfaGuardInput> = {}): E2eAdminMfaGuardInput {
  return {
    forceReset: true,
    nodeEnv: 'test',
    factor: VALID_FACTOR,
    databaseUrl: `${BASE_URL}/monexus_test?schema=public`,
    ...overrides,
  }
}

interface RejectionContext {
  factor: string | undefined
  databaseUrl: string | undefined
}

function expectRejected(input: E2eAdminMfaGuardInput, context: RejectionContext): void {
  let caught: unknown
  try {
    resolveE2eAdminMfaFactor(input)
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(Error)
  const message = caught instanceof Error ? caught.message : String(caught)
  expect(message.length).toBeGreaterThan(0)

  // Error messages must never echo the passed factor (nor a fragment of it).
  if (context.factor !== undefined) {
    expect(message).not.toContain(context.factor)
    expect(message).not.toContain(context.factor.slice(0, 6))
  }
  // Error messages must never echo the full DATABASE_URL or its credential.
  if (context.databaseUrl !== undefined && context.databaseUrl.length > 0) {
    expect(message).not.toContain(context.databaseUrl)
  }
  expect(message).not.toContain(DB_CREDENTIAL)
}

interface NamedInput {
  name: string
  input: E2eAdminMfaGuardInput
}

describe('resolveE2eAdminMfaFactor', () => {
  describe('allowlist constant', () => {
    it('exposes exactly the two dedicated test database pathnames', () => {
      expect(ALLOWED_E2E_DATABASE_PATHNAMES).toEqual([
        '/monexus_test',
        '/monexus_test_catalog_merch_integration',
      ])
    })
  })

  describe('factor missing (ordinary seed path unaffected)', () => {
    const cases: ReadonlyArray<{ name: string; input: E2eAdminMfaGuardInput }> = [
      { name: 'factor is undefined with otherwise valid env', input: makeInput({ factor: undefined }) },
      { name: 'factor is an empty string', input: makeInput({ factor: '' }) },
      { name: 'factor missing even when forceReset is false', input: makeInput({ factor: undefined, forceReset: false }) },
      { name: 'factor missing even when NODE_ENV is production', input: makeInput({ factor: undefined, nodeEnv: 'production' }) },
      { name: 'factor missing even when DATABASE_URL is unset', input: makeInput({ factor: undefined, databaseUrl: undefined }) },
    ]

    it.each(cases)('$name', ({ input }) => {
      expect(resolveE2eAdminMfaFactor(input)).toBeNull()
    })
  })

  describe('dedicated test databases (exact allowlist)', () => {
    const allowedUrls: ReadonlyArray<{ name: string; databaseUrl: string }> = [
      { name: '/monexus_test', databaseUrl: `${BASE_URL}/monexus_test` },
      { name: '/monexus_test with ?schema=public query', databaseUrl: `${BASE_URL}/monexus_test?schema=public` },
      { name: '/monexus_test_catalog_merch_integration', databaseUrl: `${BASE_URL}/monexus_test_catalog_merch_integration` },
      { name: '/monexus_test_catalog_merch_integration with ?schema=public query', databaseUrl: `${BASE_URL}/monexus_test_catalog_merch_integration?schema=public` },
    ]

    it.each(allowedUrls)('accepts $name and returns the factor', ({ databaseUrl }) => {
      expect(resolveE2eAdminMfaFactor(makeInput({ databaseUrl }))).toBe(VALID_FACTOR)
    })
  })

  describe('mode guards', () => {
    const rejectedModes: ReadonlyArray<NamedInput> = [
      { name: 'forceReset=false', input: makeInput({ forceReset: false }) },
      { name: 'NODE_ENV=production', input: makeInput({ nodeEnv: 'production' }) },
      { name: 'NODE_ENV=development', input: makeInput({ nodeEnv: 'development' }) },
      { name: 'NODE_ENV unset', input: makeInput({ nodeEnv: undefined }) },
      { name: 'forceReset=false with NODE_ENV=test', input: makeInput({ forceReset: false, nodeEnv: 'test' }) },
      { name: 'forceReset=true with NODE_ENV=production', input: makeInput({ forceReset: true, nodeEnv: 'production' }) },
    ]

    it.each(rejectedModes)('rejects $name', ({ input }) => {
      expectRejected(input, { factor: input.factor, databaseUrl: input.databaseUrl })
    })

    it('throws the test-mode message and does not leak secrets', () => {
      const input = makeInput({ forceReset: false })
      expect(() => resolveE2eAdminMfaFactor(input)).toThrowError(
        'E2E administrator MFA seed is only allowed in test mode',
      )
    })
  })

  describe('invalid factors', () => {
    const rejectedFactors: ReadonlyArray<{ name: string; factor: string }> = [
      { name: 'lowercase alphabet', factor: 'jbswy3dpehpk3pxpjbswy3dpehpk3pxp' },
      { name: 'too short (16 chars)', factor: 'JBSWY3DPEHPK3PXP' },
      { name: 'too long (33 chars)', factor: `${VALID_FACTOR}A` },
      { name: 'contains digit 1', factor: 'JBSWY3DPEHPK3PX1JBSWY3DPEHPK3PXP' },
      { name: 'contains digit 0', factor: 'JBSWY3DPEHPK3PX0JBSWY3DPEHPK3PXP' },
      { name: 'contains digit 8', factor: 'JBSWY3DPEHPK3PX8JBSWY3DPEHPK3PXP' },
      { name: 'contains digit 9', factor: 'JBSWY3DPEHPK3PX9JBSWY3DPEHPK3PXP' },
      { name: 'contains a lowercase letter', factor: 'JBSWY3DPEHPK3PXpJBSWY3DPEHPK3PXP' },
    ]

    it.each(rejectedFactors)('rejects factor that is $name', ({ factor }) => {
      const input = makeInput({ factor })
      expectRejected(input, { factor, databaseUrl: input.databaseUrl })
    })
  })

  describe('invalid database URLs', () => {
    const rejectedUrls: ReadonlyArray<{ name: string; databaseUrl: string | undefined }> = [
      { name: 'production database /monexus', databaseUrl: `${BASE_URL}/monexus` },
      { name: 'evil suffix /monexus_test_catalog_merch_integration_evil', databaseUrl: `${BASE_URL}/monexus_test_catalog_merch_integration_evil` },
      { name: 'evil prefix /prefix_monexus_test_catalog_merch_integration', databaseUrl: `${BASE_URL}/prefix_monexus_test_catalog_merch_integration` },
      { name: 'case variant /Monexus_Test_Catalog_Merch_Integration', databaseUrl: `${BASE_URL}/Monexus_Test_Catalog_Merch_Integration` },
      { name: 'case variant /MONEXUS_TEST', databaseUrl: `${BASE_URL}/MONEXUS_TEST` },
      { name: 'trailing slash path trick /monexus_test/', databaseUrl: `${BASE_URL}/monexus_test/` },
      { name: 'extra path segment trick /monexus_test/extra', databaseUrl: `${BASE_URL}/monexus_test/extra` },
      { name: 'unparseable url', databaseUrl: 'not-a-url' },
      { name: 'empty url', databaseUrl: '' },
      { name: 'unset url', databaseUrl: undefined },
    ]

    it.each(rejectedUrls)('rejects $name', ({ databaseUrl }) => {
      const input = makeInput({ databaseUrl })
      expectRejected(input, { factor: input.factor, databaseUrl: input.databaseUrl })
    })
  })
})
