import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FavoriteIsland from './FavoriteIsland'
import type { IslandNotice } from '../stores/appStore'

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('../hooks/useMediaQuery', () => ({ useMediaQuery: () => motion.reduced }))
const notice: IslandNotice = { id: 1, kind: 'favorite', type: 'success', title: '已收藏', message: '已收藏', payload: { favorite: true } }

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); motion.reduced = false })

describe('FavoriteIsland handoff', () => {
  it('keeps navigation hidden until its outgoing heart has faded', () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(<FavoriteIsland notice={notice} onOpenChange={onOpenChange} />)
    act(() => vi.advanceTimersByTime(40))
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    rerender(<FavoriteIsland notice={null} onOpenChange={onOpenChange} />)
    expect(screen.getByTestId('favorite-island')).toBeDisabled()
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    act(() => vi.advanceTimersByTime(119))
    expect(screen.getByTestId('favorite-island')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByTestId('favorite-island')).toBeNull()
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('does not let an old exit timer clear a replacement favorite', () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(<FavoriteIsland notice={notice} onOpenChange={onOpenChange} />)
    act(() => vi.advanceTimersByTime(40))
    rerender(<FavoriteIsland notice={null} onOpenChange={onOpenChange} />)
    act(() => vi.advanceTimersByTime(60))
    rerender(<FavoriteIsland notice={{ ...notice, id: 2, title: '已取消收藏', payload: { favorite: false } }} onOpenChange={onOpenChange} />)
    act(() => vi.advanceTimersByTime(200))
    expect(screen.getByRole('button', { name: '已取消收藏，关闭提示' })).toBeEnabled()
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
  })

  it('immediately yields to a competing notification or modal, even during exit', () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(<FavoriteIsland notice={notice} onOpenChange={onOpenChange} />)
    act(() => vi.advanceTimersByTime(40))
    rerender(<FavoriteIsland notice={null} onOpenChange={onOpenChange} suppressed />)
    expect(screen.queryByTestId('favorite-island')).toBeNull()
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    rerender(<FavoriteIsland notice={notice} onOpenChange={onOpenChange} suppressed />)
    act(() => vi.advanceTimersByTime(200))
    expect(screen.queryByTestId('favorite-island')).toBeNull()
  })

  it('does not reserve a fading surface when reduced motion is enabled', () => {
    motion.reduced = true
    const onOpenChange = vi.fn()
    const { rerender } = render(<FavoriteIsland notice={notice} onOpenChange={onOpenChange} />)
    act(() => vi.advanceTimersByTime(40))
    rerender(<FavoriteIsland notice={null} onOpenChange={onOpenChange} />)
    expect(screen.queryByTestId('favorite-island')).toBeNull()
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })
})
