import { z } from 'zod'

// Audience is derived from the authenticated caller's role, never from a
// client-controlled query parameter. Keeping this strict also rejects stale
// callers attempting to select another audience explicitly.
export const listPublicAnnouncementsQuerySchema = z.object({}).strict()

export type ListPublicAnnouncementsQuery = z.infer<typeof listPublicAnnouncementsQuerySchema>
