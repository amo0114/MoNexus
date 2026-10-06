import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import PointCoin from './PointCoin'

describe('PointCoin component (MoNexus 平台官方品牌代币)', () => {
  it('renders default gold variant with MoNexus Ledger Knot geometry (high contrast)', () => {
    const { container } = render(<PointCoin />)
    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
    expect(screen.getByTestId('point-coin-gold')).toBeInTheDocument()

    // 渐变与立体铸币结构
    expect(container.querySelector('defs')).toBeInTheDocument()
    expect(container.querySelectorAll('circle').length).toBe(8)
    expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(5)
  })

  it('renders mx motif variant with M·X monogram', () => {
    const { container } = render(<PointCoin motif="mx" />)
    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
    expect(container.querySelectorAll('circle').length).toBe(10) // 8 base circles + 2 for M·X center dot + shadow
  })

  it('renders silver variant with slate metallic tones', () => {
    render(<PointCoin variant="silver" />)
    expect(screen.getByTestId('point-coin-silver')).toBeInTheDocument()
  })

  it('renders purple variant with royal amethyst tones', () => {
    render(<PointCoin variant="purple" />)
    expect(screen.getByTestId('point-coin-purple')).toBeInTheDocument()
  })

  it('renders current variant for monochrome inline inheritence', () => {
    render(<PointCoin variant="current" className="text-amber-500" />)
    const el = screen.getByTestId('point-coin-current')
    expect(el).toBeInTheDocument()
    expect(el).toHaveClass('text-amber-500')
  })

  it('applies custom size style and className correctly', () => {
    const { container } = render(<PointCoin size={28} className="w-7 h-7 custom-coin" />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveStyle({ width: '28px', height: '28px' })
    expect(svg).toHaveClass('custom-coin')
  })
})
