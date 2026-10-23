import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ScratchReveal from './ScratchReveal'

function Controlled({ onReveal = () => {} }: { onReveal?: () => void }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <ScratchReveal
      revealed={revealed}
      onReveal={() => {
        onReveal()
        setRevealed(true)
      }}
    >
      <div data-testid="secret">CARD-1234-ABCD</div>
    </ScratchReveal>
  )
}

describe('ScratchReveal', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('hides the secret from assistive tech and focus until revealed', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    render(<Controlled />)

    const content = screen.getByTestId('secret').parentElement!
    expect(content).toHaveAttribute('aria-hidden', 'true')
    expect(content).toHaveAttribute('inert')
    expect(screen.getByRole('button', { name: '直接揭示' })).toBeVisible()
  })

  it('reveals through the button when no 2D canvas is available', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const onReveal = vi.fn()
    render(<Controlled onReveal={onReveal} />)

    fireEvent.click(screen.getByRole('button', { name: '直接揭示' }))

    expect(onReveal).toHaveBeenCalledTimes(1)
    const content = screen.getByTestId('secret').parentElement!
    expect(content).toHaveAttribute('aria-hidden', 'false')
    expect(content).not.toHaveAttribute('inert')
    expect(screen.queryByRole('button', { name: '直接揭示' })).not.toBeInTheDocument()
    expect(screen.getByTestId('scratch-reveal')).toHaveAttribute('data-revealed', 'true')
  })

  it('starts revealed when the parent already revealed it', () => {
    render(
      <ScratchReveal revealed onReveal={() => {}}>
        <div data-testid="secret">CARD</div>
      </ScratchReveal>,
    )

    expect(screen.getByTestId('secret').parentElement).not.toHaveAttribute('inert')
    expect(screen.queryByRole('button', { name: '直接揭示' })).not.toBeInTheDocument()
  })

  it('reveals once enough of the coat is scratched away', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const ctx = {
      setTransform: vi.fn(),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      // Every sampled pixel transparent = fully scratched.
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    Object.assign(HTMLElement.prototype, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
    })
    const onReveal = vi.fn()
    const { container } = render(<Controlled onReveal={onReveal} />)
    const canvas = container.querySelector('canvas')!

    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 })
    fireEvent.pointerMove(canvas, { clientX: 80, clientY: 20 })
    expect(onReveal).not.toHaveBeenCalled()
    fireEvent.pointerUp(canvas)

    expect(ctx.stroke).toHaveBeenCalled()
    expect(onReveal).toHaveBeenCalledTimes(1)
    // Debris is cleared with the reveal rather than left animating.
    expect(ctx.clearRect).toHaveBeenCalled()
    expect(screen.getByTestId('secret').parentElement).toHaveAttribute('aria-hidden', 'false')
  })
})
