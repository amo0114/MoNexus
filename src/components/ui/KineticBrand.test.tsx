import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import KineticBrand from './KineticBrand'

describe('KineticBrand', () => {
  it('renders initial expanded state correctly', () => {
    render(<KineticBrand isCondensed={false} />)
    const button = screen.getByRole('button', { name: 'MoNexus 首页' })
    expect(button).toBeInTheDocument()
    expect(screen.getByText('M')).toBeInTheDocument()
    expect(screen.getByText('ONE')).toBeInTheDocument()
    expect(screen.getByText('X')).toBeInTheDocument()
    expect(screen.getByText('US')).toBeInTheDocument()
  })

  it('renders condensed state (M · X) correctly', () => {
    const { container } = render(<KineticBrand isCondensed={true} />)
    const button = screen.getByRole('button', { name: 'MoNexus 首页' })
    expect(button).toBeInTheDocument()

    // M and X are visible
    expect(screen.getByText('M')).toBeInTheDocument()
    expect(screen.getByText('X')).toBeInTheDocument()

    // ONE and US are aria-hidden when condensed
    const hiddenGroups = container.querySelectorAll('[aria-hidden="true"]')
    expect(hiddenGroups.length).toBeGreaterThan(0)
  })

  it('shows admin badge when isAdminPage is true', () => {
    render(<KineticBrand isAdminPage={true} />)
    expect(screen.getByText('管理后台')).toBeInTheDocument()
  })

  it('hides admin badge when isAdminPage is false', () => {
    render(<KineticBrand isAdminPage={false} />)
    expect(screen.queryByText('管理后台')).not.toBeInTheDocument()
  })
})
