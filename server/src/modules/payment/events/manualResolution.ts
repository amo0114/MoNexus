import { z } from 'zod'

export const MANUAL_PAYMENT_RESOLUTION = 'payment.manual_resolution'

export const manualPaymentResolutionSchema = z.object({
  orderId: z.string().uuid(),
  actorUserId: z.number().int().positive(),
  action: z.enum(['credit', 'refund']),
})
