import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { FluidSegmentedControl } from './FluidSegmentedControl'

describe('FluidSegmentedControl', () => {
  const options = [
    { key: 'all', label: '全部', testId: 'tab-all' },
    { key: 'active', label: '进行中', badgeCount: 3, testId: 'tab-active' },
    { key: 'completed', label: '已完成', disabled: true, testId: 'tab-completed' },
  ]

  it('renders all options and selects the active one', () => {
    render(<FluidSegmentedControl options={options} value="all" onChange={() => {}} />)

    const allTab = screen.getByTestId('tab-all')
    const activeTab = screen.getByTestId('tab-active')
    const completedTab = screen.getByTestId('tab-completed')

    expect(allTab).toHaveAttribute('aria-selected', 'true')
    expect(activeTab).toHaveAttribute('aria-selected', 'false')
    expect(completedTab).toBeDisabled()
  })

  it('calls onChange when clicking a non-active option', () => {
    const handleChange = vi.fn()
    render(<FluidSegmentedControl options={options} value="all" onChange={handleChange} />)

    fireEvent.click(screen.getByTestId('tab-active'))
    expect(handleChange).toHaveBeenCalledWith('active')
  })

  it('does not call onChange when clicking a disabled option', () => {
    const handleChange = vi.fn()
    render(<FluidSegmentedControl options={options} value="all" onChange={handleChange} />)

    fireEvent.click(screen.getByTestId('tab-completed'))
    expect(handleChange).not.toHaveBeenCalled()
  })

  it('displays badge count correctly', () => {
    render(<FluidSegmentedControl options={options} value="all" onChange={() => {}} />)

    expect(screen.getByText('3')).toBeInTheDocument()
  })
})
