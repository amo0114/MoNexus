import { create } from 'zustand'
import { getApiErrorCode } from '../api/error'
import {
  getAgentAvailability,
  postAgentTurn,
  type AgentProposal,
  type AgentSelectedResource,
  type AgentTurnResult,
} from '../api/merchant/agent'

// SPEC-MERCHANT-AGENT-001 §7.2 / §8 — memory-only conversation. Nothing is
// persisted: history, the selected resource and proposal hand-off live here
// and are cleared on account switch or logout. One turn in flight at a time;
// a response from an older request or session is dropped.

export type AgentSelection = AgentSelectedResource & { label: string }

export type AgentMessage =
  | { id: string; role: 'user'; text: string; selection: AgentSelection | null }
  | { id: string; role: 'agent'; result: AgentTurnResult }
  | { id: string; role: 'error'; text: string }

type Availability = 'unknown' | 'ready' | 'disabled' | 'quota' | 'error'

type State = {
  sessionKey: string | null
  availability: Availability
  messages: AgentMessage[]
  pendingRequestId: string | null
  selection: AgentSelection | null
  /** Proposal waiting for the editor; in memory only, never URL/history/storage. */
  handoff: { proposal: AgentProposal; sessionKey: string | null } | null
}

type Actions = {
  reset: (sessionKey: string | null) => void
  loadAvailability: () => Promise<void>
  send: (message: string) => Promise<void>
  cancel: () => void
  select: (selection: AgentSelection | null) => void
  handOff: (proposal: AgentProposal) => void
  /** Returns and clears a hand-off for this product; `usable` is false for another session or after expiry. */
  takeHandoff: (productId: number, sessionKey: string | null) => { proposal: AgentProposal; usable: boolean } | null
}

const RECENT_MESSAGES = 4
const RECENT_TOTAL = 3_000

let controller: AbortController | null = null
let seq = 0
const nextId = () => `m${++seq}`

function recentUserMessages(messages: AgentMessage[]): string[] {
  const texts = messages.flatMap(message => (message.role === 'user' ? [message.text] : [])).slice(-RECENT_MESSAGES)
  while (texts.reduce((sum, text) => sum + text.length, 0) > RECENT_TOTAL) texts.shift()
  return texts
}

function errorText(error: unknown): { text: string; availability?: Availability } {
  const status = (error as { response?: { status?: number } } | undefined)?.response?.status
  const code = getApiErrorCode(error)
  if (status === 404 && !code?.startsWith('AI_')) return { text: '经营助手当前不可用。', availability: 'disabled' }
  if (code === 'AI_QUOTA_EXCEEDED') return { text: '今日经营助手次数已用完，可以继续使用待办列表手动处理。', availability: 'quota' }
  if (code === 'AI_GENERATION_IN_PROGRESS') return { text: '上一个问题仍在处理中，请稍候或取消后再试。' }
  if (status === 404) return { text: '所选对象不存在或已不可用，请重新选择。' }
  return { text: '这次没有完成调查，可以稍后手动重试（会再次消耗次数）。已展示的待办数据仍以待办列表为准。' }
}

export const useMerchantAgentStore = create<State & Actions>()((set, get) => ({
  sessionKey: null,
  availability: 'unknown',
  messages: [],
  pendingRequestId: null,
  selection: null,
  handoff: null,

  reset(sessionKey) {
    controller?.abort()
    controller = null
    set({ sessionKey, availability: 'unknown', messages: [], pendingRequestId: null, selection: null, handoff: null })
  },

  async loadAvailability() {
    const sessionKey = get().sessionKey
    try {
      const result = await getAgentAvailability()
      if (get().sessionKey !== sessionKey) return
      set({ availability: result.reason })
    } catch {
      if (get().sessionKey !== sessionKey) return
      set({ availability: 'error' })
    }
  },

  async send(message) {
    const text = message.trim()
    if (!text || get().pendingRequestId) return
    const { sessionKey, selection, messages } = get()
    const requestId = crypto.randomUUID()
    controller = new AbortController()
    const signal = controller.signal
    set({ pendingRequestId: requestId, messages: [...messages, { id: nextId(), role: 'user', text, selection }] })
    try {
      const result = await postAgentTurn({
        requestId,
        message: text,
        selectedResource: selection ? { type: selection.type, id: selection.id } : null,
        recentUserMessages: recentUserMessages(messages),
      }, signal)
      if (get().sessionKey !== sessionKey || get().pendingRequestId !== requestId) return
      set(state => ({ pendingRequestId: null, messages: [...state.messages, { id: nextId(), role: 'agent', result }] }))
    } catch (error) {
      if (get().sessionKey !== sessionKey || get().pendingRequestId !== requestId) return
      if (signal.aborted) {
        set(state => ({ pendingRequestId: null, messages: [...state.messages, { id: nextId(), role: 'error', text: '已取消。已开始的调查仍计入当日次数。' }] }))
        return
      }
      const failure = errorText(error)
      set(state => ({
        pendingRequestId: null,
        ...(failure.availability ? { availability: failure.availability } : {}),
        messages: [...state.messages, { id: nextId(), role: 'error', text: failure.text }],
      }))
    }
  },

  cancel() {
    controller?.abort()
  },

  select(selection) {
    set({ selection })
  },

  handOff(proposal) {
    set({ handoff: { proposal, sessionKey: get().sessionKey } })
  },

  takeHandoff(productId, sessionKey) {
    const handoff = get().handoff
    if (!handoff || handoff.proposal.productId !== productId) return null
    set({ handoff: null })
    return { proposal: handoff.proposal, usable: handoff.sessionKey === sessionKey && Date.parse(handoff.proposal.expiresAt) > Date.now() }
  },
}))
