import { describe, expect, it } from 'vitest'
import { parseBreakGlassCommandInput } from '../scripts/resetAdminMfaForBreakGlass.js'

describe('break-glass MFA reset CLI input boundary', () => {
  it('accepts only a positive user ID and controlled operations case reference', () => {
    expect(parseBreakGlassCommandInput(['--user-id=42', '--case-ref=OPS-123'])).toEqual({
      userId: 42,
      caseRef: 'OPS-123',
    })
  })

  const invalidArgs = [
    [],
    ['--user-id=0', '--case-ref=OPS-123'],
    ['--user-id=1.5', '--case-ref=OPS-123'],
    ['--user-id=1', '--case-ref=free form detail'],
    ['--user-id=1', '--case-ref=OPS-123', '--extra=value'],
    ['--user-id=1', '--user-id=2'],
  ]

  it.each(invalidArgs.map(args => [args]))('rejects non-auditable CLI arguments: %j', (args) => {
    expect(() => parseBreakGlassCommandInput(args)).toThrow('Usage:')
  })
})
