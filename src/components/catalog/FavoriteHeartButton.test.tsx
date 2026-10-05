import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FavoriteHeartButton from './FavoriteHeartButton'

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('../../hooks/useMediaQuery', () => ({ useMediaQuery: () => motion.reduced }))
afterEach(() => { vi.useRealTimers(); motion.reduced = false })

describe('favorite celebration lifecycle', () => {
  it('clears an interrupted burst and starts a fresh one on the next like', () => {
    vi.useFakeTimers()
    const view = (favorite: boolean) => <FavoriteHeartButton favorite={favorite} onClick={vi.fn()} ariaLabel="收藏商品" />
    const { rerender } = render(view(false))
    const button = screen.getByRole('button')
    rerender(view(true))
    const firstBurst = button.querySelector('.t-like-particles')
    expect(firstBurst).not.toBeNull()
    act(() => vi.advanceTimersByTime(100))
    rerender(view(false))
    expect(button).not.toHaveClass('is-bursting')
    expect(button.querySelector('.t-like-particles')).toBeNull()
    rerender(view(true))
    expect(button.querySelector('.t-like-particles')).not.toBe(firstBurst)
    act(() => vi.advanceTimersByTime(800))
    expect(button.querySelector('.t-like-particles')).toBeNull()
    expect(button).toHaveAttribute('aria-pressed', 'true')
  })

  it('does not celebrate initial persisted favorites and supplies an icon-only name', () => {
    render(<FavoriteHeartButton favorite onClick={vi.fn()} />)
    expect(screen.getByRole('button', { name: '已收藏' })).not.toHaveClass('is-bursting')
  })

  it('keeps the selected state without particles in reduced motion', () => {
    motion.reduced = true
    const { rerender } = render(<FavoriteHeartButton favorite={false} onClick={vi.fn()} />)
    rerender(<FavoriteHeartButton favorite onClick={vi.fn()} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button').querySelector('.t-like-particles')).toBeNull()
  })
})
