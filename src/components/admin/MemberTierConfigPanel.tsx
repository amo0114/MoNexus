import { useEffect, useState } from 'react'
import { getAdminConfig, updateAdminConfig, AdminSystemConfig, AdminSystemConfigKey } from '../../api/adminConfig'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { bpsToPercentString, percentStringToBps } from './adminConfigMeta'

export interface MemberTierConfigPanelProps {
  items?: AdminSystemConfig[]
  drafts?: Record<string, string>
  onChange?: (key: AdminSystemConfigKey, raw: string) => void
  onSave?: (key: AdminSystemConfigKey, raw: string) => Promise<void>
  savingKey?: string | null
  errors?: Record<string, string>
}

interface TierRowDef {
  value: string
  label: string
  tone: 'neutral' | 'info' | 'warning' | 'success'
  thresholdKey: AdminSystemConfigKey | null
  bonusBpsKey: AdminSystemConfigKey | null
}

const TIER_ROWS: TierRowDef[] = [
  {
    value: 'bronze',
    label: '青铜会员',
    tone: 'neutral',
    thresholdKey: null,
    bonusBpsKey: null,
  },
  {
    value: 'silver',
    label: '银卡会员',
    tone: 'info',
    thresholdKey: 'memberTierSilverThreshold',
    bonusBpsKey: 'memberTierSilverBonusBps',
  },
  {
    value: 'gold',
    label: '金卡会员',
    tone: 'warning',
    thresholdKey: 'memberTierGoldThreshold',
    bonusBpsKey: 'memberTierGoldBonusBps',
  },
  {
    value: 'platinum',
    label: '铂金会员',
    tone: 'success',
    thresholdKey: 'memberTierPlatinumThreshold',
    bonusBpsKey: 'memberTierPlatinumBonusBps',
  },
]

export function MemberTierConfigPanel({
  items,
  drafts,
  onChange,
  onSave,
  savingKey,
  errors = {},
}: MemberTierConfigPanelProps) {
  const showToast = useAppStore((s) => s.showToast)

  // Internal state when not controlled
  const [internalConfigs, setInternalConfigs] = useState<AdminSystemConfig[]>([])
  const [internalDrafts, setInternalDrafts] = useState<Record<string, string>>({})
  const [internalErrors, setInternalErrors] = useState<Record<string, string>>({})
  const [internalSavingKey, setInternalSavingKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)

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
        if (c.key.endsWith('BonusBps')) {
          d[c.key] = bpsToPercentString(c.value)
        } else {
          d[c.key] = c.value.toString()
        }
      })
      setInternalDrafts(d)
      setLoadError(false)
    } catch (err) {
      setLoadError(true)
      showToast(getApiErrorMessage(err, '加载会员等级配置失败'), 'error')
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
        let val: number
        if (key.endsWith('BonusBps')) {
          const res = percentStringToBps(raw)
          if (res.error) {
            setInternalErrors((prev) => ({ ...prev, [key]: res.error! }))
            showToast(res.error, 'error')
            setInternalSavingKey(null)
            return
          }
          val = res.value!
        } else {
          val = parseInt(raw, 10)
          if (isNaN(val) || val < 0) {
            setInternalErrors((prev) => ({ ...prev, [key]: '请输入有效的非负整数' }))
            showToast('请输入有效的非负整数', 'error')
            setInternalSavingKey(null)
            return
          }
        }
        const updated = await updateAdminConfig(key, val)
        setInternalConfigs((prev) => prev.map((c) => (c.key === updated.key ? updated : c)))
        setInternalDrafts((prev) => ({
          ...prev,
          [updated.key]: key.endsWith('BonusBps') ? bpsToPercentString(updated.value) : updated.value.toString(),
        }))
        setInternalErrors((prev) => {
          const next = { ...prev }
          delete next[key]
          return next
        })
        showToast('配置已保存')
      } catch (err) {
        const msg = getApiErrorMessage(err, '保存失败')
        setInternalErrors((prev) => ({ ...prev, [key]: msg }))
        showToast(msg, 'error')
      } finally {
        setInternalSavingKey(null)
      }
    }
  }

  if (!isControlled && loading) {
    return <div className="text-sm text-[var(--color-text-muted)] py-4">加载中...</div>
  }

  if (!isControlled && loadError) {
    return (
      <div className="text-sm text-[var(--color-danger)] py-2">
        会员等级配置加载失败
        <button type="button" className="btn-secondary btn-sm ml-3 px-3" onClick={() => void fetchInternal()}>
          重试
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4" data-testid="member-tier-config-panel">
      <div className="bg-[var(--color-info)]/8 border border-[var(--color-info)]/20 rounded-lg p-3 text-xs text-[var(--color-text-muted)] space-y-1">
        <p>
          <strong className="text-[var(--color-text)]">升级门槛规则：</strong>按用户正向积分流水（累计充值与收入积分）统计，不含冻结或沙箱积分。门槛必须严格递增：银卡 &lt; 金卡 &lt; 铂金。如需调大某等级门槛，需先调大其上级门槛；如需调小，需先调小其下级门槛。
        </p>
        <p>
          <strong className="text-[var(--color-text)]">额外加成计算：</strong>额外积分 = <code className="font-mono bg-[var(--color-background)] px-1 rounded">floor(基础奖励 × 百分比)</code>，在签到和邀请新用户时叠加发放。新计算的奖励按当前规则确定；已创建的待发奖励不会因本次修改重算。
        </p>
      </div>

      <div className="overflow-x-auto bg-[var(--color-background)] rounded-lg border border-[var(--color-border)]">
        <table className="admin-table table-cards border-0">
          <thead>
            <tr>
              <th className="border-b border-[var(--color-border)]">等级名称</th>
              <th className="border-b border-[var(--color-border)]">升级门槛（累计获得积分）</th>
              <th className="border-b border-[var(--color-border)] w-1/3">签到/邀请额外加成（%）</th>
            </tr>
          </thead>
          <tbody>
            {TIER_ROWS.map((t) => {
              const isBronze = t.value === 'bronze'

              let badgeStyles = ''
              switch (t.tone) {
                case 'success':
                  badgeStyles = 'bg-[var(--color-cta)]/10 text-[var(--color-cta)] border-[var(--color-cta)]/25'
                  break
                case 'warning':
                  badgeStyles = 'bg-[var(--color-warning)]/10 text-[var(--color-warning)] border-[var(--color-warning)]/25'
                  break
                case 'info':
                  badgeStyles = 'bg-[var(--color-info)]/10 text-[var(--color-info)] border-[var(--color-info)]/25'
                  break
                case 'neutral':
                default:
                  badgeStyles = 'bg-[var(--color-text-muted)]/10 text-[var(--color-text-muted)] border-[var(--color-text-muted)]/25'
                  break
              }

              const thKey = t.thresholdKey
              const thVal = thKey ? effectiveDrafts[thKey] ?? '' : '0'
              const thErr = thKey ? effectiveErrors[thKey] : undefined
              const thSaving = thKey ? effectiveSavingKey === thKey : false
              const thCfg = thKey ? effectiveConfigs.find((c) => c.key === thKey) : undefined

              const bpsKey = t.bonusBpsKey
              const bpsVal = bpsKey ? effectiveDrafts[bpsKey] ?? '' : '0'
              const bpsErr = bpsKey ? effectiveErrors[bpsKey] : undefined
              const bpsSaving = bpsKey ? effectiveSavingKey === bpsKey : false
              const bpsCfg = bpsKey ? effectiveConfigs.find((c) => c.key === bpsKey) : undefined

              return (
                <tr key={t.value} className={isBronze ? 'opacity-70 bg-[var(--color-text-muted)]/5' : ''}>
                  <td data-label="等级名称">
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-bold border ${badgeStyles}`}>
                      {t.label}
                    </span>
                  </td>

                  {/* 门槛 */}
                  <td data-label="升级门槛（累计获得积分）">
                    {isBronze ? (
                      <div className="text-xs text-[var(--color-text-muted)] px-1">0 积分（初始基础等级）</div>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor={`config-input-${thKey!}`} className="sr-only">
                          {t.label}升级门槛（累计积分）
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            id={`config-input-${thKey!}`}
                            type="number"
                            min="0"
                            step="1"
                            value={thVal}
                            onChange={(e) => handleChange(thKey!, e.target.value)}
                            disabled={thSaving}
                            aria-describedby={thErr ? `config-error-${thKey!}` : undefined}
                            data-testid={`admin-config-input-${thKey!}`}
                            className={`input py-1.5 px-2 w-28 ${thErr ? 'border-[var(--color-danger)]' : ''}`}
                          />
                          <span className="text-xs text-[var(--color-text-muted)] whitespace-nowrap">积分</span>
                          <button
                            type="button"
                            onClick={() => void handleSave(thKey!, thVal)}
                            disabled={thSaving || effectiveSavingKey !== null}
                            data-testid={`admin-config-save-${thKey!}`}
                            className="text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-primary)]/25 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                          >
                            {thSaving ? '保存中...' : '保存'}
                          </button>
                        </div>
                        {thCfg && (
                          <div className="text-xs text-[var(--color-text-muted)]">
                            部署默认值：{thCfg.defaultValue} 积分
                          </div>
                        )}
                        {thErr && (
                          <div
                            id={`config-error-${thKey!}`}
                            className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-2 py-1 rounded border border-[var(--color-danger)]/20 max-w-sm"
                          >
                            {thErr}
                          </div>
                        )}
                      </div>
                    )}
                  </td>

                  {/* 额外加成 */}
                  <td data-label="签到/邀请额外加成（%）">
                    {isBronze ? (
                      <div className="text-xs text-[var(--color-text-muted)] px-1">无额外加成</div>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor={`config-input-${bpsKey!}`} className="sr-only">
                          {t.label}额外加成百分比
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            id={`config-input-${bpsKey!}`}
                            type="number"
                            min="0"
                            max="100"
                            step="0.01"
                            value={bpsVal}
                            onChange={(e) => handleChange(bpsKey!, e.target.value)}
                            disabled={bpsSaving}
                            aria-describedby={bpsErr ? `config-error-${bpsKey!}` : undefined}
                            data-testid={`admin-config-input-${bpsKey!}`}
                            className={`input py-1.5 px-2 w-28 ${bpsErr ? 'border-[var(--color-danger)]' : ''}`}
                          />
                          <span className="text-xs text-[var(--color-text-muted)] whitespace-nowrap">%</span>
                          <button
                            type="button"
                            onClick={() => void handleSave(bpsKey!, bpsVal)}
                            disabled={bpsSaving || effectiveSavingKey !== null}
                            data-testid={`admin-config-save-${bpsKey!}`}
                            className="text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-primary)]/25 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                          >
                            {bpsSaving ? '保存中...' : '保存'}
                          </button>
                        </div>
                        {bpsCfg && (
                          <div className="text-xs text-[var(--color-text-muted)]">
                            部署默认值：{bpsToPercentString(bpsCfg.defaultValue)}% ({bpsCfg.defaultValue} 基点)
                          </div>
                        )}
                        {bpsErr && (
                          <div
                            id={`config-error-${bpsKey!}`}
                            className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-2 py-1 rounded border border-[var(--color-danger)]/20 max-w-sm"
                          >
                            {bpsErr}
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
export default MemberTierConfigPanel
