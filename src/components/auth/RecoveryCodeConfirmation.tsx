import { useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'

type Props = {
  recoveryCodes: string[]
  loading: boolean
  onConfirm: () => Promise<void>
}

export default function RecoveryCodeConfirmation({ recoveryCodes, loading, onConfirm }: Props) {
  const [acknowledged, setAcknowledged] = useState(false)

  return (
    <section className="text-left" data-testid="mfa-recovery-confirmation">
      <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-cta)]/10 text-[var(--color-cta)]">
        <KeyRound className="h-6 w-6" />
      </div>
      <h2 className="font-heading text-center text-2xl font-semibold text-[var(--color-text)]">保存恢复码</h2>
      <p className="mt-2 text-center text-sm leading-6 text-[var(--color-text-muted)]">
        这些恢复码仅显示这一次。请离线保存；遗失验证器时，每枚码可用于登录一次。
      </p>

      <ol className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="mfa-recovery-codes">
        {recoveryCodes.map((code) => (
          <li key={code} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-center font-mono text-sm text-[var(--color-text)]">
            {code}
          </li>
        ))}
      </ol>

      <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-border)] p-3 text-sm text-[var(--color-text)]">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          disabled={loading}
          data-testid="mfa-recovery-acknowledgement"
        />
        <span>我已将恢复码保存在安全位置，理解关闭或刷新页面后无法再次查看。</span>
      </label>

      <button
        type="button"
        className="btn-primary mt-5 w-full"
        disabled={!acknowledged || loading}
        onClick={() => void onConfirm()}
        data-testid="mfa-recovery-continue"
      >
        {loading ? <><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />正在进入账户…</> : '我已安全保存，继续'}
      </button>
    </section>
  )
}
