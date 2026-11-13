import api from './client'

export interface ShortlinkSettings { apiBaseUrl: string; publicOrigin: string; groupId: string }
export interface ShortlinkAdminSettings {
  version: number
  activeRevisionId: string | null
  source: 'environment' | 'database'
  enabled: boolean
  encryptionReady: boolean
  draft: ShortlinkSettings | null
  bootstrap: ShortlinkSettings | null
  credentialsConfigured: boolean
  tested: boolean
  rollbackAvailable: boolean
  updatedAt: string | null
}
const base = '/admin/integrations/shortlink/config'
export async function getShortlinkSettings(): Promise<ShortlinkAdminSettings> {
  return (await api.get<ShortlinkAdminSettings>(base)).data
}
export async function saveShortlinkDraft(input: ShortlinkSettings & { expectedVersion: number; credentials?: { username: string; password: string } }): Promise<ShortlinkAdminSettings> {
  return (await api.put<ShortlinkAdminSettings>(base, input)).data
}
export async function operateShortlinkSettings(action: 'test' | 'activate' | 'rollback' | 'enabled', expectedVersion: number, enabled?: boolean): Promise<ShortlinkAdminSettings> {
  return (await api.post<ShortlinkAdminSettings>(`${base}/${action}`, { expectedVersion, ...(enabled === undefined ? {} : { enabled }) })).data
}

export interface ManagedSettings<S> extends Omit<ShortlinkAdminSettings, 'draft' | 'bootstrap'> {
  draftWebhookUrl?: string | null; draftAccountKey?: string | null
  draft: S | null; bootstrap: S | null; testKind: 'read_only' | 'local_validation'
}
export function integrationApi<S, C>(service: string) {
  const path = `/admin/integrations/${service}/config`
  return {
    get: async () => (await api.get<ManagedSettings<S>>(path)).data,
    save: async (expectedVersion: number, settings: S, credentials?: C) => (await api.put<ManagedSettings<S>>(path, { expectedVersion, settings, ...(credentials ? { credentials } : {}) })).data,
    operate: async (action: string, expectedVersion: number, extra: { enabled?: boolean; legacyConfirmed?: boolean } = {}) => (await api.post<ManagedSettings<S>>(`${path}/${action}`, { expectedVersion, ...extra })).data,
  }
}
export interface FakaSettings {
  url: string; statusUrl: string; revokeUrl: string; panelUrl: string
  timeoutMs: number; maxAttempts: number; instanceId: string | null; clientId: string
}
export const fakaIntegrationApi = integrationApi<FakaSettings, { secret: string }>('faka-bridge')
