import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AdminPagination from './AdminPagination'

describe('AdminPagination', () => {
  it('renders record count and page indicator', () => {
    render(<AdminPagination page={1} total={45} pageSize={20} onPageChange={vi.fn()} />)
    expect(screen.getByText('共 45 条记录，第 1 / 3 页')).toBeInTheDocument()
  })

  it('navigates to previous and next pages', () => {
    const onPageChange = vi.fn()
    render(<AdminPagination page={2} total={50} pageSize={20} onPageChange={onPageChange} />)

    const prevBtn = screen.getByRole('button', { name: '上一页' })
    const nextBtn = screen.getByRole('button', { name: '下一页' })

    expect(prevBtn).toBeEnabled()
    expect(nextBtn).toBeEnabled()

    fireEvent.click(prevBtn)
    expect(onPageChange).toHaveBeenCalledWith(1)

    fireEvent.click(nextBtn)
    expect(onPageChange).toHaveBeenCalledWith(3)
  })

  it('disables previous button on first page and next button on last page', () => {
    const { rerender } = render(<AdminPagination page={1} total={40} pageSize={20} onPageChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled()

    rerender(<AdminPagination page={2} total={40} pageSize={20} onPageChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: '上一页' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
  })

  it('jumps to specified page when using quick jumper and clamps bounds', () => {
    const onPageChange = vi.fn()
    render(<AdminPagination page={1} total={100} pageSize={20} onPageChange={onPageChange} showQuickJumper={true} />)

    const input = screen.getByLabelText('跳转页码')
    const jumpBtn = screen.getByRole('button', { name: '跳转' })

    // Valid jump
    fireEvent.change(input, { target: { value: '3' } })
    fireEvent.click(jumpBtn)
    expect(onPageChange).toHaveBeenCalledWith(3)

    // Out of bounds jump clamped to totalPages (5)
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.click(jumpBtn)
    expect(onPageChange).toHaveBeenCalledWith(5)

    // Negative page clamped to 1
    fireEvent.change(input, { target: { value: '-1' } })
    fireEvent.click(jumpBtn)
    expect(onPageChange).toHaveBeenCalledWith(1)
  })

  it('supports hiding on single page when hideOnSinglePage is true', () => {
    const { container } = render(
      <AdminPagination page={1} total={10} pageSize={20} onPageChange={vi.fn()} hideOnSinglePage={true} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('clamps display and notifies parent when incoming page exceeds totalPages due to shrinkage', () => {
    const onPageChange = vi.fn()
    // Total is 30, pageSize is 20 -> totalPages is 2. Page 5 is passed in.
    const { rerender } = render(
      <AdminPagination page={5} total={30} pageSize={20} onPageChange={onPageChange} />
    )

    // Displays clamped page 2 instead of 5 / 2
    expect(screen.getByText('共 30 条记录，第 2 / 2 页')).toBeInTheDocument()
    expect(screen.queryByText(/第 5 \/ 2 页/)).not.toBeInTheDocument()
    expect(onPageChange).toHaveBeenCalledWith(2)

    // Dynamic shrink: total shrinks from 30 to 10 (totalPages = 1) while on page 2
    onPageChange.mockClear()
    rerender(<AdminPagination page={2} total={10} pageSize={20} onPageChange={onPageChange} />)
    expect(screen.getByText('共 10 条记录，第 1 / 1 页')).toBeInTheDocument()
    expect(onPageChange).toHaveBeenCalledWith(1)
  })

  it('clamps display and notifies parent when incoming page is below 1', () => {
    const onPageChange = vi.fn()
    render(<AdminPagination page={0} total={50} pageSize={20} onPageChange={onPageChange} />)
    expect(screen.getByText('共 50 条记录，第 1 / 3 页')).toBeInTheDocument()
    expect(onPageChange).toHaveBeenCalledWith(1)
  })
})
