import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { AgentTurnResult } from '../../../api/merchant/agent'

const api = vi.hoisted(() => ({ getAgentAvailability: vi.fn(), postAgentTurn: vi.fn() }))
vi.mock('../../../api/merchant/agent', () => api)

import { useMerchantAgentStore } from '../../../stores/merchantAgent'
import AgentPanel from './AgentPanel'

const answered: AgentTurnResult = {
  generationId: 1, outcome: 'answered', stopReason: 'answer',
  blocks: [{ text: '先处理发布缺项。', evidenceRefs: ['P1'], action: { kind: 'edit_product', productId: 7, focus: 'images', offerId: null } }],
  clarification: null, proposal: null, steps: [{ tool: 'inspect_product', status: 'ok' }],
  coverage: [{ group: 'drafts', status: 'complete', matchedTotal: 3, shown: 3, truncated: false, hasMore: true }],
  evidence: [{ ref: 'P1', kind: 'readiness', productId: 7, name: '学习指引', status: 'draft', ready: false,
    issues: [{ code: 'COVER_REQUIRED', field: 'images', offerId: null, actionRef: 'A1', action: { kind: 'edit_product', productId: 7, focus: 'images', offerId: null } }] }],
}

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>
}

function renderPanel() {
  return render(
    <MemoryRouter initialEntries={['/merchant/workbench']}>
      <Routes>
        <Route path="/merchant/workbench" element={<AgentPanel />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  Object.values(api).forEach(fn => fn.mockReset())
  useMerchantAgentStore.getState().reset(null)
  api.getAgentAvailability.mockResolvedValue({ available: true, reason: 'ready', limits: {} })
})

describe('AgentPanel', () => {
  it('stays hidden while the agent is disabled', async () => {
    useMerchantAgentStore.setState({ availability: 'disabled' })
    const { container } = renderPanel()
    expect(container).toBeEmptyDOMElement()
  })

  it('only sends on submit and renders server evidence, actions, coverage and steps', async () => {
    useMerchantAgentStore.setState({ availability: 'ready' })
    api.postAgentTurn.mockResolvedValue(answered)
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '这个商品为什么不能发布？' }))
    expect(api.postAgentTurn).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('agent-send'))
    expect(await screen.findByText('先处理发布缺项。')).toBeInTheDocument()
    expect(screen.getByTestId('agent-evidence-P1')).toHaveTextContent('缺少商品封面')
    expect(screen.getByRole('link', { name: '去处理' })).toHaveAttribute('href', '/merchant/products/7/edit?focus=images')
    expect(screen.getByTestId('agent-coverage')).toHaveTextContent('只检查了部分草稿')
    expect(screen.getByTestId('agent-steps')).toHaveTextContent('发布检查')
  })

  it('hands a proposal to the editor through memory only', async () => {
    useMerchantAgentStore.setState({ availability: 'ready' })
    api.postAgentTurn.mockResolvedValue({ ...answered, outcome: 'proposal', blocks: [], proposal: {
      proposalId: 'p1', productId: 7, basedOnContentVersion: 2, promptVersion: 'p', validatorVersion: 'v',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      fields: { description: { status: 'suggested', value: '新的简介', rejectedItemCount: 0 } }, issues: [],
    } })
    renderPanel()
    fireEvent.change(screen.getByTestId('agent-input'), { target: { value: '帮我完善说明' } })
    fireEvent.click(screen.getByTestId('agent-send'))
    fireEvent.click(await screen.findByTestId('agent-proposal-review'))
    expect(screen.getByTestId('where')).toHaveTextContent('/merchant/products/7/edit')
    expect(useMerchantAgentStore.getState().handoff?.proposal.proposalId).toBe('p1')
  })
})
