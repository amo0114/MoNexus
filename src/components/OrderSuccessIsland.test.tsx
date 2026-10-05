import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OrderSuccessIsland from './OrderSuccessIsland'
import type { IslandNotice } from '../stores/appStore'

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('../hooks/useMediaQuery', () => ({ useMediaQuery: () => motion.reduced }))
const success: IslandNotice = { id: 1, kind: 'order_success', type: 'success', title: '兑换成功', message: '兑换成功' }
const callbacks = { onOpenChange: vi.fn(), onHeightChange: vi.fn(), onPhaseChange: vi.fn() }

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const original = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const style = original(element)
    const get = style.getPropertyValue.bind(style)
    const clocks: Record<string, string> = { '--order-island-spin': '800ms', '--order-island-confirm': '800ms', '--order-island-close': '350ms' }
    style.getPropertyValue = (name) => clocks[name] ?? get(name)
    return style
  })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); motion.reduced = false })

describe('order confirmation presentation', () => {
  it('reaches details for an accepted order even if no animation event arrives', () => {
    const { container } = render(<OrderSuccessIsland {...callbacks} notice={success} obscured={false} />)
    act(() => vi.advanceTimersByTime(40))
    expect(container.firstChild).toHaveAttribute('data-phase', 'processing')
    act(() => vi.advanceTimersByTime(1600))
    expect(container.firstChild).toHaveAttribute('data-phase', 'confirmed')
    act(() => vi.advanceTimersByTime(800))
    expect(container.firstChild).toHaveAttribute('data-phase', 'details')
  })

  it('never confirms an unresolved request, including after replacing a successful notice', () => {
    const { container, rerender } = render(<OrderSuccessIsland {...callbacks} notice={success} obscured={false} />)
    act(() => vi.advanceTimersByTime(40))
    rerender(<OrderSuccessIsland {...callbacks} notice={{ ...success, id: 2, kind: 'order_processing', type: 'info' }} obscured={false} />)
    act(() => vi.advanceTimersByTime(4000))
    fireEvent.animationIteration(container.querySelector('.order-island-spinner')!)
    expect(container.firstChild).toHaveAttribute('data-phase', 'processing')
  })

  it('still uses the normal animation boundary and cancels its fallback', () => {
    const { container } = render(<OrderSuccessIsland {...callbacks} notice={success} obscured={false} />)
    act(() => vi.advanceTimersByTime(40))
    fireEvent.animationIteration(container.querySelector('.order-island-spinner')!)
    expect(container.firstChild).toHaveAttribute('data-phase', 'confirmed')
    act(() => vi.advanceTimersByTime(800))
    expect(container.firstChild).toHaveAttribute('data-phase', 'details')
    act(() => vi.advanceTimersByTime(1600))
    expect(container.firstChild).toHaveAttribute('data-phase', 'details')
  })

  it('skips celebration in reduced motion but not the server confirmation requirement', () => {
    motion.reduced = true
    const { container, rerender } = render(<OrderSuccessIsland {...callbacks} notice={{ ...success, kind: 'order_processing' }} obscured={false} />)
    act(() => vi.advanceTimersByTime(40))
    expect(container.firstChild).toHaveAttribute('data-phase', 'processing')
    rerender(<OrderSuccessIsland {...callbacks} notice={success} obscured={false} />)
    act(() => vi.advanceTimersByTime(40))
    expect(container.firstChild).toHaveAttribute('data-phase', 'details')
  })
})
