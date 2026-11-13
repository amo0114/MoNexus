import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditDetailInline } from './AuditDetail'
import { getAdminAuditDetail } from '../../../api/governance'
import { fx } from '../../../test/governanceFixtures'

vi.mock('../../../api/governance', () => ({ getAdminAuditDetail: vi.fn() }))

beforeEach(() => vi.resetAllMocks())

describe('AuditDetailInline operationState', () => {
  it('shows an attempt as only requested, even without safe details', async () => {
    vi.mocked(getAdminAuditDetail).mockResolvedValue(fx.auditAttempt())
    render(<AuditDetailInline id={11} />)
    const state = await screen.findByTestId('audit-operation-state')
    expect(state).toHaveTextContent('仅发起请求')
    expect(state).toHaveTextContent('不代表已执行完成')
    expect(screen.getByText('该记录没有可安全展示的明细。')).toBeInTheDocument()
  })

  it('never presents a committed decision as cash returned', async () => {
    vi.mocked(getAdminAuditDetail).mockResolvedValue(fx.auditSafe())
    render(<AuditDetailInline id={10} />)
    expect(await screen.findByTestId('audit-operation-state')).toHaveTextContent('不代表现金已退回')
    expect(screen.getByText('合成运营理由')).toBeInTheDocument()
  })

  it('labels unmarked records as unknown and does not infer their age', async () => {
    vi.mocked(getAdminAuditDetail).mockResolvedValue(fx.auditUnknown())
    render(<AuditDetailInline id={12} />)
    expect(await screen.findByTestId('audit-operation-state')).toHaveTextContent('结果未知')
    expect(screen.queryByText(/旧版/)).not.toBeInTheDocument()
  })
})
