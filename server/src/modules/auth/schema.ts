import { z } from 'zod'

export const registerSchema = z.object({
  email: z.string().email('请输入有效的邮箱地址'),
  password: z.string().min(6, '密码至少 6 位'),
  inviteCode: z.string().optional(),
})

export const loginSchema = z.object({
  email: z.string().email('请输入有效的邮箱地址'),
  password: z.string().min(1, '请输入密码'),
})

const mfaChallengeIdSchema = z.string().uuid('MFA 验证请求无效')

// Keep the factor payload broadly shaped enough for a wrong TOTP/recovery
// code to receive the deliberately generic MFA verification error rather
// than turning format differences into an oracle.
export const mfaEnrollmentStartSchema = z.object({
  challengeId: mfaChallengeIdSchema,
}).strict()

export const mfaEnrollmentConfirmSchema = z.object({
  challengeId: mfaChallengeIdSchema,
  code: z.string().min(1).max(128),
}).strict()

export const mfaVerifySchema = z.object({
  challengeId: mfaChallengeIdSchema,
  method: z.enum(['totp', 'recovery']),
  code: z.string().min(1).max(128),
}).strict()

export const forgotPasswordSchema = z.object({
  email: z.string().email('请输入有效的邮箱地址'),
})

export const resetPasswordSchema = z.object({
  token: z.string().min(1, '令牌不能为空'),
  password: z.string().min(6, '密码至少 6 位'),
})

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码'),
  newPassword: z.string().min(6, '密码至少 6 位'),
})

export const updateMeSchema = z.object({
  nickname: z.string().trim().min(1, '昵称不能为空').max(20, '昵称最多 20 字'),
}).strict()

export const sessionIdParamSchema = z.object({
  sessionId: z.string().uuid('会话标识无效'),
})

export const verifyEmailQuerySchema = z.object({
  token: z.string().min(1, '令牌不能为空'),
})
