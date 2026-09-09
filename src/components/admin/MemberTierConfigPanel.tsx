import { AdminSystemConfig, AdminSystemConfigKey } from '../../api/adminConfig'
import { bpsToPercentString } from './adminConfigMeta'

export interface MemberTierConfigPanelProps {
  items: AdminSystemConfig[]
  drafts: Record<string, string>
  onChange: (key: AdminSystemConfigKey, raw: string) => void
  onSave: (key: AdminSystemConfigKey, raw: string) => Promise<void>
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
  savingKey = null,
  errors = {},
}: MemberTierConfigPanelProps) {

  return (
    <div className="space-y-4" data-testid="member-tier-config-panel">
      <div className="bg-[var(--color-info)]/8 border border-[var(--color-info)]/20 rounded-lg p-3 text-xs text-[var(--color-text-muted)] space-y-1">
        <p>
          <strong className="text-[var(--color-text)]">升级门槛规则：</strong>按用户累计获得的正向积分流水统计，不含冻结积分。门槛需严格满足：银卡 &lt; 金卡 &lt; 铂金。调大门槛时需先调大更高级别，调小门槛时需先调小更低级别。
        </p>
        <p>
          <strong className="text-[var(--color-text)]">额外加成计算：</strong>基础奖励乘以加成比例，结果向下取整。在签到和邀请新用户时叠加发放；修改仅对新计算的奖励生效，已创建的待发奖励不重新计算。
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
              const thVal = thKey ? drafts[thKey] ?? '' : '0'
              const thErr = thKey ? errors[thKey] : undefined
              const thSaving = thKey ? savingKey === thKey : false
              const thCfg = thKey ? items.find((c) => c.key === thKey) : undefined

              const bpsKey = t.bonusBpsKey
              const bpsVal = bpsKey ? drafts[bpsKey] ?? '' : '0'
              const bpsErr = bpsKey ? errors[bpsKey] : undefined
              const bpsSaving = bpsKey ? savingKey === bpsKey : false
              const bpsCfg = bpsKey ? items.find((c) => c.key === bpsKey) : undefined

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
                            onChange={(e) => onChange(thKey!, e.target.value)}
                            disabled={thSaving}
                            aria-describedby={thErr ? `config-error-${thKey!}` : undefined}
                            data-testid={`admin-config-input-${thKey!}`}
                            className={`input py-1.5 px-2 w-28 ${thErr ? 'border-[var(--color-danger)]' : ''}`}
                          />
                          <span className="text-xs text-[var(--color-text-muted)] whitespace-nowrap">积分</span>
                          <button
                            type="button"
                            onClick={() => void onSave(thKey!, thVal)}
                            disabled={thSaving || savingKey !== null}
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
                        <details className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                          <summary className="cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors text-[11px] underline decoration-dotted inline-block">
                            配置键名
                          </summary>
                          <div className="mt-0.5 font-mono text-[11px] text-[var(--color-text-muted)] select-all">
                            {thKey}
                          </div>
                        </details>
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
                            onChange={(e) => onChange(bpsKey!, e.target.value)}
                            disabled={bpsSaving}
                            aria-describedby={bpsErr ? `config-error-${bpsKey!}` : undefined}
                            data-testid={`admin-config-input-${bpsKey!}`}
                            className={`input py-1.5 px-2 w-28 ${bpsErr ? 'border-[var(--color-danger)]' : ''}`}
                          />
                          <span className="text-xs text-[var(--color-text-muted)] whitespace-nowrap">%</span>
                          <button
                            type="button"
                            onClick={() => void onSave(bpsKey!, bpsVal)}
                            disabled={bpsSaving || savingKey !== null}
                            data-testid={`admin-config-save-${bpsKey!}`}
                            className="text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-primary)]/25 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                          >
                            {bpsSaving ? '保存中...' : '保存'}
                          </button>
                        </div>
                        {bpsCfg && (
                          <div className="text-xs text-[var(--color-text-muted)]">
                            部署默认值：{bpsToPercentString(bpsCfg.defaultValue)}%
                          </div>
                        )}
                        <details className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                          <summary className="cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors text-[11px] underline decoration-dotted inline-block">
                            配置键名
                          </summary>
                          <div className="mt-0.5 font-mono text-[11px] text-[var(--color-text-muted)] select-all">
                            {bpsKey}
                          </div>
                        </details>
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
