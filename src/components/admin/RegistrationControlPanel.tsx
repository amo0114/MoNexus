import { useState } from 'react'
import { AdminSystemConfig, AdminSystemConfigKey } from '../../api/adminConfig'
import ConfirmDialog from '../ui/ConfirmDialog'
import { CONFIG_METAS } from './adminConfigMeta'

const REG_ENABLED_KEY: AdminSystemConfigKey = 'registrationEnabled'
const INVITE_ONLY_KEY: AdminSystemConfigKey = 'registrationInviteOnly'
const EMAIL_VERIF_KEY: AdminSystemConfigKey = 'emailVerificationRequiredForValue'

const DISABLE_CONFIRM = '关闭后新访客无法创建账号，现有用户仍可登录。确认关闭？'

export interface RegistrationControlPanelProps {
  items: AdminSystemConfig[]
  drafts: Record<string, string>
  onChange: (key: AdminSystemConfigKey, raw: string) => void
  onSave: (key: AdminSystemConfigKey, raw: string) => Promise<void>
  savingKey?: string | null
  errors?: Record<string, string>
}

const REGISTRATION_KEYS: AdminSystemConfigKey[] = [
  'registrationEnabled',
  'registrationInviteOnly',
  'emailVerificationRequiredForValue',
  'referralInviterMinAgeDays',
  'referralDailyQualifiedLimit',
  'referralLifetimeQualifiedLimit',
  'inviteMinTierRank',
  'inviteQuotaUserMonthly',
  'inviteQuotaMerchantMonthly',
  'inviteCodeTtlDays',
]

export default function RegistrationControlPanel({
  items,
  drafts,
  onChange,
  onSave,
  savingKey = null,
  errors = {},
}: RegistrationControlPanelProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)

  const regConfig = items.find((c) => c.key === REG_ENABLED_KEY)
  const inviteOnlyConfig = items.find((c) => c.key === INVITE_ONLY_KEY)
  const emailVerifConfig = items.find((c) => c.key === EMAIL_VERIF_KEY)

  const regEnabled = drafts[REG_ENABLED_KEY] !== undefined
    ? drafts[REG_ENABLED_KEY] === '1'
    : regConfig?.value === 1
  const inviteOnly = drafts[INVITE_ONLY_KEY] !== undefined
    ? drafts[INVITE_ONLY_KEY] === '1'
    : inviteOnlyConfig?.value === 1
  const emailVerif = drafts[EMAIL_VERIF_KEY] !== undefined
    ? drafts[EMAIL_VERIF_KEY] === '1'
    : emailVerifConfig?.value === 1

  const handleRegToggle = () => {
    if (savingKey) return
    if (regEnabled) {
      setConfirmOpen(true)
      return
    }
    void onSave(REG_ENABLED_KEY, '1')
  }

  const handleInviteToggle = () => {
    if (savingKey) return
    void onSave(INVITE_ONLY_KEY, inviteOnly ? '0' : '1')
  }

  const handleEmailVerifToggle = () => {
    if (savingKey) return
    void onSave(EMAIL_VERIF_KEY, emailVerif ? '0' : '1')
  }

  return (
    <div data-testid="registration-control-panel" className="space-y-6">
      {/* 1. 开关设置 */}
      <div className="space-y-3">
        <h3 className="text-sm font-bold text-[var(--color-text)]">通道开关</h3>

        {/* 允许新用户注册 */}
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-3 flex flex-wrap items-center gap-3">
          <div className="flex-grow min-w-0">
            <div className="font-bold text-sm text-[var(--color-text)]">{CONFIG_METAS.registrationEnabled.label}</div>
            <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{CONFIG_METAS.registrationEnabled.description}</div>
            <details className="mt-1 text-xs text-[var(--color-text-muted)]">
              <summary className="cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors text-[11px] underline decoration-dotted inline-block">
                配置键名
              </summary>
              <div className="mt-0.5 font-mono text-[11px] text-[var(--color-text-muted)] select-all">
                {REG_ENABLED_KEY}
              </div>
            </details>
          </div>
          <span
            data-testid="registration-toggle-state"
            className="text-sm font-semibold text-[var(--color-text)] whitespace-nowrap"
          >
            {regEnabled ? '已开启' : '已关闭'}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={regEnabled}
            aria-label="允许新用户注册"
            disabled={savingKey === REG_ENABLED_KEY}
            onClick={handleRegToggle}
            data-testid="registration-toggle"
            className="relative inline-flex items-center shrink-0 min-w-[40px] min-h-[40px] px-1 rounded-full cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          >
            <span
              aria-hidden="true"
              className={`w-11 h-6 rounded-full transition-colors ${
                regEnabled ? 'bg-[var(--color-success)]' : 'bg-[var(--color-border)]'
              }`}
            >
              <span
                className={`block w-5 h-5 mt-0.5 rounded-full bg-white shadow transition-transform ${
                  regEnabled ? 'translate-x-[1.375rem]' : 'translate-x-0.5'
                }`}
              />
            </span>
          </button>
        </div>

        {/* 注册必须使用邀请码 */}
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-3 flex flex-wrap items-center gap-3">
          <div className="flex-grow min-w-0">
            <div className="font-bold text-sm text-[var(--color-text)]">{CONFIG_METAS.registrationInviteOnly.label}</div>
            <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{CONFIG_METAS.registrationInviteOnly.description}</div>
            <details className="mt-1 text-xs text-[var(--color-text-muted)]">
              <summary className="cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors text-[11px] underline decoration-dotted inline-block">
                配置键名
              </summary>
              <div className="mt-0.5 font-mono text-[11px] text-[var(--color-text-muted)] select-all">
                {INVITE_ONLY_KEY}
              </div>
            </details>
          </div>
          <span
            data-testid="invite-only-toggle-state"
            className="text-sm font-semibold text-[var(--color-text)] whitespace-nowrap"
          >
            {inviteOnly ? '必填' : '可选'}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={inviteOnly}
            aria-label="注册必须使用邀请码"
            disabled={savingKey === INVITE_ONLY_KEY}
            onClick={handleInviteToggle}
            data-testid="invite-only-toggle"
            className="relative inline-flex items-center shrink-0 min-w-[40px] min-h-[40px] px-1 rounded-full cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          >
            <span
              aria-hidden="true"
              className={`w-11 h-6 rounded-full transition-colors ${
                inviteOnly ? 'bg-[var(--color-success)]' : 'bg-[var(--color-border)]'
              }`}
            >
              <span
                className={`block w-5 h-5 mt-0.5 rounded-full bg-white shadow transition-transform ${
                  inviteOnly ? 'translate-x-[1.375rem]' : 'translate-x-0.5'
                }`}
              />
            </span>
          </button>
        </div>

        {/* 交易与积分操作前须验证邮箱 */}
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-3 flex flex-wrap items-center gap-3">
          <div className="flex-grow min-w-0">
            <div className="font-bold text-sm text-[var(--color-text)]">{CONFIG_METAS.emailVerificationRequiredForValue.label}</div>
            <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{CONFIG_METAS.emailVerificationRequiredForValue.description}</div>
            <details className="mt-1 text-xs text-[var(--color-text-muted)]">
              <summary className="cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors text-[11px] underline decoration-dotted inline-block">
                配置键名
              </summary>
              <div className="mt-0.5 font-mono text-[11px] text-[var(--color-text-muted)] select-all">
                {EMAIL_VERIF_KEY}
              </div>
            </details>
          </div>
          <span
            data-testid="email-verification-toggle-state"
            className="text-sm font-semibold text-[var(--color-text)] whitespace-nowrap"
          >
            {emailVerif ? '已开启' : '已关闭'}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={emailVerif}
            aria-label="交易与积分操作前须验证邮箱"
            disabled={savingKey === EMAIL_VERIF_KEY}
            onClick={handleEmailVerifToggle}
            data-testid="email-verification-toggle"
            className="relative inline-flex items-center shrink-0 min-w-[40px] min-h-[40px] px-1 rounded-full cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          >
            <span
              aria-hidden="true"
              className={`w-11 h-6 rounded-full transition-colors ${
                emailVerif ? 'bg-[var(--color-success)]' : 'bg-[var(--color-border)]'
              }`}
            >
              <span
                className={`block w-5 h-5 mt-0.5 rounded-full bg-white shadow transition-transform ${
                  emailVerif ? 'translate-x-[1.375rem]' : 'translate-x-0.5'
                }`}
              />
            </span>
          </button>
        </div>
      </div>

      {/* 2. 邀请码与资格规则 */}
      <div className="space-y-3">
        <h3 className="text-sm font-bold text-[var(--color-text)]">邀请资格与额度</h3>
        <div className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] bg-[var(--color-background)]">
          {REGISTRATION_KEYS.filter((k) => !['registrationEnabled', 'registrationInviteOnly', 'emailVerificationRequiredForValue'].includes(k)).map((key) => {
            const meta = CONFIG_METAS[key]
            const rawVal = drafts[key] ?? ''
            const error = errors[key]
            const isSaving = savingKey === key
            const cfg = items.find((c) => c.key === key)

            return (
              <div key={key} className="px-4 py-3 flex flex-col sm:flex-row sm:items-start gap-3">
                <div className="flex-grow min-w-0">
                  <label htmlFor={`config-input-${key}`} className="font-bold text-sm text-[var(--color-text)] cursor-pointer">
                    {meta.label}
                  </label>
                  <p id={`config-hint-${key}`} className="text-xs text-[var(--color-text-muted)] mt-0.5">
                    {meta.description}
                  </p>
                  <details className="mt-1 text-xs text-[var(--color-text-muted)]">
                    <summary className="cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors text-[11px] underline decoration-dotted inline-block">
                      配置键名
                    </summary>
                    <div className="mt-0.5 font-mono text-[11px] text-[var(--color-text-muted)] select-all">
                      {key}
                    </div>
                  </details>
                  {error && (
                    <div className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-2 py-1 rounded border border-[var(--color-danger)]/20 mt-1 max-w-sm">
                      {error}
                    </div>
                  )}
                </div>

                <div className="flex-shrink-0 sm:w-72">
                  <div className="flex items-center gap-2">
                    {meta.type === 'select' ? (
                      <select
                        id={`config-input-${key}`}
                        value={rawVal}
                        onChange={(e) => onChange(key, e.target.value)}
                        disabled={isSaving}
                        aria-describedby={`config-hint-${key}`}
                        data-testid={`admin-config-input-${key}`}
                        className="input py-1.5 px-2 text-sm flex-grow"
                      >
                        {meta.options?.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={`config-input-${key}`}
                        type="number"
                        min={meta.min ?? 0}
                        max={meta.max}
                        step="1"
                        value={rawVal}
                        onChange={(e) => onChange(key, e.target.value)}
                        disabled={isSaving}
                        aria-describedby={`config-hint-${key}`}
                        data-testid={`admin-config-input-${key}`}
                        className={`input py-1.5 px-2 w-28 ${error ? 'border-[var(--color-danger)]' : ''}`}
                      />
                    )}

                    {meta.unit && (
                      <span className="text-xs text-[var(--color-text-muted)] whitespace-nowrap">{meta.unit}</span>
                    )}

                    <button
                      type="button"
                      disabled={isSaving || savingKey !== null}
                      onClick={() => void onSave(key, rawVal)}
                      data-testid={`admin-config-save-${key}`}
                      className="text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-primary)]/25 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                    >
                      {isSaving ? '保存中...' : '保存'}
                    </button>
                  </div>
                  {cfg && (
                    <div className="text-xs text-[var(--color-text-muted)] mt-1">
                      当前部署默认值：{meta.type === 'select' ? meta.options?.find((o) => o.value === cfg.defaultValue)?.label ?? cfg.defaultValue : `${cfg.defaultValue} ${meta.unit ?? ''}`}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="关闭新用户注册"
        description={DISABLE_CONFIRM}
        confirmLabel="确认关闭"
        loading={savingKey === REG_ENABLED_KEY}
        onConfirm={() => {
          setConfirmOpen(false)
          void onSave(REG_ENABLED_KEY, '0')
        }}
      />
    </div>
  )
}
