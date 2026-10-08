import client from '../client'
import type { ContentSuggestionResponse } from '../contentSuggestion'
import type { WorkbenchAction, WorkbenchItem } from './workbench'

// SPEC-MERCHANT-AGENT-001 §8.1 — merchant operations agent. Results carry
// server-rendered evidence and closed actions; the model never supplies URLs.

export type AgentAvailability = {
  available: boolean
  reason: 'disabled' | 'quota' | 'ready'
  limits: { messageMax: number; sourceNotesMax: number; recentMessages: number }
}

export type AgentEvidence =
  | { ref: string; kind: 'workbench_item'; item: WorkbenchItem; actionRef: string }
  | { ref: string; kind: 'product'; productId: number; name: string; status: string }
  | { ref: string; kind: 'readiness'; productId: number; name: string; status: string; ready: boolean
      issues: Array<{ code: string; field: string; offerId: number | null; actionRef: string; action: WorkbenchAction }> }
  | { ref: string; kind: 'content'; productId: number; name: string; filledFields: string[]; emptyFields: string[] }

export type AgentProposal = Omit<ContentSuggestionResponse, 'generationId'> & {
  proposalId: string
  productId: number
  createdAt: string
  expiresAt: string
}

export type AgentTurnResult = {
  generationId: number
  outcome: 'answered' | 'clarification' | 'proposal' | 'limited'
  stopReason: string
  blocks: Array<{ text: string; evidenceRefs: string[]; action: WorkbenchAction | null }>
  clarification: { question: string; candidateRefs: string[] } | null
  proposal: AgentProposal | null
  evidence: AgentEvidence[]
  steps: Array<{ tool: string; status: string }>
  coverage: Array<{ group: string; status: string; matchedTotal: number | null; shown: number; truncated: boolean; hasMore?: boolean }>
}

export type AgentSelectedResource = { type: 'product' | 'offer' | 'order'; id: number }

export type AgentTurnRequest = {
  requestId: string
  message: string
  selectedResource?: AgentSelectedResource | null
  recentUserMessages?: string[]
  publicSourceNotes?: string | null
}

// The run is capped at 45 s server-side behind nginx's 60 s; only this call
// gets a longer client timeout (the global default stays 15 s).
const AGENT_TURN_TIMEOUT_MS = 55_000

export async function getAgentAvailability(): Promise<AgentAvailability> {
  const { data } = await client.get<AgentAvailability>('/merchant/agent/availability')
  return data
}

export async function postAgentTurn(body: AgentTurnRequest, signal: AbortSignal): Promise<AgentTurnResult> {
  const { data } = await client.post<AgentTurnResult>('/merchant/agent/turns', body, { timeout: AGENT_TURN_TIMEOUT_MS, signal })
  return data
}
