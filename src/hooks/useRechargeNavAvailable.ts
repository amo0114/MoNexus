import { useEffect, useState } from 'react'
import { getRechargeConfig } from '../api/recharge'
import { getApiErrorCode } from '../api/error'

/**
 * Whether chrome (header / drawer) should expose a recharge entry.
 * Probes the same `/recharge/config` gate RechargeCheckout uses: only show
 * the CTA when the server accepts the probe. RECHARGE_DISABLED hides it so
 * a closed mode never looks payable.
 */
export type RechargeNavAvailability = 'unknown' | 'enabled' | 'disabled'

let cached: RechargeNavAvailability | null = null
let inflight: Promise<RechargeNavAvailability> | null = null

async function probeRechargeNavAvailability(): Promise<RechargeNavAvailability> {
  if (cached) return cached
  if (inflight) return inflight

  inflight = (async () => {
    try {
      // CNY is the always-probed currency in RechargeCheckout boot.
      await getRechargeConfig('CNY')
      cached = 'enabled'
    } catch (err) {
      cached = getApiErrorCode(err) === 'RECHARGE_DISABLED' ? 'disabled' : 'unknown'
    } finally {
      inflight = null
    }
    return cached!
  })()

  return inflight
}

/** Test helper — clears the module cache between cases. */
export function resetRechargeNavAvailabilityCache() {
  cached = null
  inflight = null
}

/**
 * Returns true only when recharge config is reachable (feature on).
 * Hidden while probing or when the server reports RECHARGE_DISABLED.
 */
export function useRechargeNavAvailable(): boolean {
  const [availability, setAvailability] = useState<RechargeNavAvailability>(
    cached ?? 'unknown',
  )

  useEffect(() => {
    let alive = true
    void probeRechargeNavAvailability().then((next) => {
      if (alive) setAvailability(next)
    })
    return () => {
      alive = false
    }
  }, [])

  return availability === 'enabled'
}
