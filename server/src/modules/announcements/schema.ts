import { z } from 'zod'
import { ANNOUNCEMENT_AUDIENCES } from '../admin/schema.js'

export const listPublicAnnouncementsQuerySchema = z.object({
  audience: z.enum(ANNOUNCEMENT_AUDIENCES).optional(),
}).strict()

export type ListPublicAnnouncementsQuery = z.infer<typeof listPublicAnnouncementsQuerySchema>
