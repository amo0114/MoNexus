import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CatalogGovernanceAdapter } from '../../api/catalogGovernance'
import {
  fixtureAdminCategories,
  fixtureApplicationList,
  fixtureCategoryList,
} from '../../api/catalogGovernance.fixtures'
import AdminCategoryManager from './AdminCategoryManager'

function adapter(overrides: Partial<CatalogGovernanceAdapter> = {}): CatalogGovernanceAdapter {
  return {
    listCategories: vi.fn().mockResolvedValue(fixtureCategoryList),
    listAdminApplications: vi.fn().mockResolvedValue(fixtureApplicationList),
    deactivateCategory: vi.fn().mockResolvedValue({ ...fixtureAdminCategories[0], status: 'inactive' }),
    ...overrides,
  } as unknown as CatalogGovernanceAdapter
}

describe('AdminCategoryManager', () => {
  it('renders inactive historical semantics and keeps independent list filters', async () => {
    const api = adapter()
    render(<AdminCategoryManager adapter={api} />)

    expect(await screen.findByTestId('category-row-5')).toHaveAttribute('data-status', 'inactive')
    expect(screen.getByTestId('inactive-historical-label')).toHaveTextContent('已发布商品仍显示')
    expect(screen.getByTestId('application-row-101')).toHaveAttribute('data-status', 'pending')

    fireEvent.change(screen.getByTestId('admin-category-status-filter'), { target: { value: 'inactive' } })
    await waitFor(() => expect(api.listCategories).toHaveBeenLastCalledWith({
      status: 'inactive', page: 1, pageSize: 10,
    }))
    expect(screen.getByTestId('admin-application-status-filter')).toHaveValue('pending')
  })

  it('uses a confirmation step and disables duplicate category mutations', async () => {
    let resolve!: (value: typeof fixtureAdminCategories[number]) => void
    const pending = new Promise<typeof fixtureAdminCategories[number]>((r) => { resolve = r })
    const deactivateCategory = vi.fn().mockReturnValue(pending)
    const api = adapter({ deactivateCategory })
    render(<AdminCategoryManager adapter={api} />)
    await screen.findByTestId('category-row-1')

    fireEvent.click(screen.getByRole('button', { name: '停用分类 网络节点' }))
    const confirm = screen.getByRole('button', { name: '停用' })
    fireEvent.click(confirm)
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(deactivateCategory).toHaveBeenCalledTimes(1)
    expect(deactivateCategory).toHaveBeenCalledWith(1)
    resolve({ ...fixtureAdminCategories[0], status: 'inactive' })
    await waitFor(() => expect(screen.queryByRole('button', { name: '停用' })).not.toBeInTheDocument())
  })

})
