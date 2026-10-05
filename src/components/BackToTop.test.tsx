import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import BackToTop from './BackToTop'
import { useAppStore } from '../stores/appStore'

describe('BackToTop', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.scrollTo = vi.fn()
    useAppStore.setState({ tabbarHidden: false })
  })

  it('renders with button accessible role and hidden by default when scrollY is 0', () => {
    Object.defineProperty(window, 'scrollY', { value: 0, writable: true })
    render(<BackToTop threshold={400} />)

    const btn = screen.getByRole('button', { name: '回到顶部' })
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('opacity-0')
    expect(btn.className).toContain('pointer-events-none')
  })

  it('becomes visible when scrollY exceeds threshold', () => {
    Object.defineProperty(window, 'scrollY', { value: 500, writable: true })
    render(<BackToTop threshold={400} />)

    act(() => {
      fireEvent.scroll(window)
    })

    const btn = screen.getByRole('button', { name: '回到顶部' })
    expect(btn.className).toContain('opacity-100')
    expect(btn.className).toContain('pointer-events-auto')
  })

  it('calls window.scrollTo with smooth behavior on click', () => {
    Object.defineProperty(window, 'scrollY', { value: 600, writable: true })
    render(<BackToTop threshold={400} />)

    const btn = screen.getByRole('button', { name: '回到顶部' })
    fireEvent.click(btn)

    expect(window.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: 'smooth',
    })
  })

  it('adjusts mobile bottom position according to tabbarHidden', () => {
    Object.defineProperty(window, 'scrollY', { value: 600, writable: true })
    const { rerender } = render(<BackToTop threshold={400} />)

    let btn = screen.getByRole('button', { name: '回到顶部' })
    expect(btn.style.bottom).toBe('calc(var(--tabbar-h, 56px) + var(--safe-bottom, 0px) + 1.25rem)')

    act(() => {
      useAppStore.setState({ tabbarHidden: true })
    })
    rerender(<BackToTop threshold={400} />)

    btn = screen.getByRole('button', { name: '回到顶部' })
    expect(btn.style.bottom).toBe('calc(var(--safe-bottom, 0px) + 1.25rem)')
  })

  it('honors custom bottomOffset prop', () => {
    Object.defineProperty(window, 'scrollY', { value: 600, writable: true })
    render(<BackToTop threshold={400} bottomOffset="calc(5rem + var(--safe-bottom))" />)

    const btn = screen.getByRole('button', { name: '回到顶部' })
    expect(btn.style.bottom).toBe('calc(5rem + var(--safe-bottom))')
  })
})
