import { useRef, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import MobileSearchIsland from './MobileSearchIsland'
import { useAppStore } from '../stores/appStore'

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('../hooks/useMediaQuery', () => ({ useMediaQuery: () => motion.reduced }))

function Host() {
  const anchor = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [present, setPresent] = useState(false)
  return <div ref={anchor}>
    <button ref={trigger} onClick={() => setOpen(true)}>打开搜索</button>
    <span data-testid="present">{String(present)}</span>
    <MobileSearchIsland open={open} anchorRef={anchor} backdropRootRef={anchor} triggerRef={trigger} onClose={() => setOpen(false)} onPresenceChange={setPresent} />
  </div>
}
beforeEach(() => {
  vi.useFakeTimers()
  motion.reduced = false
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  useAppStore.setState({ storeQuery: '', modalDepth: 0 })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('retains the closing surface, disables its controls, then restores focus without losing the query', () => {
  render(<Host />)
  const trigger = screen.getByRole('button', { name: '打开搜索' })
  fireEvent.click(trigger)
  act(() => vi.advanceTimersByTime(40))
  const panel = screen.getByTestId('mobile-search-island')
  expect(panel).toHaveAttribute('data-open', 'true')
  const input = screen.getByRole('textbox', { name: '搜索商品' })
  fireEvent.change(input, { target: { value: '三国' } })
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(panel).toHaveAttribute('data-open', 'false')
  expect(panel.querySelector('.mobile-search-content')).toHaveAttribute('inert')
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.getByTestId('present')).toHaveTextContent('true')
  act(() => vi.advanceTimersByTime(349))
  expect(panel).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(1))
  expect(screen.queryByTestId('mobile-search-island')).toBeNull()
  act(() => vi.advanceTimersByTime(20))
  expect(trigger).toHaveFocus()
  fireEvent.click(trigger)
  expect(screen.getByRole('textbox')).toHaveValue('三国')
})

it('reverses a close when reopened and cancels the obsolete exit timer', () => {
  render(<Host />)
  fireEvent.click(screen.getByRole('button', { name: '打开搜索' }))
  act(() => vi.advanceTimersByTime(40))
  fireEvent.click(screen.getByRole('button', { name: '取消搜索' }))
  act(() => vi.advanceTimersByTime(100))
  fireEvent.click(screen.getByRole('button', { name: '打开搜索' }))
  act(() => vi.advanceTimersByTime(500))
  expect(screen.getByTestId('mobile-search-island')).toHaveAttribute('data-open', 'true')
  expect(screen.getByTestId('present')).toHaveTextContent('true')
  expect(screen.getByRole('textbox')).toHaveFocus()
})

it('does not retain an exit in reduced motion or steal focus from a new modal', () => {
  motion.reduced = true
  render(<Host />)
  fireEvent.click(screen.getByRole('button', { name: '打开搜索' }))
  useAppStore.setState({ modalDepth: 1 })
  fireEvent.click(screen.getByRole('button', { name: '取消搜索' }))
  expect(screen.queryByTestId('mobile-search-island')).toBeNull()
  act(() => vi.advanceTimersByTime(20))
  expect(screen.getByRole('button', { name: '打开搜索' })).not.toHaveFocus()
})

it('restores focus even when a frame runs before the close commits', () => {
  // Like Layout: the trigger cannot take focus while the surface is present (inert there).
  function InertHost() {
    const anchor = useRef<HTMLDivElement>(null)
    const trigger = useRef<HTMLButtonElement>(null)
    const [open, setOpen] = useState(false)
    const [present, setPresent] = useState(false)
    return <div ref={anchor}>
      <button ref={trigger} disabled={present} onClick={() => setOpen(true)}>打开搜索</button>
      <MobileSearchIsland open={open} anchorRef={anchor} backdropRootRef={anchor} triggerRef={trigger} onClose={() => setOpen(false)} onPresenceChange={setPresent} />
    </div>
  }
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const flushFrames = () => { for (const callback of frames.splice(0)) callback(0) }
  render(<InertHost />)
  const trigger = screen.getByRole('button', { name: '打开搜索' })
  fireEvent.click(trigger)
  act(() => { flushFrames(); flushFrames() })
  fireEvent.click(screen.getByRole('button', { name: '取消搜索' }))
  act(() => {
    vi.advanceTimersByTime(350)
    // The exit timer fired; a frame lands before React commits the unmount.
    flushFrames()
  })
  flushFrames()
  expect(screen.queryByTestId('mobile-search-island')).toBeNull()
  expect(trigger).toHaveFocus()
})
