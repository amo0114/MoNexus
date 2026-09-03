import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import AdminPanelHeader from './AdminPanelHeader'

describe('AdminPanelHeader Component', () => {
  it('renders title only when description and actions are omitted', () => {
    render(<AdminPanelHeader title="数据仪表盘" />)
    expect(screen.getByRole('heading', { level: 2, name: '数据仪表盘' })).toBeInTheDocument()
    expect(screen.queryByRole('paragraph')).not.toBeInTheDocument()
  })

  it('renders title with description', () => {
    render(
      <AdminPanelHeader
        title="商家管理"
        description="审核新商户入驻申请与管理已有商户"
      />,
    )
    expect(screen.getByRole('heading', { level: 2, name: '商家管理' })).toBeInTheDocument()
    expect(screen.getByText('审核新商户入驻申请与管理已有商户')).toBeInTheDocument()
  })

  it('renders actions slot alongside title and applies responsive layout classes', () => {
    render(
      <AdminPanelHeader
        title="商品与库存"
        actions={<button type="button">新建商品</button>}
        testId="admin-products-header"
        className="custom-header"
      />,
    )
    const header = screen.getByTestId('admin-products-header')
    expect(header).toBeInTheDocument()
    expect(header).toHaveClass('flex', 'flex-col', 'sm:flex-row', 'sm:items-center', 'sm:justify-between', 'custom-header')
    expect(screen.getByRole('button', { name: '新建商品' })).toBeInTheDocument()
  })
})
