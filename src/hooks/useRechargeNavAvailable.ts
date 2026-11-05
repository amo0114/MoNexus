import { useEffect, useState } from 'react'
import { getRechargeConfig } from '../api/recharge'
import { getApiErrorCode } from '../api/error'

/**
 * Whether chrome (header / drawer) should expose a recharge entry.
 * Probes the same `/recharge/config` gate RechargeCheckout uses.
 *
 * Fail-open by design: only an explicit RECHARGE_DISABLED answer hides the
 * entry. Transport/unknown failures keep it visible, because hiding a working
 * entry on a transient network blip is worse than briefly showing one that
 * 403s; the checkout page still enforces the real gate server-side.
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
 * Returns false only when the server explicitly reports RECHARGE_DISABLED.
 * Unknown (probe in flight, or transport/other failure) reports true so a
 * transient error never hides a working entry.
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

  return availability !== 'disabled'
}
