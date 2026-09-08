import { useEffect, useState } from 'react'
import { getAdminConfig, updateAdminConfig, AdminSystemConfig, AdminSystemConfigKey } from '../../api/adminConfig'
import { getApiErrorMessage } from '../../api/error'
import ConfirmDialog from '../ui/ConfirmDialog'
import { useAppStore } from '../../stores/appStore'
import { CONFIG_METAS } from './adminConfigMeta'

const REG_ENABLED_KEY: AdminSystemConfigKey = 'registrationEnabled'
const INVITE_ONLY_KEY: AdminSystemConfigKey = 'registrationInviteOnly'
const EMAIL_VERIF_KEY: AdminSystemConfigKey = 'emailVerificationRequiredForValue'

const DISABLE_CONFIRM = '关闭后新访客无法创建账号，现有用户仍可登录。确认关闭？'

export interface RegistrationControlPanelProps {
  items?: AdminSystemConfig[]
  drafts?: Record<string, string>
  onChange?: (key: AdminSystemConfigKey, raw: string) => void
  onSave?: (key: AdminSystemConfigKey, raw: string) => Promise<void>
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
  savingKey,
  errors = {},
}: RegistrationControlPanelProps) {
  const showToast = useAppStore((s) => s.showToast)

  // Internal state when not controlled
  const [internalConfigs, setInternalConfigs] = useState<AdminSystemConfig[]>([])
  const [internalDrafts, setInternalDrafts] = useState<Record<string, string>>({})
  const [internalErrors, setInternalErrors] = useState<Record<string, string>>({})
  const [internalSavingKey, setInternalSavingKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const isControlled = !!items && !!onChange && !!onSave

  useEffect(() => {
    if (!isControlled) {
      void fetchInternal()
    }
  }, [isControlled])

  async function fetchInternal() {
    setLoading(true)
    try {
      const list = await getAdminConfig()
      setInternalConfigs(list)
      const d: Record<string, string> = {}
      list.forEach((c) => {
        d[c.key] = c.value.toString()
      })
      setInternalDrafts(d)
      setLoadError(false)
    } catch (err) {
      setLoadError(true)
      showToast(getApiErrorMessage(err, '加载注册配置失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  const effectiveConfigs = isControlled ? items : internalConfigs
  const effectiveDrafts = isControlled ? drafts || {} : internalDrafts
  const effectiveErrors = isControlled ? errors : internalErrors
  const effectiveSavingKey = isControlled ? savingKey : internalSavingKey

  const handleChange = (key: AdminSystemConfigKey, raw: string) => {
    if (isControlled && onChange) {
      onChange(key, raw)
    } else {
      setInternalDrafts((prev) => ({ ...prev, [key]: raw }))
    }
  }

  const handleSave = async (key: AdminSystemConfigKey, raw: string) => {
    if (isControlled && onSave) {
      await onSave(key, raw)
    } else {
      setInternalSavingKey(key)
      try {
        const val = parseInt(raw, 10)
        const updated = await updateAdminConfig(key, val)
        setInternalConfigs((prev) => prev.map((c) => (c.key === updated.key ? updated : c)))
        setInternalDrafts((prev) => ({ ...prev, [updated.key]: updated.value.toString() }))
        setInternalErrors((prev) => {
          const next = { ...prev }
          delete next[key]
          return next
        })
        showToast(`「${CONFIG_METAS[key].label}」已保存`)
      } catch (err) {
        const msg = getApiErrorMessage(err, '保存失败')
        setInternalErrors((prev) => ({ ...prev, [key]: msg }))
        showToast(msg, 'error')
      } finally {
        setInternalSavingKey(null)
      }
    }
  }

  const regConfig = effectiveConfigs.find((c) => c.key === REG_ENABLED_KEY)
  const inviteOnlyConfig = effectiveConfigs.find((c) => c.key === INVITE_ONLY_KEY)
  const emailVerifConfig = effectiveConfigs.find((c) => c.key === EMAIL_VERIF_KEY)

  const regEnabled = effectiveDrafts[REG_ENABLED_KEY] !== undefined
    ? effectiveDrafts[REG_ENABLED_KEY] === '1'
    : regConfig?.value === 1
  const inviteOnly = effectiveDrafts[INVITE_ONLY_KEY] !== undefined
    ? effectiveDrafts[INVITE_ONLY_KEY] === '1'
    : inviteOnlyConfig?.value === 1
  const emailVerif = effectiveDrafts[EMAIL_VERIF_KEY] !== undefined
    ? effectiveDrafts[EMAIL_VERIF_KEY] === '1'
    : emailVerifConfig?.value === 1

  const handleRegToggle = () => {
    if (effectiveSavingKey) return
    if (regEnabled) {
      setConfirmOpen(true)
      return
    }
    void handleSave(REG_ENABLED_KEY, '1')
  }

  const handleInviteToggle = () => {
    if (effectiveSavingKey) return
    void handleSave(INVITE_ONLY_KEY, inviteOnly ? '0' : '1')
  }

  const handleEmailVerifToggle = () => {
    if (effectiveSavingKey) return
    void handleSave(EMAIL_VERIF_KEY, emailVerif ? '0' : '1')
  }

  if (!isControlled && loading) {
    return <div className="text-sm text-[var(--color-text-muted)] py-4">加载中...</div>
  }

  if (!isControlled && loadError) {
    return (
      <div className="text-sm text-[var(--color-danger)] py-2" data-testid="registration-control-error">
        注册开关状态加载失败
        <button type="button" className="btn-secondary btn-sm ml-3 px-3" onClick={() => void fetchInternal()}>
          重试
        </button>
      </div>
    )
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
            <div className="text-xs text-[var(--color-text-muted)] font-mono mt-1">{REG_ENABLED_KEY}</div>
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
            disabled={effectiveSavingKey === REG_ENABLED_KEY}
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
            <div className="text-xs text-[var(--color-text-muted)] font-mono mt-1">{INVITE_ONLY_KEY}</div>
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
            disabled={effectiveSavingKey === INVITE_ONLY_KEY}
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
            <div className="text-xs text-[var(--color-text-muted)] font-mono mt-1">{EMAIL_VERIF_KEY}</div>
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
            disabled={effectiveSavingKey === EMAIL_VERIF_KEY}
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
            const rawVal = effectiveDrafts[key] ?? ''
            const error = effectiveErrors[key]
            const isSaving = effectiveSavingKey === key
            const cfg = effectiveConfigs.find((c) => c.key === key)

            return (
              <div key={key} className="px-4 py-3 flex flex-col sm:flex-row sm:items-start gap-3">
                <div className="flex-grow min-w-0">
                  <label htmlFor={`config-input-${key}`} className="font-bold text-sm text-[var(--color-text)] cursor-pointer">
                    {meta.label}
                  </label>
                  <p id={`config-hint-${key}`} className="text-xs text-[var(--color-text-muted)] mt-0.5">
                    {meta.description}
                  </p>
                  <div className="text-xs text-[var(--color-text-muted)] font-mono mt-1">{key}</div>
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
                        onChange={(e) => handleChange(key, e.target.value)}
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
                        onChange={(e) => handleChange(key, e.target.value)}
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
                      disabled={isSaving}
                      onClick={() => void handleSave(key, rawVal)}
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
        loading={effectiveSavingKey === REG_ENABLED_KEY}
        onConfirm={() => {
          setConfirmOpen(false)
          void handleSave(REG_ENABLED_KEY, '0')
        }}
      />
    </div>
  )
}
