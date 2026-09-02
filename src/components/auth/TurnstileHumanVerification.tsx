import { forwardRef, useImperativeHandle, useRef } from 'react'
import TurnstileWidget, { type TurnstileWidgetHandle } from './TurnstileWidget'
import type {
  HumanVerificationHandle,
  HumanVerificationWidgetProps,
} from './humanVerificationTypes'

const TurnstileHumanVerification = forwardRef<HumanVerificationHandle, HumanVerificationWidgetProps>(
  function TurnstileHumanVerification({ descriptor, action, onReadyChange }, ref) {
    const inner = useRef<TurnstileWidgetHandle>(null)
    const siteKey = descriptor.provider === 'turnstile' ? descriptor.siteKey : ''

    useImperativeHandle(ref, () => ({
      requestProof: async () => {
        const payload = await inner.current!.requestToken()
        return { provider: 'turnstile' as const, payload }
      },
      reset: () => {
        inner.current?.reset()
      },
    }), [])

    return (
      <TurnstileWidget
        ref={inner}
        siteKey={siteKey}
        action={action}
        onReadyChange={onReadyChange}
      />
    )
  },
)

export default TurnstileHumanVerification
