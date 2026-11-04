import { describe, it, expect } from 'vitest'
import { passwordPolicyIssue } from './passwordPolicy'
import { passwordPolicyIssue as serverPasswordPolicyIssue } from '../../server/src/lib/passwordPolicy'

describe('passwordPolicyIssue', () => {
  const cases: Array<[string, { email?: string; nickname?: string }]> = [
    ['123456', {}],
    ['qwerty12', {}],
    ['admin123', {}],
    ['P@ssw0rd', {}],
    ['Monexus2026!', {}],
    ['zhangwei.chen1', { email: 'zhangwei.chen@test.local' }],
    ['Lanternfish88', { nickname: 'Lanternfish' }],
    ['Xk9#mQ2vLp', {}],
    ['correct horse battery', {}],
    ['x'.repeat(129), {}],
  ]

  it('matches the server policy so the form never accepts what the API rejects', async () => {
    for (const [password, context] of cases) {
      expect(await passwordPolicyIssue(password, context), password).toBe(serverPasswordPolicyIssue(password, context))
    }
  })

  it('accepts strong passwords and rejects common ones', async () => {
    expect(await passwordPolicyIssue('Xk9#mQ2vLp')).toBeNull()
    expect(await passwordPolicyIssue('P@ssw0rd')).toBe('该密码过于常见，请更换')
    expect(await passwordPolicyIssue('short')).toBe('密码至少 8 位')
  })
})
