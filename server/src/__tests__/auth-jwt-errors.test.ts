import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import { config } from '../config/index.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'

/**
 * 审计低危项：JWT 校验失败一律提示「Token 已过期」，掩盖了真实原因。
 * 状态码与错误码保持 401 / UNAUTHENTICATED（前端刷新逻辑只看状态码），
 * 仅文案按失败原因区分：过期 vs 无效（篡改 / 非法格式 / 错误密钥）。
 */
describe('authenticate middleware failure messages', () => {
  it('reports an expired access token as expired', async () => {
    const { user } = await createTestUser('jwt-expired@test.local', 'pass123', 'user')
    const expired = jwt.sign(
      { userId: user.id, role: 'user', exp: Math.floor(Date.now() / 1000) - 60 },
      config.jwtSecret,
    )

    const res = await api.get('/api/auth/me').set(authHeader(expired)).expect(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
    expect(res.body.error.message).toContain('已过期')
  })

  it('reports a tampered or malformed token as invalid, not expired', async () => {
    await createTestUser('jwt-invalid@test.local', 'pass123', 'user')
    const { accessToken } = await loginAs('jwt-invalid@test.local', 'pass123')
    const tampered = accessToken.slice(0, -2) + (accessToken.endsWith('aa') ? 'bb' : 'aa')

    for (const token of [tampered, 'not-a-jwt', jwt.sign({ userId: 1, role: 'user' }, 'wrong-secret')]) {
      const res = await api.get('/api/auth/me').set(authHeader(token)).expect(401)
      expect(res.body.error.code).toBe('UNAUTHENTICATED')
      expect(res.body.error.message).toContain('无效')
      expect(res.body.error.message).not.toContain('已过期')
    }
  })
})
