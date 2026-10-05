import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import AnimatedCounter from './AnimatedCounter'

describe('AnimatedCounter real rendering', () => {
  it('exposes the formatted value while rendering reels, then updates their target digits', () => {
    const { rerender } = render(<AnimatedCounter value={12.5} decimals={2} prefix="¥" suffix=" 元" />)
    const counter = screen.getByRole('img', { name: '¥12.50 元' })
    expect(counter.querySelectorAll('.odometer-reel-track')).toHaveLength(4)
    expect(counter.querySelector('.odometer-chars')).toHaveAttribute('aria-hidden', 'true')
    rerender(<AnimatedCounter value={-9.25} decimals={2} prefix="¥" suffix=" 元" />)
    const updated = screen.getByRole('img', { name: '¥-9.25 元' })
    expect(Array.from(updated.querySelectorAll<HTMLElement>('.odometer-reel-track'), el => el.style.transform))
      .toEqual(['translateY(-90%)', 'translateY(-20%)', 'translateY(-50%)'])
  })

  it('respects custom formatting including non-digit characters', () => {
    render(<AnimatedCounter value={1200} formatFn={() => '1,200'} suffix=" 积分" />)
    expect(screen.getByRole('img', { name: '1,200 积分' }).querySelector('.odometer-static')).toHaveTextContent(',')
  })
})
