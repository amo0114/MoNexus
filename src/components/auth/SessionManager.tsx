import { useCallback, useEffect, useState } from 'react'
import { Laptop, Loader2, LogOut, RefreshCw, ShieldCheck } from 'lucide-react'
import {
  getActiveSessions,
  revokeOtherSessions,
  revokeSession,
  type ActiveSessionSummary,
} from '../../api/auth'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import ConfirmDialog from '../ui/ConfirmDialog'

type PendingAction =
  | { kind: 'single'; session: ActiveSessionSummary }
  | { kind: 'others' }
  | null

function formatSessionTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未知时间'
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export default function SessionManager() {
  const showToast = useAppStore((state) => state.showToast)
  const [sessions, setSessions] = useState<ActiveSessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)
  const [submitting, setSubmitting] = useState(false)

  const loadSessions = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setSessions(await getActiveSessions())
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, '无法加载登录设备'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  async function handleConfirm() {
    const action = pendingAction
    if (!action || submitting) return

    setSubmitting(true)
    try {
      if (action.kind === 'single') {
        await revokeSession(action.session.sessionId)
        showToast('该设备已退出')
      } else {
        const result = await revokeOtherSessions()
        showToast(result.revokedCount > 0 ? `已退出其他 ${result.revokedCount} 台设备` : '没有其他设备需要退出')
      }
      setPendingAction(null)
      await loadSessions()
    } catch (requestError) {
      showToast(getApiErrorMessage(requestError, '退出设备失败，请稍后重试'), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const hasOtherSessions = sessions.some((session) => !session.current)
  const dialogTitle = pendingAction?.kind === 'single' ? '退出此设备？' : '退出其他设备？'
  const dialogDescription = pendingAction?.kind === 'single'
    ? `“${pendingAction.session.deviceLabel}”将需要重新登录。当前设备不会受影响。`
    : '除当前设备外，所有登录设备都将需要重新登录。'

  return (
    <section className="card flex flex-col gap-4" data-testid="session-manager" aria-busy={loading}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)]/10 text-[var(--color-primary)]">
            <Laptop className="h-6 w-6" />
          </div>
          <div>
            <h4 className="font-heading font-bold text-[var(--color-text)]">登录设备</h4>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">查看当前活跃会话；当前设备请使用页面底部的退出账号操作。</p>
          </div>
        </div>
        <button
          type="button"
          className="btn-secondary shrink-0 px-4 py-2 text-sm"
          onClick={() => setPendingAction({ kind: 'others' })}
          disabled={loading || !hasOtherSessions || submitting}
          data-testid="session-revoke-others"
        >
          退出其他设备
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6 text-sm text-[var(--color-text-muted)]">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />正在加载登录设备…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-[var(--color-danger)]/25 bg-[var(--color-danger)]/10 p-4">
          <p className="text-sm text-[var(--color-danger)]" role="alert">{error}</p>
          <button type="button" className="btn-secondary mt-3 px-3 py-1.5 text-xs" onClick={() => void loadSessions()}>
            <RefreshCw className="mr-1 inline h-3.5 w-3.5" />重试
          </button>
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-5 text-center text-sm text-[var(--color-text-muted)]">
          暂无可显示的活跃设备。
        </div>
      ) : (
        <div className="space-y-3">
          {sessions.map((session) => (
            <article key={session.sessionId} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-4" data-testid="session-device">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h5 className="font-medium text-[var(--color-text)]">{session.deviceLabel}</h5>
                    {session.current && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-cta)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-cta)]" data-testid="session-current-badge">
                        <ShieldCheck className="h-3 w-3" />当前设备
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-[var(--color-text-muted)]">IP：{session.ipHint}</p>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">最近活跃：{formatSessionTime(session.lastUsedAt)}</p>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">登录时间：{formatSessionTime(session.sessionStartedAt)}</p>
                </div>
                {session.current ? (
                  <span className="text-xs text-[var(--color-text-muted)]">当前设备只能通过退出账号结束会话</span>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary inline-flex shrink-0 items-center justify-center gap-1.5 border-[var(--color-danger)]/40 px-3 py-1.5 text-xs text-[var(--color-danger)]"
                    onClick={() => setPendingAction({ kind: 'single', session })}
                    disabled={submitting}
                    data-testid="session-revoke-device"
                  >
                    <LogOut className="h-3.5 w-3.5" />退出此设备
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open && !submitting) setPendingAction(null)
        }}
        title={dialogTitle}
        description={dialogDescription}
        confirmLabel="确认退出"
        loading={submitting}
        onConfirm={() => void handleConfirm()}
      />
    </section>
  )
}
