import api from './client'

export type AdminAiSettings = {
  version: number
  source: 'environment' | 'database'
  enabled: boolean
  productCopilotEnabled: boolean
  apiKeyConfigured: boolean
  apiKeyLast4: string | null
  credentialError: boolean
  encryptionReady: boolean
  model: string
  baseUrl: string
}

export type UpdateAdminAiSettings = {
  expectedVersion: number
  enabled: boolean
  productCopilotEnabled: boolean
  baseUrl: string
  model: string
  apiKey?: string | null
}

export type AdminAiTestResult = {
  ok: boolean
  code: string
  message: string
  testedVersion: number
  latencyMs: number
}

export async function getAdminAiSettings(): Promise<AdminAiSettings> {
  return (await api.get<AdminAiSettings>('/admin/ai/config')).data
}

export async function updateAdminAiSettings(input: UpdateAdminAiSettings): Promise<AdminAiSettings> {
  return (await api.put<AdminAiSettings>('/admin/ai/config', input)).data
}

export async function testAdminAiConnection(expectedVersion: number): Promise<AdminAiTestResult> {
  return (await api.post<AdminAiTestResult>('/admin/ai/test', { expectedVersion }, { timeout: 20_000 })).data
}
