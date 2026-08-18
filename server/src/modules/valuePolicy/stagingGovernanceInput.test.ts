import { describe, expect, it } from 'vitest'
import {
  STAGING_GOVERNANCE_CONFIRMATION,
  assertStagingGovernanceEnvironment,
  parseStagingGovernanceInput,
} from './stagingGovernanceInput.js'

const valid = {
  confirmation: STAGING_GOVERNANCE_CONFIRMATION,
  operation: 'schedule',
  maker: {
    email: 'maker@staging.invalid',
    password: 'maker-password-1234',
    totpSecret: 'A'.repeat(32),
  },
  checker: {
    email: 'checker@staging.invalid',
    password: 'checker-password-1234',
    totpSecret: 'B'.repeat(32),
  },
  policy: {
    id: 'vp_cny_100_staging_v1',
    version: 2026082601,
    effectiveAt: '2026-08-26T00:00:00.000Z',
  },
}

describe('ValuePolicy staging governance input', () => {
  it('accepts distinct staging actors and a strict policy shape', () => {
    expect(parseStagingGovernanceInput(valid)).toMatchObject({ operation: 'schedule' })
  })

  it('rejects shared actors, shared factors, weak secrets, and unknown keys', () => {
    expect(() => parseStagingGovernanceInput({ ...valid, checker: valid.maker })).toThrow()
    expect(() => parseStagingGovernanceInput({
      ...valid,
      checker: { ...valid.checker, totpSecret: valid.maker.totpSecret },
    })).toThrow()
    expect(() => parseStagingGovernanceInput({
      ...valid,
      maker: { ...valid.maker, password: 'too-short' },
    })).toThrow()
    expect(() => parseStagingGovernanceInput({ ...valid, unexpected: true })).toThrow()
  })

  it('requires the exact production-runtime staging environment and database', () => {
    expect(() => assertStagingGovernanceEnvironment({
      nodeEnv: 'production',
      deployEnv: 'staging',
      databaseUrl: 'postgresql://user:pass@postgres:5432/monexus_staging',
    })).not.toThrow()
    expect(() => assertStagingGovernanceEnvironment({
      nodeEnv: 'production',
      deployEnv: 'production',
      databaseUrl: 'postgresql://user:pass@postgres:5432/monexus_staging',
    })).toThrow(/staging deploy environment/)
    expect(() => assertStagingGovernanceEnvironment({
      nodeEnv: 'production',
      deployEnv: 'staging',
      databaseUrl: 'postgresql://user:pass@postgres:5432/monexus',
    })).toThrow(/non-staging database/)
  })
})
