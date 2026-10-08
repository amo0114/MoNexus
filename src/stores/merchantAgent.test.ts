import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProposal, AgentTurnResult } from '../api/merchant/agent'

const api = vi.hoisted(() => ({ getAgentAvailability: vi.fn(), postAgentTurn: vi.fn() }))
vi.mock('../api/merchant/agent', () => api)

import { useMerchantAgentStore } from './merchantAgent'

const store = () => useMerchantAgentStore.getState()
const result = (text: string): AgentTurnResult => ({
  generationId: 1, outcome: 'answered', stopReason: 'answer', blocks: [{ text, evidenceRefs: [], action: null }],
  clarification: null, proposal: null, evidence: [], steps: [], coverage: [],
})
const proposal = (expiresInMs: number): AgentProposal => ({
  proposalId: 'p1', productId: 7, basedOnContentVersion: 3, promptVersion: 'product-content@1', validatorVersion: 'v',
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + expiresInMs).toISOString(), fields: {}, issues: [],
})

beforeEach(() => {
  Object.values(api).forEach(fn => fn.mockReset())
  store().reset('s1')
})

describe('merchant agent store', () => {
  it('sends the selection and recent user messages, then appends the answer', async () => {
    api.postAgentTurn.mockResolvedValueOnce(result('先补货'))
    store().select({ type: 'product', id: 7, label: '商品' })
    await store().send('今天先处理什么？')
    api.postAgentTurn.mockResolvedValueOnce(result('再看草稿'))
    await store().send('那草稿呢？')
    expect(api.postAgentTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      message: '那草稿呢？', selectedResource: { type: 'product', id: 7 }, recentUserMessages: ['今天先处理什么？'],
    }), expect.any(AbortSignal))
    expect(store().messages.map(message => message.role)).toEqual(['user', 'agent', 'user', 'agent'])
    expect(store().pendingRequestId).toBeNull()
  })

  it('drops a late answer after the account changed and marks a cancelled turn', async () => {
    let resolve!: (value: AgentTurnResult) => void
    api.postAgentTurn.mockReturnValueOnce(new Promise(r => { resolve = r }))
    const sending = store().send('今天先处理什么？')
    store().reset('s2')
    resolve(result('旧账号的回答'))
    await sending
    expect(store().messages).toEqual([])

    api.postAgentTurn.mockImplementationOnce((_body, signal: AbortSignal) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))))
    const cancelled = store().send('再问一次')
    store().cancel()
    await cancelled
    expect(store().messages.at(-1)).toMatchObject({ role: 'error', text: expect.stringContaining('已取消') })
  })

  it('maps a disabled agent and exhausted quota', async () => {
    api.postAgentTurn.mockRejectedValueOnce({ response: { status: 429, data: { error: { code: 'AI_QUOTA_EXCEEDED' } } } })
    await store().send('问')
    expect(store().availability).toBe('quota')
    api.postAgentTurn.mockRejectedValueOnce({ response: { status: 404, data: { error: { code: 'NOT_FOUND' } } } })
    await store().send('问')
    expect(store().availability).toBe('disabled')
  })

  it('hands a proposal over once, only to the same product, session and before expiry', () => {
    store().handOff(proposal(60_000))
    expect(store().takeHandoff(8, 's1')).toBeNull()
    expect(store().takeHandoff(7, 's1')).toMatchObject({ usable: true, proposal: { proposalId: 'p1' } })
    expect(store().takeHandoff(7, 's1')).toBeNull()
    store().handOff(proposal(-1))
    expect(store().takeHandoff(7, 's1')?.usable).toBe(false)
    store().handOff(proposal(60_000))
    expect(store().takeHandoff(7, 'other')?.usable).toBe(false)
  })
})
