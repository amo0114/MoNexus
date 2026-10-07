import { z } from 'zod'

const id = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(2_147_483_647))
export const ruleSchema = z.enum(['draft_incomplete', 'low_availability', 'fulfillment_due'])
export type WorkbenchRule = z.infer<typeof ruleSchema>
export const emptyQuery = z.object({}).strict()
export const draftQuery = z.object({ beforeProductId: id.optional() }).strict()
export const itemParams = z.object({ rule: ruleSchema, targetId: id }).strict()
