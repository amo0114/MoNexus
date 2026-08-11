import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CatalogGovernanceAdapter } from '../../api/catalogGovernance'
import { fixtureApplicationList, fixtureApplications } from '../../api/catalogGovernance.fixtures'
import CategoryApplicationPanel from './CategoryApplicationPanel'

function adapter(overrides: Partial<CatalogGovernanceAdapter> = {}): CatalogGovernanceAdapter {
  return {
    listMyApplications: vi.fn().mockResolvedValue(fixtureApplicationList),
    createApplication: vi.fn().mockResolvedValue(fixtureApplications[0]),
    withdrawApplication: vi.fn().mockResolvedValue({ ...fixtureApplications[0], status: 'withdrawn' }),
    ...overrides,
  } as unknown as CatalogGovernanceAdapter
}

describe('CategoryApplicationPanel', () => {
  it('renders status/history, preserves the selected filter and exposes no internal fields', async () => {
    const api = adapter()
    const { container } = render(<CategoryApplicationPanel adapter={api} />)

    expect(await screen.findByTestId('application-row-101')).toHaveAttribute('data-status', 'pending')
    expect(screen.getByTestId('application-resolution-102')).toHaveTextContent('新建分类')
    expect(container).not.toHaveTextContent('reviewedByUserId')

    fireEvent.change(screen.getByTestId('merchant-application-status-filter'), { target: { value: 'approved' } })
    await waitFor(() => expect(api.listMyApplications).toHaveBeenLastCalledWith({
      status: 'approved', page: 1, pageSize: 10,
    }))
  })

  it('validates create input and prevents a second submit while the request is in flight', async () => {
    let resolve!: (value: typeof fixtureApplications[number]) => void
    const pending = new Promise<typeof fixtureApplications[number]>((r) => { resolve = r })
    const createApplication = vi.fn().mockReturnValue(pending)
    const api = adapter({ createApplication })
    render(<CategoryApplicationPanel adapter={api} />)
    await screen.findByTestId('application-row-101')

    fireEvent.click(screen.getByTestId('merchant-application-create'))
    fireEvent.change(screen.getByTestId('application-form-label'), { target: { value: '云工具' } })
    fireEvent.change(screen.getByTestId('application-form-description'), {
      target: { value: '这是一个用于验证分类申请流程的完整描述文本。' },
    })
    const submit = screen.getByTestId('application-form-submit')
    fireEvent.click(submit)
    expect(submit).toBeDisabled()
    fireEvent.click(submit)
    expect(createApplication).toHaveBeenCalledTimes(1)
    expect(createApplication).toHaveBeenCalledWith({
      proposedLabel: '云工具',
      description: '这是一个用于验证分类申请流程的完整描述文本。',
    })
    resolve(fixtureApplications[0])
    await waitFor(() => expect(screen.queryByTestId('application-form-submit')).not.toBeInTheDocument())
  })

})
