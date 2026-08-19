import { setProviderCircuitOpen } from '../metrics.js'
import { PAYMENT_PROVIDER_NAMES } from '../../recharge/types.js'

const FAILURE_THRESHOLD = 5
const OPEN_MS = 60_000

type Circuit = {
  failures: number
  openUntil: number
}

const circuits = new Map<string, Circuit>()

function circuitOf(provider: string): Circuit {
  const existing = circuits.get(provider)
  if (existing) return existing
  const created = { failures: 0, openUntil: 0 }
  circuits.set(provider, created)
  return created
}

export function isProviderCircuitOpen(provider: string, now = Date.now()): boolean {
  const circuit = circuitOf(provider)
  if (circuit.openUntil === 0) return false
  if (circuit.openUntil <= now) {
    circuit.openUntil = 0
    circuit.failures = 0
    setProviderCircuitOpen(provider, false)
    return false
  }
  return true
}

export function recordProviderQuerySuccess(provider: string) {
  const circuit = circuitOf(provider)
  circuit.failures = 0
  circuit.openUntil = 0
  setProviderCircuitOpen(provider, false)
}

export function recordProviderQueryFailure(provider: string, now = Date.now()): boolean {
  const circuit = circuitOf(provider)
  circuit.failures += 1
  if (circuit.failures < FAILURE_THRESHOLD) {
    setProviderCircuitOpen(provider, isProviderCircuitOpen(provider, now))
    return false
  }
  circuit.openUntil = now + OPEN_MS
  setProviderCircuitOpen(provider, true)
  return true
}

export function resetProviderCircuitsForTests() {
  circuits.clear()
  for (const name of PAYMENT_PROVIDER_NAMES) {
    setProviderCircuitOpen(name, false)
  }
}

export const PROVIDER_QUERY_CIRCUIT = {
  failureThreshold: FAILURE_THRESHOLD,
  openMs: OPEN_MS,
} as const
