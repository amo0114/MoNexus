import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  resetRechargeNavAvailabilityCache,
  useRechargeNavAvailable,
} from './useRechargeNavAvailable'

const { getRechargeConfig } = vi.hoisted(() => ({
  getRechargeConfig: vi.fn(),
}))

vi.mock('../api/recharge', () => ({
  getRechargeConfig,
}))

function disabledError() {
  return {
    response: {
      data: {
        error: { code: 'RECHARGE_DISABLED', message: 'recharge disabled' },
      },
    },
  }
}

/** Transport-level failure: no server error code at all. */
function networkError() {
  return new TypeError('Network Error')
}

/** A coded failure that is NOT the explicit "recharge closed" signal. */
function serverError(code: string) {
  return {
    response: {
      data: {
        error: { code, message: 'boom' },
      },
    },
  }
}

describe('useRechargeNavAvailable', () => {
  beforeEach(() => {
    resetRechargeNavAvailabilityCache()
    getRechargeConfig.mockReset()
  })

  afterEach(() => {
    resetRechargeNavAvailabilityCache()
  })

  it('hides nav once the server reports RECHARGE_DISABLED', async () => {
    getRechargeConfig.mockRejectedValue(disabledError())
    const { result } = renderHook(() => useRechargeNavAvailable())

    // Fail-open default while the probe is in flight.
    expect(result.current).toBe(true)

    await waitFor(() => {
      expect(getRechargeConfig).toHaveBeenCalledWith('CNY')
    })

    // The explicit disabled verdict is the only thing that hides the entry.
    await waitFor(() => {
      expect(result.current).toBe(false)
    })
  })

  it('shows nav when config loads successfully', async () => {
    getRechargeConfig.mockResolvedValue({
      currency: 'CNY',
      mode: 'live',
      providers: [],
    })
    const { result } = renderHook(() => useRechargeNavAvailable())
    await waitFor(() => {
      expect(result.current).toBe(true)
    })
  })

  it('keeps nav visible on a network failure (fail-open, not "closed")', async () => {
    getRechargeConfig.mockRejectedValue(networkError())
    const { result } = renderHook(() => useRechargeNavAvailable())

    // Fail-open while the probe is still in flight.
    expect(result.current).toBe(true)

    await waitFor(() => {
      expect(getRechargeConfig).toHaveBeenCalledWith('CNY')
    })

    // Still visible after the failure settles: only an explicit
    // RECHARGE_DISABLED answer may hide the entry.
    expect(result.current).toBe(true)
  })

  it('keeps nav visible on a coded error that is not RECHARGE_DISABLED', async () => {
    getRechargeConfig.mockRejectedValue(serverError('INTERNAL_SERVER_ERROR'))
    const { result } = renderHook(() => useRechargeNavAvailable())

    await waitFor(() => {
      expect(getRechargeConfig).toHaveBeenCalledWith('CNY')
    })

    expect(result.current).toBe(true)
  })

  it('enabled answer wins over the initial fail-open default', async () => {
    getRechargeConfig.mockResolvedValue({
      currency: 'CNY',
      mode: 'live',
      providers: [],
    })
    const { result } = renderHook(() => useRechargeNavAvailable())
    expect(result.current).toBe(true)
    await waitFor(() => {
      expect(result.current).toBe(true)
    })
  })

  it('shares one probe across concurrent hook mounts', async () => {
    let resolveConfig!: (value: unknown) => void
    getRechargeConfig.mockReturnValue(
      new Promise((resolve) => {
        resolveConfig = resolve
      }),
    )

    const first = renderHook(() => useRechargeNavAvailable())
    const second = renderHook(() => useRechargeNavAvailable())
    expect(getRechargeConfig).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveConfig({ currency: 'CNY', mode: 'live', providers: [] })
    })

    await waitFor(() => {
      expect(first.result.current).toBe(true)
      expect(second.result.current).toBe(true)
    })
    expect(getRechargeConfig).toHaveBeenCalledTimes(1)
  })

  it('shares a cached disabled verdict across mounts', async () => {
    getRechargeConfig.mockRejectedValue(disabledError())

    const first = renderHook(() => useRechargeNavAvailable())
    await waitFor(() => {
      expect(first.result.current).toBe(false)
    })

    // A second mount reads the cached verdict and must not re-probe.
    const callsAfterFirst = getRechargeConfig.mock.calls.length
    const second = renderHook(() => useRechargeNavAvailable())
    expect(second.result.current).toBe(false)
    await waitFor(() => {
      expect(second.result.current).toBe(false)
    })
    expect(getRechargeConfig.mock.calls.length).toBe(callsAfterFirst)
  })})
