import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'

const TURNSTILE_SCRIPT_ID = 'monexus-turnstile-script'
const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

type TurnstileWidgetId = string | number

type TurnstileApi = {
  render: (container: HTMLElement, options: {
    sitekey: string
    action: 'register'
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

export type TurnstileWidgetHandle = {
  requestToken: () => Promise<string>
  reset: () => void
}

type TurnstileWidgetProps = {
  siteKey: string
}

type PendingTokenRequest = {
  resolve: (token: string) => void
  reject: (error: Error) => void
}

/**
 * Keeps a Turnstile proof inside a single submit request's memory only. The
 * caller receives it through a Promise and must never persist it in a store,
 * URL, log, or form state.
 */
const TurnstileWidget = forwardRef<TurnstileWidgetHandle, TurnstileWidgetProps>(function TurnstileWidget(
  { siteKey },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<TurnstileApi | null>(null)
  const widgetIdRef = useRef<TurnstileWidgetId | null>(null)
  const pendingTokenRequestRef = useRef<PendingTokenRequest | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'checking' | 'unavailable'>('loading')
  const [loadAttempt, setLoadAttempt] = useState(0)

  const rejectPendingTokenRequest = useCallback((message: string) => {
    const pending = pendingTokenRequestRef.current
    pendingTokenRequestRef.current = null
    pending?.reject(new Error(message))
  }, [])

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

  useEffect(() => {
    let cancelled = false
    setPhase('loading')

    loadTurnstileScript()
      .then((api) => {
        if (cancelled || !containerRef.current) return

        apiRef.current = api
        const widgetId = api.render(containerRef.current, {
          sitekey: siteKey,
          action: 'register',
          execution: 'execute',
          appearance: 'interaction-only',
          callback: (token) => {
            const pending = pendingTokenRequestRef.current
            pendingTokenRequestRef.current = null
            setPhase('ready')
            pending?.resolve(token)
          },
          'error-callback': () => {
            rejectPendingTokenRequest('安全验证暂不可用')
            setPhase('unavailable')
          },
          'expired-callback': () => {
            rejectPendingTokenRequest('安全验证已过期')
            setPhase('ready')
          },
          'timeout-callback': () => {
            rejectPendingTokenRequest('安全验证超时')
            setPhase('ready')
          },
        })
        widgetIdRef.current = widgetId
        setPhase('ready')
      })
      .catch(() => {
        if (!cancelled) setPhase('unavailable')
      })

    return () => {
      cancelled = true
      rejectPendingTokenRequest('安全验证已取消')
      clearWidget()
    }
  }, [clearWidget, loadAttempt, rejectPendingTokenRequest, siteKey])

  const reset = useCallback(() => {
    rejectPendingTokenRequest('安全验证已重置')
    const api = apiRef.current
    const widgetId = widgetIdRef.current
    if (!api || widgetId === null) return

    try {
      api.reset(widgetId)
      setPhase('ready')
    } catch {
      setPhase('unavailable')
    }
  }, [rejectPendingTokenRequest])

  const requestToken = useCallback(() => {
    const api = apiRef.current
    const widgetId = widgetIdRef.current
    if (!api || widgetId === null || phase === 'unavailable') {
      return Promise.reject(new Error('安全验证尚未就绪'))
    }

    rejectPendingTokenRequest('安全验证已重新开始')
    setPhase('checking')

    return new Promise<string>((resolve, reject) => {
      pendingTokenRequestRef.current = { resolve, reject }
      try {
        // A proof is single-use. Reset before every submission so a prior
        // challenge cannot be accidentally reused after a failed request.
        api.reset(widgetId)
        api.execute(widgetId)
      } catch {
        rejectPendingTokenRequest('安全验证暂不可用')
        setPhase('unavailable')
      }
    })
  }, [phase, rejectPendingTokenRequest])

  useImperativeHandle(ref, () => ({ requestToken, reset }), [requestToken, reset])

  function retryLoading() {
    reset()
    if (apiRef.current) return

    turnstileScriptPromise = null
    document.getElementById(TURNSTILE_SCRIPT_ID)?.remove()
    setLoadAttempt((attempt) => attempt + 1)
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left">
      <div ref={containerRef} className="min-h-px" />
      {phase === 'loading' && (
        <p className="text-xs text-[var(--color-text-muted)]" role="status">正在加载安全验证…</p>
      )}
      {phase === 'checking' && (
        <p className="text-xs text-[var(--color-text-muted)]" role="status">请完成安全验证后继续…</p>
      )}
      {phase === 'unavailable' && (
        <div className="flex items-center justify-between gap-3">
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
    </div>
  )
})

export default TurnstileWidget
