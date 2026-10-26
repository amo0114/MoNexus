import { z } from 'zod'

const base = z.object({ platform: z.literal('qq'), platformId: z.string().regex(/^[1-9][0-9]{4,19}$/) })
export const accountsSchema = base.strict()
export const profileSchema = base.extend({ accountLinkId: z.string().uuid().optional() }).strict()
export const selectSchema = base.extend({ accountLinkId: z.string().uuid(), requestId: z.string().uuid() }).strict()

export const resetIntentSchema = base.extend({ accountLinkId: z.string().uuid().optional(), requestId: z.string().uuid() }).strict()
export const resetConfirmSchema = base.extend({ intentId: z.string().uuid(), confirmationCode: z.string().regex(/^[A-Z2-7]{6}$/), requestId: z.string().uuid() }).strict()
export const resetStatusSchema = base.extend({ operationId: z.string().uuid() }).strict()
export const resetIntentStatusSchema = base.extend({ intentId: z.string().uuid() }).strict()
