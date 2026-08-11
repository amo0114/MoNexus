import { z } from 'zod'

export const manualGrantEntitlementSchema = z.object({
  merchantId: z.number().int().positive(),
  validUntil: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(1).max(500),
}).strict()

export const revokeEntitlementSchema = z.object({
  reason: z.string().trim().min(1).max(500),
}).strict()

export const listEntitlementsQuerySchema = z.object({
  merchantId: z.coerce.number().int().positive().optional(),
  status: z.enum(['active', 'expired', 'revoked']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict()

