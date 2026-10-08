import api from './client'

export type AiProtocol = 'openai_responses' | 'openai_chat' | 'anthropic_messages'
export type AiOutputMode = 'json_schema' | 'json_object'
export type AiReasoningMode = 'none' | 'default'

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
  chatTokenParameter: 'max_tokens' | 'max_completion_tokens'
  protocol: AiProtocol
  outputMode: AiOutputMode
  reasoningMode: AiReasoningMode
  merchantAgentEnabled: boolean
  merchantAgentReasoningMode: AiReasoningMode
  /** pilot = only merchants marked in merchant management; all = every active merchant. */
  merchantAgentAudience: 'pilot' | 'all'
  /** Server env MERCHANT_WORKBENCH_ENABLED; read-only here, changes need a backend restart. */
  merchantWorkbenchEnabled: boolean
}

export type UpdateAdminAiSettings = {
  expectedVersion: number
  enabled: boolean
  productCopilotEnabled: boolean
  baseUrl: string
  chatTokenParameter: 'max_tokens' | 'max_completion_tokens'
  protocol: AiProtocol
  outputMode: AiOutputMode
  reasoningMode: AiReasoningMode
  merchantAgentEnabled: boolean
  merchantAgentReasoningMode: AiReasoningMode
  merchantAgentAudience: 'pilot' | 'all'
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
