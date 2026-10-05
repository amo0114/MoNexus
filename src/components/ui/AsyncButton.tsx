import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Loader2 } from 'lucide-react'

interface AsyncButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading: boolean
  loadingLabel: string
}

/** Both labels participate in sizing, so pending requests cannot shrink the button. */
const AsyncButton = forwardRef<HTMLButtonElement, AsyncButtonProps>(function AsyncButton(
  { loading, loadingLabel, children, disabled, type = 'button', ...props }, ref,
) {
  return (
    <button {...props} ref={ref} type={type} disabled={disabled || loading} aria-busy={loading}>
      <span className="inline-grid items-center justify-items-center">
        <span className="col-start-1 row-start-1" style={{ visibility: loading ? 'hidden' : 'visible' }} aria-hidden={loading}>
          {children}
        </span>
        <span className="col-start-1 row-start-1 inline-flex items-center gap-2" style={{ visibility: loading ? 'visible' : 'hidden' }} aria-hidden={!loading}>
          <Loader2 aria-hidden="true" className={`h-4 w-4 shrink-0 motion-reduce:animate-none ${loading ? 'animate-spin' : ''}`} />
          {loadingLabel}
        </span>
      </span>
    </button>
  )
})

export default AsyncButton
