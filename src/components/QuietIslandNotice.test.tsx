import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import QuietIslandNotice from './QuietIslandNotice'
import type { IslandNotice } from '../stores/appStore'

const notice: IslandNotice = { id: 1, type: 'success', message: '打卡成功' }
afterEach(() => vi.useRealTimers())

describe('QuietIslandNotice presence', () => {
  it('retains a non-interactive exit surface until the navbar can return', () => {
    vi.useFakeTimers()
    const onVisibleChange = vi.fn()
    const props = { onVisibleChange, onDismiss: vi.fn(), suppressed: false }
    const { rerender } = render(<QuietIslandNotice {...props} notice={notice} />)
    expect(onVisibleChange).toHaveBeenLastCalledWith(true)
    rerender(<QuietIslandNotice {...props} notice={null} />)
    expect(screen.getByTestId('quiet-island-notice')).toBeDisabled()
    expect(onVisibleChange).toHaveBeenLastCalledWith(true)
    act(() => { vi.advanceTimersByTime(250) })
    expect(screen.queryByTestId('quiet-island-notice')).toBeNull()
    expect(onVisibleChange).toHaveBeenLastCalledWith(false)
  })

  it('does not let an old exit timer remove a replacement notice', () => {
    vi.useFakeTimers()
    const props = { onVisibleChange: vi.fn(), onDismiss: vi.fn(), suppressed: false }
    const { rerender } = render(<QuietIslandNotice {...props} notice={notice} />)
    rerender(<QuietIslandNotice {...props} notice={null} />)
    act(() => { vi.advanceTimersByTime(100) })
    rerender(<QuietIslandNotice {...props} notice={{ ...notice, id: 2, message: '复制成功' }} />)
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByRole('button', { name: '复制成功，关闭提示' })).toBeEnabled()
    expect(props.onVisibleChange).toHaveBeenLastCalledWith(true)
  })

  it('immediately yields the surface to another activity or a modal', () => {
    const props = { onVisibleChange: vi.fn(), onDismiss: vi.fn() }
    const { rerender } = render(<QuietIslandNotice {...props} notice={notice} suppressed={false} />)
    rerender(<QuietIslandNotice {...props} notice={notice} suppressed />)
    expect(screen.queryByTestId('quiet-island-notice')).toBeNull()
    expect(props.onVisibleChange).toHaveBeenLastCalledWith(false)
  })

  it('makes copy feedback dismissible by keyboard', () => {
    const onDismiss = vi.fn()
    render(<QuietIslandNotice notice={{ ...notice, kind: 'copy', title: '已复制' }} suppressed={false} onDismiss={onDismiss} onVisibleChange={vi.fn()} />)
    const button = screen.getByRole('button', { name: '已复制，关闭提示' })
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
