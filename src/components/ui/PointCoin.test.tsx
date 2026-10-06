import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import PointCoin from './PointCoin'

describe('PointCoin component (方案一：平台专属品牌代币)', () => {
  it('renders default gold variant with gradient definitions and M glyph', () => {
    const { container } = render(<PointCoin />)
    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
    expect(screen.getByTestId('point-coin-gold')).toBeInTheDocument()

    // 检查渐变与几何图腾定义
    expect(container.querySelector('defs')).toBeInTheDocument()
    expect(container.querySelectorAll('circle').length).toBe(4) // outer disk, outer rim, inner core, dash milled edge
    expect(container.querySelectorAll('path').length).toBe(3) // shadow, body glyph, specular highlight
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
