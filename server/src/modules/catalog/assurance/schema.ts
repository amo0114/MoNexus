import { z } from 'zod'

export const applicationReasonSchema = z.string().trim().min(20).max(1000)
export const reviewReasonSchema = z.string().trim().min(1).max(500)

export const createAssuranceApplicationSchema = z.object({
  reason: applicationReasonSchema,
}).strict()

export const listAdminAssuranceQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export const approveAssuranceSchema = z.object({
  validUntil: z.coerce.date(),
  reason: reviewReasonSchema,
}).strict()

export const rejectAssuranceSchema = z.object({
  reason: reviewReasonSchema,
}).strict()

export const createAssuranceGrantSchema = z.object({
  validUntil: z.coerce.date(),
  reason: reviewReasonSchema,
}).strict()

export const revokeAssuranceGrantSchema = z.object({
  reason: reviewReasonSchema,
}).strict()
