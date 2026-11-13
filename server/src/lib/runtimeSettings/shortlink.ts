import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { prisma } from '../prisma.js'
import { createShortlinkClient, isShortlinkConfigured, ShortlinkError, type ShortlinkClient, type ShortlinkConfig } from '../shortlinkClient.js'
import { decryptIntegrationCredentials } from './credentials.js'

export const httpsOriginSchema = z.string().trim().max(2048).url().refine(value => {
  const u = new URL(value)
  return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/'
}, '请输入不含路径、账号或参数的 HTTPS 域名').transform(value => new URL(value).origin)
export const shortlinkSettingsSchema = z.object({
  apiBaseUrl: httpsOriginSchema, publicOrigin: httpsOriginSchema,
  groupId: z.string().trim().min(1).max(128).refine(value => !/[\r\n\0]/.test(value)),
}).strict()
export const shortlinkCredentialsSchema = z.object({
  username: z.string().trim().min(1).max(320).refine(value => !/[\r\n\0]/.test(value)),
  password: z.string().min(1).max(4096).refine(value => !/[\r\n\0]/.test(value)),
}).strict()
export type ShortlinkSettings = z.infer<typeof shortlinkSettingsSchema>
export function shortlinkBootstrap(): ShortlinkConfig | null {
  return isShortlinkConfigured(config.shortlink) ? {
    apiBaseUrl: config.shortlink.apiBaseUrl!, publicOrigin: config.shortlink.publicOrigin!, groupId: config.shortlink.groupId!,
    username: config.shortlink.username!, password: config.shortlink.password!,
  } : null
}
export async function getShortlinkRuntimeConfig(client: Pick<Prisma.TransactionClient, 'integrationConfig'> = prisma) {
  const state = await client.integrationConfig.findUnique({ where: { key: 'shortlink' }, include: { activeRevision: true } })
  if (state && !state.enabled) return null
  if (!state?.activeRevisionId) {
    const settings = shortlinkBootstrap()
    return settings ? { revisionId: null, settings } : null
  }
  try {
    const revision = state.activeRevision!
    if (revision.key !== 'shortlink' || !revision.credentialsCiphertext) throw new Error('Invalid revision')
    const settings = shortlinkSettingsSchema.parse(revision.settings)
    const credentials = shortlinkCredentialsSchema.parse(decryptIntegrationCredentials('shortlink', revision.id, settings, revision.credentialsCiphertext))
    return { revisionId: revision.id, settings: { ...settings, ...credentials } }
  } catch { throw new ShortlinkError('unavailable') }
}
const clients = new Map<string, ShortlinkClient>()
export function shortlinkClientForSnapshot(snapshot: NonNullable<Awaited<ReturnType<typeof getShortlinkRuntimeConfig>>>): ShortlinkClient {
  // Environment has no immutable revision; create a fresh client rather than cache mutable bootstrap/test state.
  if (!snapshot.revisionId) return createShortlinkClient({ config: snapshot.settings })
  let client = clients.get(snapshot.revisionId)
  if (!client) {
    client = createShortlinkClient({ config: snapshot.settings })
    if (clients.size >= 16) clients.delete(clients.keys().next().value!)
    clients.set(snapshot.revisionId, client)
  }
  return client
}
