import { createHash } from 'node:crypto'
import * as bridge from '../../lib/fakaBridge/accountV2.js'
import { config } from '../../config/index.js'
import { unavailable } from './settings.js'

const capabilities = new Map<string, { expires: number; pending: Promise<void> }>()
const snapshots = new Map<string, { body: bridge.FakaV2Subscription; receivedAt: number }>()
const pending = new Map<string, Promise<Snapshot>>()
type Snapshot = { body: bridge.FakaV2Subscription | null; stale: boolean; unavailable: boolean }
class TransientCapabilitiesError extends Error {}
function scope(instanceId: string) {
  return createHash('sha256').update(JSON.stringify([instanceId, config.fakaBridge.url, config.fakaBridge.secret])).digest('hex')
}

export async function requireReadCapabilities(instanceId: string) {
  const key = scope(instanceId), old = capabilities.get(key)
  if (old && old.expires > Date.now()) return old.pending
  const entry = { expires: Date.now() + 15_000, pending: Promise.resolve() }
  entry.pending = bridge.callFakaV2Capabilities().then(result => {
    if (!result.ok) {
      if (result.code === 'NETWORK' || result.code === 'TIMEOUT'
        || (result.httpStatus >= 500 && result.remoteCode !== 'CAPABILITY_UNAVAILABLE')) throw new TransientCapabilitiesError()
      throw unavailable()
    }
    if (!result.body.capabilities.resolve_by_order || !result.body.capabilities.subscription_by_user_id) throw unavailable()
  }).catch(error => { if (capabilities.get(key) === entry) capabilities.delete(key); throw error })
  if (capabilities.size >= 32) capabilities.clear()
  capabilities.set(key, entry)
  return entry.pending
}

// Authorization belongs to the caller and is checked before AND after this
// shared account snapshot cache. Benefits and caller identity never enter it.
export async function readSnapshot(instanceId: string, userId: string): Promise<Snapshot> {
  const key = `${scope(instanceId)}:${userId}`, old = snapshots.get(key)
  try { await requireReadCapabilities(instanceId) }
  catch (error) {
    if (!(error instanceof TransientCapabilitiesError)) { snapshots.delete(key); throw error }
    return old && Date.now() - old.receivedAt <= 60_000
      ? { body: old.body, stale: true, unavailable: true }
      : { body: null, stale: false, unavailable: true }
  }
  if (old && Date.now() - old.receivedAt < 15_000) return { body: old.body, stale: false, unavailable: false }
  const existing = pending.get(key)
  if (existing) return existing
  const work = bridge.callFakaV2Subscription(userId).then(result => {
    if (result.ok) {
      if (snapshots.size >= 500) snapshots.delete(snapshots.keys().next().value!)
      if (pending.get(key) === work) snapshots.set(key, { body: result.body, receivedAt: Date.now() })
      return { body: result.body, stale: false, unavailable: false }
    }
    const transient = result.code === 'NETWORK' || result.code === 'TIMEOUT'
      || (result.httpStatus >= 500 && result.remoteCode !== 'CAPABILITY_UNAVAILABLE')
    if (transient && old && Date.now() - old.receivedAt <= 60_000) return { body: old.body, stale: true, unavailable: true }
    if (pending.get(key) === work) snapshots.delete(key)
    return { body: null, stale: false, unavailable: true }
  }).finally(() => { if (pending.get(key) === work) pending.delete(key) })
  pending.set(key, work)
  return work
}

export function invalidateAccountSnapshot(instanceId: string, userId: string) {
  const key = `${scope(instanceId)}:${userId}`
  snapshots.delete(key)
  // An older in-flight response may still be returned to its existing caller,
  // but cannot repopulate the cache or replace a subsequent fresh request.
  pending.delete(key)
}

export function clearAccountQueryCachesForTests() { capabilities.clear(); snapshots.clear(); pending.clear() }
