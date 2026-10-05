import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import OrdersPagination from './OrdersPagination'

describe('OrdersPagination', () => {
  it('renders record counts and pagination buttons', () => {
    const onPageChange = vi.fn()
    const onPageSizeChange = vi.fn()

    render(
      <OrdersPagination
        page={1}
        total={25}
        pageSize={10}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />,
    )

    // Record count
    expect(screen.getByText('1-10')).toBeInTheDocument()
    expect(screen.getByText('25')).toBeInTheDocument()

    // Page buttons: 1, 2, 3
    expect(screen.getByTestId('orders-page-number-1')).toBeInTheDocument()
    expect(screen.getByTestId('orders-page-number-2')).toBeInTheDocument()
    expect(screen.getByTestId('orders-page-number-3')).toBeInTheDocument()

    // Prev disabled on page 1
    const prev = screen.getByTestId('orders-page-prev')
    expect(prev).toBeDisabled()

    // Next enabled on page 1
    const next = screen.getByTestId('orders-page-next')
    expect(next).not.toBeDisabled()

    // Click page 2
    fireEvent.click(screen.getByTestId('orders-page-number-2'))
    expect(onPageChange).toHaveBeenCalledWith(2)

    // Click next
    fireEvent.click(next)
    expect(onPageChange).toHaveBeenCalledWith(2)
  })

  it('handles page size change', () => {
    const onPageSizeChange = vi.fn()
    render(
      <OrdersPagination
        page={1}
        total={50}
        pageSize={10}
        onPageChange={vi.fn()}
        onPageSizeChange={onPageSizeChange}
      />,
    )

    const select = screen.getByTestId('orders-page-size-select')
    fireEvent.change(select, { target: { value: '20' } })
    expect(onPageSizeChange).toHaveBeenCalledWith(20)
  })

  it('disables next on last page', () => {
    render(
      <OrdersPagination
        page={3}
        total={25}
        pageSize={10}
        onPageChange={vi.fn()}
      />,
    )

    expect(screen.getByTestId('orders-page-next')).toBeDisabled()
    expect(screen.getByTestId('orders-page-prev')).not.toBeDisabled()
  })

  it('renders nothing when total is 0', () => {
    const { container } = render(
      <OrdersPagination
        page={1}
        total={0}
        pageSize={10}
        onPageChange={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})
