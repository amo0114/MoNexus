import { useEffect, useState } from 'react'
import { BellRing } from 'lucide-react'
import { getApiErrorMessage } from '../api/error'
import {
  disablePush,
  enablePush,
  getCurrentPushSubscription,
  getPushConfig,
  isPushSupported,
  needsIosInstall,
  syncPushSubscription,
} from '../lib/webPush'
import { useAppStore } from '../stores/appStore'

type PushState =
  | { kind: 'loading' }
  | { kind: 'hidden' }
  | { kind: 'ios-install' }
  | { kind: 'denied' }
  | { kind: 'ready'; publicKey: string; subscribed: boolean }

/**
 * SPEC-ENGAGE-001 PW-03：浏览器推送开关。服务端未开启或浏览器不支持时不渲染。
 */
export default function PushToggle() {
  const showToast = useAppStore(s => s.showToast)
  const [state, setState] = useState<PushState>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const config = await getPushConfig().catch(() => null)
      if (!config?.enabled || !config.publicKey) return { kind: 'hidden' } as const
      if (needsIosInstall()) return { kind: 'ios-install' } as const
      if (!isPushSupported()) return { kind: 'hidden' } as const
      if (Notification.permission === 'denied') return { kind: 'denied' } as const
      const existing = Notification.permission === 'granted' ? await getCurrentPushSubscription() : null
      // 同一浏览器换账号登录后，把已有订阅改绑到当前账号。
      if (existing) await syncPushSubscription(existing).catch(() => {})
      return { kind: 'ready', publicKey: config.publicKey, subscribed: existing !== null } as const
    }
    void load().then(next => { if (!cancelled) setState(next) })
    return () => { cancelled = true }
  }, [])

  if (state.kind === 'loading' || state.kind === 'hidden') return null

  async function toggle() {
    if (state.kind !== 'ready') return
    setBusy(true)
    try {
      if (state.subscribed) {
        await disablePush()
        setState({ ...state, subscribed: false })
        showToast('已关闭浏览器推送')
      } else if (await enablePush(state.publicKey)) {
        setState({ ...state, subscribed: true })
        showToast('已开启浏览器推送')
      } else {
        setState({ kind: Notification.permission === 'denied' ? 'denied' : 'ready', publicKey: state.publicKey, subscribed: false } as PushState)
      }
    } catch (err) {
      showToast(getApiErrorMessage(err, '推送设置失败'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5" data-testid="push-toggle">
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-9 h-9 rounded-lg bg-[var(--color-primary-tint)] flex items-center justify-center">
          <BellRing className="w-4 h-4 text-[var(--color-primary)]" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-sm text-[var(--color-text)]">浏览器推送</h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">
            {state.kind === 'ios-install' && '在 Safari 中点「分享 → 添加到主屏幕」，从主屏幕打开后即可开启推送。'}
            {state.kind === 'denied' && '浏览器已拒绝通知权限，请在浏览器的网站设置中允许通知后刷新页面。'}
            {state.kind === 'ready' && '连签快断、奖励待领取和重要公告会推送到这台设备。'}
          </p>
        </div>
        {state.kind === 'ready' && (
          <button
            type="button"
            onClick={() => void toggle()}
            disabled={busy}
            data-testid="push-toggle-button"
            className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer disabled:opacity-60 ${
              state.subscribed
                ? 'border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                : 'bg-[var(--color-primary)] text-[var(--color-on-primary)] hover:bg-[var(--color-primary-hover)]'
            }`}
          >
            {busy ? '处理中…' : state.subscribed ? '关闭' : '开启'}
          </button>
        )}
      </div>
    </div>
  )
}
