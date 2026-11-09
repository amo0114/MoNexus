import { afterEach, describe, expect, it, vi } from 'vitest'

const confetti = vi.fn()
vi.mock('canvas-confetti', () => ({ default: confetti }))

const { celebrate } = await import('./celebrate')

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  confetti.mockReset()
})

describe('celebrate', () => {
  it('skips confetti when the user prefers reduced motion', async () => {
    stubReducedMotion(true)
    await celebrate()
    expect(confetti).not.toHaveBeenCalled()
  })

  it('fires confetti otherwise', async () => {
    stubReducedMotion(false)
    await celebrate()
    expect(confetti).toHaveBeenCalledWith(expect.objectContaining({ disableForReducedMotion: true }))
  })
})
