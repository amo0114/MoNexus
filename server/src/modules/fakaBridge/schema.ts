import { z } from 'zod'

export const provisionEmailBodySchema = z.object({
  email: z.string().trim().email('邮箱格式无效').max(255),
})

export const provisionEmailConfirmSchema = z.object({
  email: z.string().trim().email('邮箱格式无效').max(255),
  code: z.string().trim().regex(/^\d{6}$/, '验证码为 6 位数字'),
})

export const provisionEmailStatusQuerySchema = z.object({
  email: z.string().trim().email('邮箱格式无效').max(255),
})
