import { describe, expect, it, vi, beforeEach } from 'vitest'
import { copyToClipboard } from './clipboard'

describe('copyToClipboard', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns false when text is empty', async () => {
    const res = await copyToClipboard('')
    expect(res).toBe(false)
  })

  it('calls navigator.clipboard.writeText and returns true on success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText,
      },
    })

    const res = await copyToClipboard('hello world')
    expect(res).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello world')
  })

  it('returns false when writeText rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'))
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText,
      },
    })

    const res = await copyToClipboard('secret')
    expect(res).toBe(false)
  })

  it('returns false when clipboard API is missing', async () => {
    vi.stubGlobal('navigator', {})
    const res = await copyToClipboard('secret')
    expect(res).toBe(false)
  })
})
