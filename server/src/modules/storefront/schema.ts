import { z } from 'zod'
import { categoryCodeSchema } from '../catalog/categorySchema.js'

export const candidatesQuerySchema = z.object({
  categoryCode: categoryCodeSchema.optional(),
}).strict()

export type CandidatesQuery = z.infer<typeof candidatesQuerySchema>
