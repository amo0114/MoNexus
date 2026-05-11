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

export const forgotPasswordSchema = z.object({
  email: z.string().email('请输入有效的邮箱地址'),
})

export const resetPasswordSchema = z.object({
  token: z.string().min(1, '令牌不能为空'),
  password: z.string().min(6, '密码至少 6 位'),
})

export const verifyEmailQuerySchema = z.object({
  token: z.string().min(1, '令牌不能为空'),
})
