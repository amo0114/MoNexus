import { useEffect, useState } from 'react'
import { getAdminConfig, updateAdminConfig } from '../../api/adminConfig'
import { getApiErrorMessage } from '../../api/error'
import ConfirmDialog from '../ui/ConfirmDialog'
import { useAppStore } from '../../stores/appStore'

const CONFIG_KEY = 'registrationEnabled'

/** 规格 §5.2 的关闭确认文案，逐字使用。 */
const DISABLE_CONFIRM = '关闭后新访客无法创建账号，现有用户仍可登录。确认关闭？'

/**
 * SPEC-OPS-REGMAIL-001 §5.2「账户与注册」卡片。
 * 复用既有 `PUT /admin/config/registrationEnabled`（已受 MFA 中间件与 AdminLog 保护），
 * 不新增平行写接口。开关只是运营体验，真正的边界在后端 registerUser()（REG-04）。
 */
export default function RegistrationControlPanel() {
  const showToast = useAppStore((s) => s.showToast)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    void fetchStatus()
  }, [])

  async function fetchStatus() {
    setLoading(true)
    try {
      const list = await getAdminConfig()
      const entry = list.find((c) => c.key === CONFIG_KEY)
      // C2 fail-closed 读法：enabled ⇔ value === 1；缺项时按后端默认视为开启。
      setEnabled(entry ? entry.value === 1 : true)
      setLoadError(false)
    } catch (err) {
      setLoadError(true)
      showToast(getApiErrorMessage(err, '加载注册开关失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  async function save(next: boolean) {
    // 单飞：保存期间不接受任何新的切换请求，避免连点产生多次 PUT。
    if (saving) return
    setSaving(true)
    try {
      const updated = await updateAdminConfig(CONFIG_KEY, next ? 1 : 0)
      setEnabled(updated.value === 1)
      showToast(next ? '已开启新用户注册' : '已关闭新用户注册')
    } catch (err) {
      showToast(getApiErrorMessage(err, '更新注册开关失败'), 'error')
      // 失败不保留乐观值：回读服务端真实状态（P.13）。
      await fetchStatus()
    } finally {
      setSaving(false)
    }
  }

  function handleToggle() {
    if (saving || enabled === null) return
    // C13：只有「关闭」是破坏性动作需要确认；开启直接保存。
    if (enabled) {
      setConfirmOpen(true)
      return
    }
    void save(true)
  }

  const stateText = enabled ? '已开启' : '已关闭'

  return (
    <section data-testid="registration-control-panel">
      <h2 className="font-heading text-xl font-bold mb-2 text-[var(--color-text)]">账户与注册</h2>
      <p className="text-sm text-[var(--color-text-muted)] mb-4">
        关闭后仅阻止新账号自助注册；现有账号仍可登录。
      </p>

      {loading ? (
        <div className="text-sm text-[var(--color-text-muted)] py-4">加载中...</div>
      ) : loadError ? (
        <div className="text-sm text-[var(--color-danger)] py-2" data-testid="registration-control-error">
          注册开关状态加载失败
          <button type="button" className="btn-secondary btn-sm ml-3 px-3" onClick={() => void fetchStatus()}>
            重试
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-3 flex flex-wrap items-center gap-3">
          <div className="flex-grow min-w-0">
            <div className="font-bold text-sm text-[var(--color-text)]">允许新用户注册</div>
            <div className="text-xs text-[var(--color-text-muted)] font-mono mt-0.5 break-all">{CONFIG_KEY}</div>
          </div>
          {/* 状态文字与开关并存：不依赖颜色单一通道传达状态（规格 §5.2） */}
          <span
            data-testid="registration-toggle-state"
            className="text-sm font-semibold text-[var(--color-text)] whitespace-nowrap"
          >
            {stateText}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled === true}
            aria-label="允许新用户注册"
            disabled={saving}
            onClick={handleToggle}
            data-testid="registration-toggle"
            /* min-w/min-h 40px：与移动端 ≥40px 触控目标契约一致 */
            className="relative inline-flex items-center shrink-0 min-w-[40px] min-h-[40px] px-1 rounded-full cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          >
            <span
              aria-hidden="true"
              className={`w-11 h-6 rounded-full transition-colors ${
                enabled ? 'bg-[var(--color-success)]' : 'bg-[var(--color-border)]'
              }`}
            >
              <span
                className={`block w-5 h-5 mt-0.5 rounded-full bg-white shadow transition-transform ${
                  enabled ? 'translate-x-[1.375rem]' : 'translate-x-0.5'
                }`}
              />
            </span>
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="关闭新用户注册"
        description={DISABLE_CONFIRM}
        confirmLabel="确认关闭"
        loading={saving}
        onConfirm={() => {
          setConfirmOpen(false)
          void save(false)
        }}
      />
    </section>
  )
}
