import React, { useState, useEffect } from 'react'
import { getConfigRegistry } from '../../api/registry'
import { updateAdminConfig, AdminSystemConfigKey } from '../../api/adminConfig'
import { getApiErrorMessage } from '../../api/error'

interface TierData {
  value: string
  label: string
  tone: string
  thresholdKey: string | null
  bonusBpsKey: string | null
  thresholdValue: string
  bonusBpsValue: string
}

export function MemberTierConfigPanel() {
  const [tiers, setTiers] = useState<TierData[]>([])
  const [loading, setLoading] = useState(true)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [successes, setSuccesses] = useState<Record<string, boolean>>({})

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    setLoading(true)
    try {
      const reg: any = await getConfigRegistry()
      const memberTiers = reg.memberTiers || []
      const th = reg.memberTierThresholds || {}
      const bps = reg.memberTierBonusBps || {}
      
      const mapped: TierData[] = memberTiers.map((t: any) => {
        let thKey: string | null = null
        let bpsKey: string | null = null
        let thVal = '0'
        let bpsVal = '0'
        
        if (t.value === 'silver') {
          thKey = 'memberTierSilverThreshold'
          bpsKey = 'memberTierSilverBonusBps'
          thVal = th.silver?.toString() || '0'
          bpsVal = bps.silver?.toString() || '0'
        } else if (t.value === 'gold') {
          thKey = 'memberTierGoldThreshold'
          bpsKey = 'memberTierGoldBonusBps'
          thVal = th.gold?.toString() || '0'
          bpsVal = bps.gold?.toString() || '0'
        } else if (t.value === 'platinum') {
          thKey = 'memberTierPlatinumThreshold'
          bpsKey = 'memberTierPlatinumBonusBps'
          thVal = th.platinum?.toString() || '0'
          bpsVal = bps.platinum?.toString() || '0'
        }
        
        return {
          value: t.value,
          label: t.label,
          tone: t.tone,
          thresholdKey: thKey,
          bonusBpsKey: bpsKey,
          thresholdValue: thVal,
          bonusBpsValue: bpsVal
        }
      })
      
      setTiers(mapped)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  function handleInput(tierValue: string, field: 'thresholdValue' | 'bonusBpsValue', val: string) {
    setTiers(prev => prev.map(t => {
      if (t.value === tierValue) {
        return { ...t, [field]: val }
      }
      return t
    }))
    setErrors(prev => {
      const copy = { ...prev }
      const t = tiers.find(x => x.value === tierValue)
      if (t) {
        if (field === 'thresholdValue' && t.thresholdKey) delete copy[t.thresholdKey]
        if (field === 'bonusBpsValue' && t.bonusBpsKey) delete copy[t.bonusBpsKey]
      }
      return copy
    })
  }

  async function handleSave(key: string, rawVal: string) {
    const val = parseInt(rawVal, 10)
    if (isNaN(val) || val < 0) {
      setErrors(prev => ({ ...prev, [key]: '请输入有效的非负整数' }))
      return
    }
    
    setSavingKey(key)
    setErrors(prev => {
      const copy = { ...prev }
      delete copy[key]
      return copy
    })
    setSuccesses(prev => {
      const copy = { ...prev }
      delete copy[key]
      return copy
    })
    
    try {
      await updateAdminConfig(key as AdminSystemConfigKey, val)
      setSuccesses(prev => ({ ...prev, [key]: true }))
      setTimeout(() => {
        setSuccesses(prev => {
          const copy = { ...prev }
          delete copy[key]
          return copy
        })
      }, 3000)
    } catch (err: any) {
      const msg = getApiErrorMessage(err, '保存失败，请稍后重试')
      setErrors(prev => ({ ...prev, [key]: msg }))
    } finally {
      setSavingKey(null)
    }
  }

  if (loading) {
    return <div className="text-sm text-[var(--color-text-muted)] py-4">加载中...</div>
  }

  return (
    <div className="overflow-x-auto bg-[var(--color-background)] rounded-lg border border-[var(--color-border)]">
      <table className="admin-table !border-0">
        <thead>
          <tr>
            <th className="!border-b !border-[var(--color-border)]">等级名称</th>
            <th className="!border-b !border-[var(--color-border)]">升级阈值 (累计积分)</th>
            <th className="!border-b !border-[var(--color-border)] w-1/3">加成倍率 (基点)</th>
          </tr>
        </thead>
        <tbody>
          {tiers.map((t) => {
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

            return (
              <tr key={t.value} className={isBronze ? 'opacity-60 bg-[var(--color-text-muted)]/5' : ''}>
                <td>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border ${badgeStyles}`}>
                    {t.label}
                  </span>
                </td>
                
                {/* Threshold Cell */}
                <td>
                  {isBronze ? (
                    <div className="text-sm text-[var(--color-text-muted)] px-2">0 (不可修改)</div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={t.thresholdValue}
                          onChange={(e) => handleInput(t.value, 'thresholdValue', e.target.value)}
                          disabled={savingKey === t.thresholdKey}
                          className="input !text-sm !py-1.5 !px-2 w-28"
                        />
                        <button
                          onClick={() => t.thresholdKey && handleSave(t.thresholdKey, t.thresholdValue)}
                          disabled={savingKey === t.thresholdKey || savingKey !== null}
                          className="text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-semibold text-xs px-3 py-1.5 rounded-lg transition-colors border border-[var(--color-primary)]/25 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                        >
                          {savingKey === t.thresholdKey ? '保存中...' : '保存'}
                        </button>
                        {t.thresholdKey && successes[t.thresholdKey] && (
                          <span className="text-xs text-[var(--color-cta)] font-bold whitespace-nowrap">已保存</span>
                        )}
                      </div>
                      {t.thresholdKey && errors[t.thresholdKey] && (
                        <div className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-2 py-1 rounded border border-[var(--color-danger)]/20 mt-1 max-w-sm">
                          {errors[t.thresholdKey]}
                        </div>
                      )}
                    </div>
                  )}
                </td>
                
                {/* Bonus Bps Cell */}
                <td>
                  {isBronze ? (
                    <div className="text-sm text-[var(--color-text-muted)] px-2">0 (不可修改)</div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="0"
                          max="10000"
                          step="1"
                          value={t.bonusBpsValue}
                          onChange={(e) => handleInput(t.value, 'bonusBpsValue', e.target.value)}
                          disabled={savingKey === t.bonusBpsKey}
                          className="input !text-sm !py-1.5 !px-2 w-28"
                        />
                        <button
                          onClick={() => t.bonusBpsKey && handleSave(t.bonusBpsKey, t.bonusBpsValue)}
                          disabled={savingKey === t.bonusBpsKey || savingKey !== null}
                          className="text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-semibold text-xs px-3 py-1.5 rounded-lg transition-colors border border-[var(--color-primary)]/25 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                        >
                          {savingKey === t.bonusBpsKey ? '保存中...' : '保存'}
                        </button>
                        <span className="text-xs text-[var(--color-text-muted)] ml-1 whitespace-nowrap">
                          当前 {t.bonusBpsValue ? (parseInt(t.bonusBpsValue, 10) / 100).toFixed(1).replace(/\.0$/, '') : 0}%
                        </span>
                        {t.bonusBpsKey && successes[t.bonusBpsKey] && (
                          <span className="text-xs text-[var(--color-cta)] font-bold whitespace-nowrap ml-1">已保存</span>
                        )}
                      </div>
                      {t.bonusBpsKey && errors[t.bonusBpsKey] && (
                        <div className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-2 py-1 rounded border border-[var(--color-danger)]/20 mt-1 max-w-sm">
                          {errors[t.bonusBpsKey]}
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
  )
}
