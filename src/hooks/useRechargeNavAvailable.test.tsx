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

describe('useRechargeNavAvailable', () => {
  beforeEach(() => {
    resetRechargeNavAvailabilityCache()
    getRechargeConfig.mockReset()
  })

  afterEach(() => {
    resetRechargeNavAvailabilityCache()
  })

  it('hides nav when server reports RECHARGE_DISABLED', async () => {
    getRechargeConfig.mockRejectedValue(disabledError())
    const { result } = renderHook(() => useRechargeNavAvailable())
    expect(result.current).toBe(false)
    await waitFor(() => {
      expect(getRechargeConfig).toHaveBeenCalledWith('CNY')
    })
    expect(result.current).toBe(false)
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
})
