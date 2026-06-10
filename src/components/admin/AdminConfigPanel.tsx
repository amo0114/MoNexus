import { useEffect, useState } from 'react'
import { getAdminConfig, updateAdminConfig, AdminSystemConfig } from '../../api/adminConfig'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'

/** 后端约定的 5 个分组，按此顺序渲染 */
const GROUP_ORDER = ['奖励发放', '安全', '分页限制', '库存', '会员等级']

function validateValue(raw: string): string | null {
  if (raw.trim() === '') return '请输入配置值'
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return '配置值必须是整数'
  if (n < 0) return '配置值不能为负数'
  return null
}

/** 系统配置面板：按中文分组渲染，主标签为中文描述，英文 key 为辅助文本 */
export default function AdminConfigPanel() {
  const showToast = useAppStore((s) => s.showToast)
  const [configs, setConfigs] = useState<AdminSystemConfig[]>([])
  const [values, setValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchConfigs()
  }, [])

  async function fetchConfigs() {
    setLoading(true)
    try {
      const data = await getAdminConfig()
      setConfigs(data)
      const initial: Record<string, string> = {}
      data.forEach((c) => (initial[c.key] = c.value.toString()))
      setValues(initial)
      setErrors({})
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '加载系统配置失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  function handleChange(key: string, raw: string) {
    setValues((prev) => ({ ...prev, [key]: raw }))
    // 即时校验
    const msg = validateValue(raw)
    setErrors((prev) => {
      const next = { ...prev }
      if (msg) {
        next[key] = msg
      } else {
        delete next[key]
      }
      return next
    })
  }

  async function handleSave(config: AdminSystemConfig) {
    const raw = values[config.key] ?? ''
    const msg = validateValue(raw)
    if (msg) {
      setErrors((prev) => ({ ...prev, [config.key]: msg }))
      showToast(msg, 'error')
      return
    }
    setSavingKey(config.key)
    try {
      const updated = await updateAdminConfig(config.key, parseInt(raw, 10))
      showToast(`「${config.description}」已保存`)
      setConfigs((prev) => prev.map((c) => (c.key === updated.key ? updated : c)))
      setValues((prev) => ({ ...prev, [updated.key]: updated.value.toString() }))
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '更新配置失败'), 'error')
    } finally {
      setSavingKey(null)
    }
  }

  if (loading) {
    return <div className="text-sm text-[var(--color-text-muted)] py-4">加载中...</div>
  }

  // 按约定顺序分组，未知分组追加在末尾
  const knownGroups = GROUP_ORDER.filter((g) => configs.some((c) => c.group === g))
  const extraGroups = [...new Set(configs.map((c) => c.group))].filter((g) => !GROUP_ORDER.includes(g))
  const groups = [...knownGroups, ...extraGroups]

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section
          key={group}
          data-testid="admin-config-group"
          data-group={group}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] overflow-hidden"
        >
          <h3 className="px-4 py-3 text-sm font-bold text-[var(--color-text)] border-b border-[var(--color-border)] bg-[var(--color-primary)]/5">
            {group}
          </h3>
          <div className="divide-y divide-[var(--color-border)]">
            {configs
              .filter((c) => c.group === group)
              .map((c) => (
                <div key={c.key} className="px-4 py-3 flex flex-col sm:flex-row sm:items-start gap-3">
                  <div className="flex-grow min-w-0">
                    <div className="font-bold text-sm text-[var(--color-text)]">{c.description}</div>
                    <div className="text-[11px] text-[var(--color-text-muted)] font-mono mt-0.5">{c.key}</div>
                    {c.hint && (
                      <div className="text-xs text-[var(--color-text-muted)] mt-1 bg-[var(--color-info)]/8 border border-[var(--color-info)]/20 rounded px-2 py-1 inline-block">
                        {c.hint}
                      </div>
                    )}
                  </div>
                  <div className="flex-shrink-0 sm:w-72">
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={values[c.key] ?? ''}
                        onChange={(e) => handleChange(c.key, e.target.value)}
                        disabled={savingKey === c.key}
                        data-testid={`admin-config-input-${c.key}`}
                        className={`input !text-sm !py-1.5 !px-2 w-28 ${
                          errors[c.key] ? '!border-[var(--color-danger)]' : ''
                        }`}
                      />
                      {c.unit && (
                        <span className="text-xs text-[var(--color-text-muted)] whitespace-nowrap">{c.unit}</span>
                      )}
                      <button
                        disabled={savingKey !== null || !!errors[c.key]}
                        onClick={() => handleSave(c)}
                        data-testid={`admin-config-save-${c.key}`}
                        className="text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-semibold text-xs px-3 py-1.5 rounded-lg transition-colors border border-[var(--color-primary)]/25 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                      >
                        {savingKey === c.key ? '保存中...' : '保存'}
                      </button>
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)] mt-1">默认值：{c.defaultValue}</div>
                    {errors[c.key] && (
                      <div className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-2 py-1 rounded border border-[var(--color-danger)]/20 mt-1">
                        {errors[c.key]}
                      </div>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </section>
      ))}
    </div>
  )
}
