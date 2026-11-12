import type { ProvisionTaskSummary } from '../types/merchant'
import { provisionStatusLabel, provisionStatusTone, provisionErrorLabel, type ProvisionTone } from '../utils/provisionStatus'

const TONE_CLASS: Record<ProvisionTone, string> = {
  info: 'bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] text-[var(--color-primary)] border-[color-mix(in_srgb,var(--color-primary)_25%,transparent)]',
  success: 'bg-[color-mix(in_srgb,var(--color-success)_10%,transparent)] text-[var(--color-success)] border-[color-mix(in_srgb,var(--color-success)_25%,transparent)]',
  danger: 'bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] text-[var(--color-danger)] border-[color-mix(in_srgb,var(--color-danger)_25%,transparent)]',
  neutral: 'bg-[var(--color-border)] text-[var(--color-text-muted)] border-[var(--color-border)]',
}

/**
 * P7b：自动开通任务徽标（商家/管理端订单共用）。null 任务不渲染。
 * degraded/失败态附带脱敏诊断码的中文说明；诊断码只做人类可读翻译，不含远端响应体。
 */
export default function ProvisionBadge({
  task,
  idSuffix,
}: {
  task: ProvisionTaskSummary | null | undefined
  idSuffix?: string | number
}) {
  if (!task || !task.status) return null
  const tone = provisionStatusTone(task.status)
  const showError = task.status === 'degraded' && task.lastError
  const errorLabel = showError ? provisionErrorLabel(task.lastError) : null
  return (
    <span className="inline-flex flex-col gap-0.5" data-testid={idSuffix != null ? `provision-badge-${idSuffix}` : 'provision-badge'}>
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold border ${TONE_CLASS[tone]}`}>
        {provisionStatusLabel(task.status)}
        {task.status === 'pending' && task.attempts > 0 ? `（第 ${task.attempts} 次尝试）` : ''}
      </span>
      {errorLabel && (
        <span className="text-xs text-[var(--color-text-muted)]" data-testid={idSuffix != null ? `provision-error-${idSuffix}` : undefined}>
          {errorLabel}
        </span>
      )}
    </span>
  )
}
