import {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { getHumanChallenge } from '../../api/auth'
import {
  HUMAN_VERIFICATION_SOLVE_TIMEOUT_MS,
  supportsAltchaRuntime,
  type HumanVerificationHandle,
  type HumanVerificationWidgetProps,
} from './humanVerificationTypes'

const TurnstileHumanVerification = lazy(() => import('./TurnstileHumanVerification'))

type AltchaElement = HTMLElement & {
  reset?: (state?: string) => void
  verify?: () => Promise<unknown>
}

type ChallengeJson = {
  algorithm: string
  challenge: string
  maxnumber: number
  salt: string
  signature: string
}

async function loadAltchaElement() {
  if (customElements.get('altcha-widget')) return
  await import('altcha')
  await import('altcha/i18n/zh-cn')
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      value => {
        window.clearTimeout(timer)
        resolve(value)
      },
      error => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

const AltchaHumanVerification = forwardRef<HumanVerificationHandle, HumanVerificationWidgetProps>(
  function AltchaHumanVerification({ action, onReadyChange }, ref) {
    const widgetRef = useRef<AltchaElement | null>(null)
    const payloadRef = useRef<string | null>(null)
    const challengeRef = useRef<ChallengeJson | null>(null)
    const refreshedRef = useRef(false)
    const pendingRef = useRef<{ resolve: (payload: string) => void; reject: (error: Error) => void } | null>(null)
    const [phase, setPhase] = useState<'loading' | 'ready' | 'checking' | 'unsupported' | 'unavailable'>('loading')
    const [challengeJson, setChallengeJson] = useState<string | null>(null)
    const [loadAttempt, setLoadAttempt] = useState(0)

    const clearPayload = useCallback(() => {
      payloadRef.current = null
      onReadyChange?.(false)
    }, [onReadyChange])

    const rejectPending = useCallback((message: string) => {
      const pending = pendingRef.current
      pendingRef.current = null
      pending?.reject(new Error(message))
    }, [])

    const storePayload = useCallback((payload: string) => {
      const pending = pendingRef.current
      pendingRef.current = null
      if (pending) {
        payloadRef.current = null
        onReadyChange?.(false)
        pending.resolve(payload)
        return
      }
      payloadRef.current = payload
      onReadyChange?.(true)
      setPhase('ready')
    }, [onReadyChange])

    const startVerification = useCallback(() => {
      const widget = widgetRef.current
      if (!widget?.verify) {
        onReadyChange?.(false)
        setPhase(challengeJson ? 'checking' : 'loading')
        return
      }
      setPhase('checking')
      onReadyChange?.(false)
      void withTimeout(
        Promise.resolve(widget.verify()),
        HUMAN_VERIFICATION_SOLVE_TIMEOUT_MS,
        '安全验证超时',
      ).catch(() => {
        rejectPending('安全验证超时')
        onReadyChange?.(false)
        setPhase('unavailable')
      })
    }, [challengeJson, onReadyChange, rejectPending])

    const detachRef = useRef<(() => void) | null>(null)
    const attachWidget = useCallback((node: AltchaElement | null) => {
      detachRef.current?.()
      widgetRef.current = node
      if (!node) return

      const onStateChange = (event: Event) => {
        const detail = (event as CustomEvent<{ state?: string; payload?: string }>).detail
        if (detail?.state === 'verified' && typeof detail.payload === 'string' && detail.payload.trim()) {
          storePayload(detail.payload)
          return
        }
        if (detail?.state === 'expired' && !refreshedRef.current) {
          clearPayload()
          refreshedRef.current = true
          setLoadAttempt(value => value + 1)
          return
        }
        if (detail?.state === 'error' || detail?.state === 'expired') {
          clearPayload()
          setPhase('unavailable')
        }
      }

      node.addEventListener('statechange', onStateChange)
      node.addEventListener('verified', onStateChange)
      node.addEventListener('expire', onStateChange)
      node.addEventListener('error', onStateChange)
      detachRef.current = () => {
        node.removeEventListener('statechange', onStateChange)
        node.removeEventListener('verified', onStateChange)
        node.removeEventListener('expire', onStateChange)
        node.removeEventListener('error', onStateChange)
      }
      startVerification()
    }, [clearPayload, startVerification, storePayload])

    useEffect(() => {
      if (!supportsAltchaRuntime()) {
        setPhase('unsupported')
        onReadyChange?.(false)
        return
      }

      let cancelled = false
      setPhase('loading')
      setChallengeJson(null)
      clearPayload()

      withTimeout(
        loadAltchaElement().then(() => getHumanChallenge(action)),
        HUMAN_VERIFICATION_SOLVE_TIMEOUT_MS,
        '安全验证超时',
      )
        .then(challenge => {
          if (cancelled) return
          challengeRef.current = challenge
          setChallengeJson(JSON.stringify(challenge))
        })
        .catch(() => {
          if (!cancelled) {
            rejectPending('安全验证超时')
            onReadyChange?.(false)
            setPhase('unavailable')
          }
        })

      return () => {
        cancelled = true
        payloadRef.current = null
        rejectPending('安全验证已取消')
      }
    }, [action, clearPayload, loadAttempt, onReadyChange, rejectPending])

    const reset = useCallback(() => {
      rejectPending('安全验证已重置')
      clearPayload()
      widgetRef.current?.reset?.()
      startVerification()
    }, [clearPayload, rejectPending, startVerification])

    const requestProof = useCallback(async () => {
      const cached = payloadRef.current
      if (cached) {
        payloadRef.current = null
        onReadyChange?.(false)
        return { provider: 'altcha' as const, payload: cached }
      }

      const widget = widgetRef.current
      if (!widget?.verify) throw new Error('安全验证尚未就绪')

      rejectPending('安全验证已重新开始')
      return withTimeout(new Promise<string>((resolve, reject) => {
        pendingRef.current = { resolve, reject }
        void Promise.resolve(widget.verify?.()).catch(error => {
          pendingRef.current = null
          reject(error instanceof Error ? error : new Error('安全验证失败'))
        })
      }), HUMAN_VERIFICATION_SOLVE_TIMEOUT_MS, '安全验证超时').then(payload => ({
        provider: 'altcha' as const,
        payload,
      }))
    }, [onReadyChange, rejectPending])

    useImperativeHandle(ref, () => ({ requestProof, reset }), [requestProof, reset])

    if (phase === 'unsupported') {
      return (
        <p className="text-left text-xs text-[var(--color-text-muted)]" role="alert" data-testid="human-verification-status">
          当前浏览器不支持安全验证（需要 JavaScript、Web Worker 与 WebCrypto），无法继续。
        </p>
      )
    }

    return (
      <div data-testid="altcha-widget-container">
        {challengeJson && (
          <altcha-widget
            ref={attachWidget as never}
            challengejson={challengeJson}
            auto="off"
            hidelogo={true}
            hidefooter={true}
            language="zh-cn"
            disablerefetchonexpire={true}
          />
        )}
        {phase === 'loading' && (
          <p className="text-left text-xs text-[var(--color-text-muted)]" role="status" data-testid="human-verification-status">
            正在加载安全验证…
          </p>
        )}
        {phase === 'checking' && (
          <p className="text-left text-xs text-[var(--color-text-muted)]" role="status" data-testid="human-verification-status">
            正在准备安全验证…
          </p>
        )}
        {phase === 'unavailable' && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-danger)]/25 bg-[var(--color-danger)]/10 px-3 py-2 text-left">
            <p className="text-xs text-[var(--color-text-muted)]">安全验证超时或暂不可用，请重试。</p>
            <button
              type="button"
              onClick={() => {
                refreshedRef.current = false
                setLoadAttempt(value => value + 1)
              }}
              className="min-h-[40px] shrink-0 px-2 text-xs font-semibold text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
            >
              重试
            </button>
          </div>
        )}
      </div>
    )
  },
)

const HumanVerificationWidget = forwardRef<HumanVerificationHandle, HumanVerificationWidgetProps>(
  function HumanVerificationWidget(props, ref) {
    if (props.descriptor.provider === 'turnstile') {
      return (
        <Suspense fallback={
          <p className="text-left text-xs text-[var(--color-text-muted)]" role="status">正在加载安全验证…</p>
        }>
          <TurnstileHumanVerification ref={ref} {...props} />
        </Suspense>
      )
    }

    return <AltchaHumanVerification ref={ref} {...props} />
  },
)

export default HumanVerificationWidget
export type { HumanVerificationHandle, HumanVerificationDescriptor, HumanVerificationProof } from './humanVerificationTypes'
