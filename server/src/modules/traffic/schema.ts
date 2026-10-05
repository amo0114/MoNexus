import { z } from 'zod'

export const trafficEventSchema = z.object({
  eventId: z.string().uuid(),
  visitorId: z.string().uuid(),
  page: z.string().max(100).regex(/^(\/|\/product\/[1-9]\d{0,9})$/)
    .refine(page => page === '/' || Number(page.slice('/product/'.length)) <= 2_147_483_647),
}).strict()

export const trafficQuerySchema = z.object({
  range: z.enum(['7d', '30d', '90d']).default('30d'),
})

export type TrafficEventInput = z.infer<typeof trafficEventSchema>
export type TrafficRange = z.infer<typeof trafficQuerySchema>['range']
