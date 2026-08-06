import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'

const TURNSTILE_SCRIPT_ID = 'monexus-turnstile-script'
const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

type TurnstileWidgetId = string | number

export type HumanVerificationAction = 'register' | 'forgot_password'

type TurnstileApi = {
  render: (container: HTMLElement, options: {
    sitekey: string
    action: HumanVerificationAction
    execution: 'execute'
    appearance: 'interaction-only'
    callback: (token: string) => void
    'error-callback': () => void
    'expired-callback': () => void
    'timeout-callback': () => void
  }) => TurnstileWidgetId
  execute: (widgetId?: TurnstileWidgetId) => void
  reset: (widgetId?: TurnstileWidgetId) => void
  remove: (widgetId?: TurnstileWidgetId) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let turnstileScriptPromise: Promise<TurnstileApi> | null = null

function loadTurnstileScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (turnstileScriptPromise) return turnstileScriptPromise

  turnstileScriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    let script = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null

    const onLoad = () => {
      if (window.turnstile) {
        resolve(window.turnstile)
      } else {
        turnstileScriptPromise = null
        reject(new Error('Turnstile did not initialize'))
      }
    }
    const onError = () => {
      turnstileScriptPromise = null
      reject(new Error('Turnstile failed to load'))
    }

    if (!script) {
      script = document.createElement('script')
      script.id = TURNSTILE_SCRIPT_ID
      script.src = TURNSTILE_SCRIPT_URL
      script.async = true
      script.defer = true
      document.head.appendChild(script)
    }

    script.addEventListener('load', onLoad, { once: true })
    script.addEventListener('error', onError, { once: true })
  })

  return turnstileScriptPromise
}

/** Start downloading the provider before a widget is needed by a submit. */
export function preloadTurnstileScript(): Promise<void> {
  return loadTurnstileScript().then(() => undefined)
}

export type TurnstileWidgetHandle = {
  requestToken: () => Promise<string>
  reset: () => void
}

type TurnstileWidgetProps = {
  siteKey: string
  action?: HumanVerificationAction
  onReadyChange?: (ready: boolean) => void
}

type PendingTokenRequest = {
  resolve: (token: string) => void
  reject: (error: Error) => void
}

type CachedToken = {
  token: string
  createdAt: number
}

// Cloudflare documents a five-minute lifetime. Refreshing a little earlier
// leaves enough time for a user to finish a long form without submitting a
// proof that is close to expiry.
const TOKEN_MAX_AGE_MS = 240_000

/**
 * Keeps a Turnstile proof inside a single submit request's memory only. The
 * caller receives it through a Promise and must never persist it in a store,
 * URL, log, or form state.
 */
const TurnstileWidget = forwardRef<TurnstileWidgetHandle, TurnstileWidgetProps>(function TurnstileWidget(
  { siteKey, action = 'register', onReadyChange },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<TurnstileApi | null>(null)
  const widgetIdRef = useRef<TurnstileWidgetId | null>(null)
  const pendingTokenRequestRef = useRef<PendingTokenRequest | null>(null)
  const cachedTokenRef = useRef<CachedToken | null>(null)
  const refreshTimerRef = useRef<number | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'checking' | 'unavailable'>('loading')
  const [loadAttempt, setLoadAttempt] = useState(0)

  const rejectPendingTokenRequest = useCallback((message: string) => {
    const pending = pendingTokenRequestRef.current
    pendingTokenRequestRef.current = null
    pending?.reject(new Error(message))
  }, [])

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = null
    }
  }, [])

  const clearCachedToken = useCallback(() => {
    cachedTokenRef.current = null
    clearRefreshTimer()
  }, [clearRefreshTimer])

  const clearWidget = useCallback(() => {
    const api = apiRef.current
    const widgetId = widgetIdRef.current
    if (api && widgetId !== null) {
      try {
        api.remove(widgetId)
      } catch {
        // The provider can already have disposed a failed widget. There is no
        // user-actionable detail to expose here.
      }
    }
    widgetIdRef.current = null
    apiRef.current = null
  }, [])

  const startVerification = useCallback(() => {
    const api = apiRef.current
    const widgetId = widgetIdRef.current
    if (!api || widgetId === null) {
      onReadyChange?.(false)
      setPhase('loading')
      return
    }

    clearCachedToken()
    onReadyChange?.(false)
    setPhase('checking')
    try {
      // `execute` is still explicit, but it starts as soon as the registration
      // form is mounted. A user who needs an interactive challenge sees it
      // while filling the form instead of after clicking submit.
      api.reset(widgetId)
      api.execute(widgetId)
    } catch {
      rejectPendingTokenRequest('安全验证暂不可用')
      onReadyChange?.(false)
      setPhase('unavailable')
    }
  }, [clearCachedToken, onReadyChange, rejectPendingTokenRequest])

  useEffect(() => {
    let cancelled = false
    setPhase('loading')

    loadTurnstileScript()
      .then((api) => {
        if (cancelled || !containerRef.current) return

        apiRef.current = api
        const widgetId = api.render(containerRef.current, {
          sitekey: siteKey,
          action,
          execution: 'execute',
          appearance: 'interaction-only',
          callback: (token) => {
            if (cancelled) return
            if (typeof token !== 'string' || token.trim() === '') {
              rejectPendingTokenRequest('安全验证暂不可用')
              setPhase('unavailable')
              onReadyChange?.(false)
              return
            }
            const pending = pendingTokenRequestRef.current
            pendingTokenRequestRef.current = null
            setPhase('ready')
            if (pending) {
              // A proof handed to the caller is single-use and must never be
              // retained after resolving the request.
              clearRefreshTimer()
              onReadyChange?.(false)
              pending.resolve(token)
              return
            }

            cachedTokenRef.current = { token, createdAt: Date.now() }
            onReadyChange?.(true)
            clearRefreshTimer()
            refreshTimerRef.current = window.setTimeout(() => {
              startVerification()
            }, TOKEN_MAX_AGE_MS)
          },
          'error-callback': () => {
            clearCachedToken()
            rejectPendingTokenRequest('安全验证暂不可用')
            onReadyChange?.(false)
            setPhase('unavailable')
          },
          'expired-callback': () => {
            clearCachedToken()
            rejectPendingTokenRequest('安全验证已过期')
            onReadyChange?.(false)
            startVerification()
          },
          'timeout-callback': () => {
            clearCachedToken()
            rejectPendingTokenRequest('安全验证超时')
            onReadyChange?.(false)
            setPhase('unavailable')
          },
        })
        widgetIdRef.current = widgetId
        startVerification()
      })
      .catch(() => {
        if (!cancelled) {
          onReadyChange?.(false)
          setPhase('unavailable')
        }
      })

    return () => {
      cancelled = true
      clearCachedToken()
      rejectPendingTokenRequest('安全验证已取消')
      clearWidget()
    }
  }, [action, clearCachedToken, clearRefreshTimer, clearWidget, loadAttempt, onReadyChange, rejectPendingTokenRequest, siteKey, startVerification])

  const reset = useCallback(() => {
    rejectPendingTokenRequest('安全验证已重置')
    startVerification()
  }, [rejectPendingTokenRequest, startVerification])

  const requestToken = useCallback(() => {
    const api = apiRef.current
    const widgetId = widgetIdRef.current
    if (!api || widgetId === null || phase === 'unavailable') {
      return Promise.reject(new Error('安全验证尚未就绪'))
    }

    const cached = cachedTokenRef.current
    if (cached && Date.now() - cached.createdAt < TOKEN_MAX_AGE_MS) {
      cachedTokenRef.current = null
      clearRefreshTimer()
      onReadyChange?.(false)
      return Promise.resolve(cached.token)
    }

    rejectPendingTokenRequest('安全验证已重新开始')

    return new Promise<string>((resolve, reject) => {
      pendingTokenRequestRef.current = { resolve, reject }
      startVerification()
    })
  }, [clearRefreshTimer, onReadyChange, phase, rejectPendingTokenRequest, startVerification])

  useImperativeHandle(ref, () => ({ requestToken, reset }), [requestToken, reset])

  function retryLoading() {
    reset()
    if (apiRef.current) return

    turnstileScriptPromise = null
    document.getElementById(TURNSTILE_SCRIPT_ID)?.remove()
    setLoadAttempt((attempt) => attempt + 1)
  }

  return (
    <>
      {/* interaction-only 模式只在 Cloudflare 要求交互时展示内容。ready
          状态继续收起容器，避免普通访客看到一块空白卡片。 */}
      <div
        ref={containerRef}
        data-testid="turnstile-widget-container"
        aria-hidden={phase === 'checking' ? undefined : true}
        className={
          phase === 'checking'
            ? 'min-h-[65px] overflow-visible'
            : 'absolute h-px w-px overflow-hidden opacity-0 pointer-events-none'
        }
      />

      {phase === 'loading' && (
        <p className="text-left text-xs text-[var(--color-text-muted)]" role="status" data-testid="turnstile-status">
          正在加载安全验证…
        </p>
      )}
      {phase === 'checking' && (
        <p className="text-left text-xs text-[var(--color-text-muted)]" role="status" data-testid="turnstile-status">
          正在准备安全验证…
        </p>
      )}
      {phase === 'unavailable' && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-danger)]/25 bg-[var(--color-danger)]/10 px-3 py-2 text-left">
          <p className="text-xs text-[var(--color-text-muted)]">安全验证暂不可用，请刷新后重试。</p>
          <button
            type="button"
            onClick={retryLoading}
            className="min-h-[40px] shrink-0 px-2 text-xs font-semibold text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
          >
            重新加载
          </button>
        </div>
      )}
    </>
  )
})

export default TurnstileWidget
