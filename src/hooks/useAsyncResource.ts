import { useCallback, useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { AuthSessionChangedError } from '../auth/sessionContext'
import { useAuthSessionKey } from './useProductRecommendations'

export type AsyncResource<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: unknown }

interface AsyncResourceOptions {
  /** Called once per failed load of the current key; never for superseded, aborted or session-change outcomes. */
  onError?: (error: unknown) => void
}

const IDLE: AsyncResource<never> = { status: 'idle' }
const LOADING: AsyncResource<never> = { status: 'loading' }

/**
 * Loads one server resource identified by `key` (null = disabled). The auth session is
 * part of the key, and only the result for the current key renders, so a superseded
 * request, another account or the frame before the effect re-runs never shows stale
 * data. Changing the key aborts the previous request; `reload` starts a fresh one.
 */
export function useAsyncResource<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  { onError }: AsyncResourceOptions = {},
): { state: AsyncResource<T>; reload: () => void } {
  const sessionKey = useAuthSessionKey()
  const [attempt, setAttempt] = useState(0)
  const fullKey = key === null ? null : `${key}\u0000${sessionKey}\u0000${attempt}`
  const [result, setResult] = useState<{ key: string; value: AsyncResource<T> } | null>(null)
  // The latest callbacks run for the current key; they must not restart the request.
  const loadRef = useRef(load)
  const onErrorRef = useRef(onError)
  loadRef.current = load
  onErrorRef.current = onError

  useEffect(() => {
    if (fullKey === null) return
    const controller = new AbortController()
    let current = true
    loadRef.current(controller.signal)
      .then((data) => {
        if (current) setResult({ key: fullKey, value: { status: 'ready', data } })
      })
      .catch((error: unknown) => {
        if (!current || error instanceof AuthSessionChangedError || axios.isCancel(error)) return
        setResult({ key: fullKey, value: { status: 'error', error } })
        onErrorRef.current?.(error)
      })
    return () => {
      current = false
      controller.abort()
    }
  }, [fullKey])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  if (fullKey === null) return { state: IDLE, reload }
  return { state: result?.key === fullKey ? result.value : LOADING, reload }
}
