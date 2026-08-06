import { z } from 'zod'

const normalizedEmailSchema = z.string()
  .trim()
  .toLowerCase()
  .email('请输入有效的邮箱地址')
  .max(320, '邮箱地址过长')

export const registerSchema = z.object({
  email: normalizedEmailSchema,
  password: z.string().min(6, '密码至少 6 位'),
  // SPEC-INVITE-001 IV-01：trim + 大写归一化后必须恰为 8 位短码；空串视同
  // 未携带（invite-only 的缺码判定在 service 层，见 IV-08）。
  inviteCode: z.preprocess(
    value => {
      if (typeof value !== 'string') return value
      const trimmed = value.trim()
      return trimmed === '' ? undefined : trimmed.toUpperCase()
    },
    z.string().regex(/^[A-Z0-9]{8}$/, '邀请码格式不正确').optional(),
  ),
  // The proof stays optional at schema level so an explicit local/test
  // `ABUSE_PROTECTION_MODE=off` remains usable. Enforce mode maps an omitted
  // or blank value to HUMAN_VERIFICATION_REQUIRED at the service boundary.
  turnstileToken: z.string().trim().max(4_096, '安全验证令牌过长').optional(),
  // SPEC-LEGAL-001：协议确认 { document: version }。缺失/版本过期的判定
  // 在 service 层按 enforcement 分级（REQUIRED/STALE）；这里只约束形状。
  agreements: z.record(
    z.string().trim().min(1).max(64),
    z.string().trim().min(1).max(32),
  ).refine(value => Object.keys(value).length <= 8, '协议确认条目过多').optional(),
}).strict()

export const loginSchema = z.object({
  email: normalizedEmailSchema,
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
  email: normalizedEmailSchema,
  // Optional at the schema boundary so ABUSE_PROTECTION_MODE=off retains the
  // legacy request shape. Enforce mode maps omission to a named security error
  // in the service layer.
  turnstileToken: z.string().trim().max(4_096, '安全验证令牌过长').optional(),
}).strict()

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

export const verifyEmailSchema = z.object({
  token: z.string().min(1, '令牌不能为空'),
}).strict()
