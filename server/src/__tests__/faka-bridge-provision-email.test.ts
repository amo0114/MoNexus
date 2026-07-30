import { describe, expect, it } from 'vitest'
import { resolveFakaProvisionEmail } from '../lib/fakaBridge/provisionEmail.js'

describe('resolveFakaProvisionEmail', () => {
  it('prefers xboardEmail form answer over account email', () => {
    expect(
      resolveFakaProvisionEmail(
        { xboardEmail: 'Panel@Example.com' },
        'login@moyuan.net'
      )
    ).toBe('panel@example.com')
  })

  it('falls back to account email when form empty', () => {
    expect(resolveFakaProvisionEmail({}, 'login@moyuan.net')).toBe('login@moyuan.net')
    expect(resolveFakaProvisionEmail(undefined, 'login@moyuan.net')).toBe('login@moyuan.net')
  })

  it('rejects invalid form email', () => {
    expect(() =>
      resolveFakaProvisionEmail({ xboardEmail: 'not-an-email' }, 'login@moyuan.net')
    ).toThrow(/邮箱格式无效/)
  })
})
