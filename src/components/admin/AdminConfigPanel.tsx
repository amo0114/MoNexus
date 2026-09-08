import { useEffect, useState } from 'react'
import { getAdminConfig, updateAdminConfig, AdminSystemConfig, AdminSystemConfigKey } from '../../api/adminConfig'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import AdminMailPanel from './AdminMailPanel'
import MemberTierConfigPanel from './MemberTierConfigPanel'
import RegistrationControlPanel from './RegistrationControlPanel'
import {
  CONFIG_GROUPS,
  CONFIG_METAS,
  ConfigGroupId,
  bpsToPercentString,
  percentStringToBps,
} from './adminConfigMeta'

export default function AdminConfigPanel() {
  const showToast = useAppStore((s) => s.showToast)
  const [configs, setConfigs] = useState<AdminSystemConfig[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [savingKey, setSavingKey] = useState<AdminSystemConfigKey | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [activeGroup, setActiveGroup] = useState<ConfigGroupId>('registration')

  useEffect(() => {
    void fetchConfigs()
  }, [])

  async function fetchConfigs() {
    setLoading(true)
    setLoadError(false)
    try {
      const data = await getAdminConfig()
      setConfigs(data)
      const initial: Record<string, string> = {}
      data.forEach((c) => {
        if (c.key.endsWith('BonusBps')) {
          initial[c.key] = bpsToPercentString(c.value)
        } else {
          initial[c.key] = c.value.toString()
        }
      })
      setDrafts(initial)
      setErrors({})
    } catch (err: any) {
      setLoadError(true)
      showToast(getApiErrorMessage(err, '加载系统配置失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  function handleChange(key: AdminSystemConfigKey, raw: string) {
    setDrafts((prev) => ({ ...prev, [key]: raw }))
    // 清除该 key 的错误
    setErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  async function handleSave(key: AdminSystemConfigKey, raw: string): Promise<void> {
    const meta = CONFIG_METAS[key]
    if (!meta) return

    let valueToSave: number

    // 1. 类型解析与单字段校验
    if (meta.type === 'switch') {
      valueToSave = raw === '1' || raw === 'true' ? 1 : 0
    } else if (meta.type === 'percentage') {
      const res = percentStringToBps(raw)
      if (res.error) {
        setErrors((prev) => ({ ...prev, [key]: res.error! }))
        showToast(res.error, 'error')
        return
      }
      valueToSave = res.value!
    } else {
      const trimmed = raw.trim()
      if (trimmed === '') {
        const msg = '请输入配置值'
        setErrors((prev) => ({ ...prev, [key]: msg }))
        showToast(msg, 'error')
        return
      }
      const n = Number(trimmed)
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        const msg = '配置值必须是整数'
        setErrors((prev) => ({ ...prev, [key]: msg }))
        showToast(msg, 'error')
        return
      }
      if (meta.min !== undefined && n < meta.min) {
        const msg = `配置值不能小于 ${meta.min}`
        setErrors((prev) => ({ ...prev, [key]: msg }))
        showToast(msg, 'error')
        return
      }
      if (meta.max !== undefined && n > meta.max) {
        const msg = `配置值不能大于 ${meta.max}`
        setErrors((prev) => ({ ...prev, [key]: msg }))
        showToast(msg, 'error')
        return
      }
      valueToSave = n
    }

    // 2. 跨字段业务约束校验：仅针对当前保存项读取其待保存值，关联项取 configs 中已保存值，绝不读取其他项的草稿
    if (key === 'memberTierSilverThreshold' || key === 'memberTierGoldThreshold' || key === 'memberTierPlatinumThreshold') {
      const getConfirmedVal = (k: AdminSystemConfigKey) => {
        return configs.find((c) => c.key === k)?.value ?? 0
      }
      const silver = key === 'memberTierSilverThreshold' ? valueToSave : getConfirmedVal('memberTierSilverThreshold')
      const gold = key === 'memberTierGoldThreshold' ? valueToSave : getConfirmedVal('memberTierGoldThreshold')
      const platinum = key === 'memberTierPlatinumThreshold' ? valueToSave : getConfirmedVal('memberTierPlatinumThreshold')

      if (key === 'memberTierSilverThreshold' && silver >= gold) {
        const msg = `银卡门槛必须小于金卡门槛（当前金卡: ${gold} 积分）`
        setErrors((prev) => ({ ...prev, [key]: msg }))
        showToast(msg, 'error')
        return
      }
      if (key === 'memberTierGoldThreshold' && (gold <= silver || gold >= platinum)) {
        const msg = `金卡门槛必须大于银卡门槛（${silver} 积分）且小于铂金门槛（${platinum} 积分）`
        setErrors((prev) => ({ ...prev, [key]: msg }))
        showToast(msg, 'error')
        return
      }
      if (key === 'memberTierPlatinumThreshold' && platinum <= gold) {
        const msg = `铂金门槛必须大于金卡门槛（当前金卡: ${gold} 积分）`
        setErrors((prev) => ({ ...prev, [key]: msg }))
        showToast(msg, 'error')
        return
      }
    }

    if (key === 'referralDailyQualifiedLimit') {
      const lifetime = configs.find((c) => c.key === 'referralLifetimeQualifiedLimit')?.value ?? 0
      if (valueToSave > 0 && lifetime > 0 && valueToSave > lifetime) {
        const msg = `每日合格人数上限不能大于累计合格人数上限（当前累计: ${lifetime} 人）`
        setErrors((prev) => ({ ...prev, [key]: msg }))
        showToast(msg, 'error')
        return
      }
    }

    if (key === 'referralLifetimeQualifiedLimit') {
      const daily = configs.find((c) => c.key === 'referralDailyQualifiedLimit')?.value ?? 0
      if (valueToSave === 0 && daily > 0) {
        const msg = '若要将累计合格人数上限设为 0，须先将每日上限设为 0'
        setErrors((prev) => ({ ...prev, [key]: msg }))
        showToast(msg, 'error')
        return
      }
      if (valueToSave > 0 && daily > 0 && valueToSave < daily) {
        const msg = `累计合格人数上限不能小于每日合格人数上限（当前每日: ${daily} 人）`
        setErrors((prev) => ({ ...prev, [key]: msg }))
        showToast(msg, 'error')
        return
      }
    }

    // 3. 执行单项保存
    setSavingKey(key)
    try {
      const updated = await updateAdminConfig(key, valueToSave)
      setConfigs((prev) => prev.map((c) => (c.key === updated.key ? updated : c)))
      setDrafts((prev) => ({
        ...prev,
        [updated.key]: meta.type === 'percentage' ? bpsToPercentString(updated.value) : updated.value.toString(),
      }))
      setErrors((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      showToast(`「${meta.label}」已保存`)
    } catch (err: any) {
      const msg = getApiErrorMessage(err, '更新配置失败')
      setErrors((prev) => ({ ...prev, [key]: msg }))
      showToast(msg, 'error')
    } finally {
      setSavingKey(null)
    }
  }

  if (loading) {
    return <div className="text-sm text-[var(--color-text-muted)] py-4">加载中...</div>
  }

  if (loadError) {
    return (
      <div className="py-6 text-center">
        <p className="text-sm text-[var(--color-danger)] mb-3">系统配置加载失败</p>
        <button type="button" onClick={() => void fetchConfigs()} className="btn-secondary btn-sm px-4">
          重新加载
        </button>
      </div>
    )
  }

  const currentGroupDef = CONFIG_GROUPS.find((g) => g.id === activeGroup) || CONFIG_GROUPS[0]
  const currentItems = configs.filter((c) => CONFIG_METAS[c.key]?.group === activeGroup)

  return (
    <div className="space-y-6">
      {/* 顶部标题与说明 */}
      <div>
        <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">系统配置</h2>
        <p className="text-xs sm:text-sm text-[var(--color-text-muted)] mt-1">
          管理全站注册规则、奖励参数、会员门槛、交易履约及运行配置。各项配置具有唯一编辑入口，保存即生效。
        </p>
      </div>

      {/* 7 个分组的切换标签导航 */}
      <div
        role="tablist"
        aria-label="系统配置分组"
        className="flex flex-wrap items-center gap-1.5 p-1 bg-[var(--color-background)] rounded-xl border border-[var(--color-border)]"
      >
        {CONFIG_GROUPS.map((group) => {
          const isActive = activeGroup === group.id
          return (
            <button
              key={group.id}
              role="tab"
              type="button"
              id={`config-tab-${group.id}`}
              aria-selected={isActive}
              aria-controls={`config-tabpanel-${group.id}`}
              data-testid={`admin-config-tab-${group.id}`}
              onClick={() => setActiveGroup(group.id)}
              className={`px-3.5 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer whitespace-nowrap ${
                isActive
                  ? 'bg-[var(--color-primary)] text-white shadow-xs'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-primary)]/8'
              }`}
            >
              {group.title}
            </button>
          )
        })}
      </div>

      {/* 分组内容区 */}
      <section
        id={`config-tabpanel-${currentGroupDef.id}`}
        role="tabpanel"
        aria-labelledby={`config-tab-${currentGroupDef.id}`}
        data-testid="admin-config-group"
        data-group={currentGroupDef.title}
        className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden"
      >
        {/* 组头 */}
        <div className="px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-background)]/50">
          <h3 className="font-heading text-base font-bold text-[var(--color-text)]">{currentGroupDef.title}</h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{currentGroupDef.description}</p>
        </div>

        {/* 组内主体 */}
        <div className="p-4 sm:p-6">
          {activeGroup === 'registration' ? (
            <RegistrationControlPanel
              items={configs}
              drafts={drafts}
              onChange={handleChange}
              onSave={handleSave}
              savingKey={savingKey}
              errors={errors}
            />
          ) : activeGroup === 'memberTier' ? (
            <MemberTierConfigPanel
              items={configs}
              drafts={drafts}
              onChange={handleChange}
              onSave={handleSave}
              savingKey={savingKey}
              errors={errors}
            />
          ) : (
            <div className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] bg-[var(--color-background)]">
              {currentItems.map((c) => {
                const meta = CONFIG_METAS[c.key]
                if (!meta) return null
                const rawVal = drafts[c.key] ?? ''
                const error = errors[c.key]
                const isSaving = savingKey === c.key

                return (
                  <div key={c.key} className="px-4 py-3 flex flex-col sm:flex-row sm:items-start gap-3">
                    <div className="flex-grow min-w-0">
                      <label
                        htmlFor={`admin-config-input-${c.key}`}
                        className="font-bold text-sm text-[var(--color-text)] cursor-pointer"
                      >
                        {meta.label}
                      </label>
                      <p id={`admin-config-hint-${c.key}`} className="text-xs text-[var(--color-text-muted)] mt-0.5">
                        {meta.description}
                      </p>
                      <details className="mt-1 text-xs text-[var(--color-text-muted)]">
                        <summary className="cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors text-[11px] underline decoration-dotted inline-block">
                          配置键名
                        </summary>
                        <div className="mt-0.5 font-mono text-[11px] text-[var(--color-text-muted)] select-all">
                          {c.key}
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
                        <input
                          id={`admin-config-input-${c.key}`}
                          type="number"
                          min={meta.min ?? 0}
                          max={meta.max}
                          step="1"
                          value={rawVal}
                          onChange={(e) => handleChange(c.key, e.target.value)}
                          disabled={isSaving}
                          aria-describedby={`admin-config-hint-${c.key}`}
                          data-testid={`admin-config-input-${c.key}`}
                          className={`input py-1.5 px-2 w-28 ${error ? 'border-[var(--color-danger)]' : ''}`}
                        />
                        {meta.unit && (
                          <span className="text-xs text-[var(--color-text-muted)] whitespace-nowrap">{meta.unit}</span>
                        )}
                        <button
                          type="button"
                          disabled={isSaving || savingKey !== null}
                          onClick={() => void handleSave(c.key, rawVal)}
                          data-testid={`admin-config-save-${c.key}`}
                          className="text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-primary)]/25 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                        >
                          {isSaving ? '保存中...' : '保存'}
                        </button>
                      </div>
                      <div className="text-xs text-[var(--color-text-muted)] mt-1">
                        当前部署默认值：{c.defaultValue} {meta.unit ?? ''}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* 高级运维组额外显示邮件投递面板 */}
          {activeGroup === 'ops' && (
            <div className="mt-6 pt-6 border-t border-[var(--color-border)]">
              <AdminMailPanel />
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
