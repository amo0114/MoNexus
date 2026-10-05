import { useCallback, useEffect, useState } from 'react'
import { Bot, Link2Off } from 'lucide-react'
import api from '../api/client'
import { useAppStore } from '../stores/appStore'
import { getApiErrorMessage } from '../api/error'

/**
 * SPEC-CHAT-BOT-001 — QQ 机器人绑定状态卡片。
 *
 * 注意这里**不提供「生成绑定码」按钮**。绑定主路径在 QQ 群内完成：
 * `/绑定 <注册邮箱>` → 收邮箱验证码 → `/确认 <码>`。要求用户先打开网站
 * 再抄码，等于用「来网站」解决「不来网站」的问题，属于循环依赖。
 *
 * 本卡片只承担两件事：
 * 1. 展示是否已绑定（很多用户不记得自己绑过没有）
 * 2. 提供解绑入口
 */

interface BindStatus {
  bound: boolean
  platform: string | null
  platformId: string | null
  boundAt: string | null
}

export default function ChatBindCard() {
  const showToast = useAppStore((s) => s.showToast)
  const [status, setStatus] = useState<BindStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const loadStatus = useCallback(() => {
    api
      .get('/points/chat-bind/status')
      .then(({ data }) => setStatus(data))
      .catch(() => setStatus({ bound: false, platform: null, platformId: null, boundAt: null }))
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  async function handleUnbind() {
    if (!window.confirm('解绑后将无法在 QQ 侧签到与查询，确定解绑？')) return
    setBusy(true)
    try {
      await api.delete('/points/chat-bind')
      showToast('已解绑')
      loadStatus()
    } catch (err) {
      showToast(getApiErrorMessage(err, '解绑失败'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
      data-testid="chat-bind-card"
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-9 h-9 rounded-lg bg-[var(--color-primary-tint)] flex items-center justify-center">
          <Bot className="w-5 h-5 text-[var(--color-primary)]" />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="font-sans font-bold text-[var(--color-text)] text-sm sm:text-base">
            QQ 机器人签到
          </h4>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5 leading-relaxed">
            {status?.bound
              ? '已绑定，可在 QQ 群或私聊中发送「签到」领取积分。'
              : '无需打开网站：在 QQ 群直接发送下方命令即可完成绑定。'}
          </p>
        </div>
      </div>

      {status?.bound ? (
        <div className="mt-3 space-y-2">
          <div className="flex items-center justify-between rounded-lg bg-[var(--color-background)] px-3 py-2 text-xs">
            <span className="text-[var(--color-text-muted)]">已绑定 QQ</span>
            <span className="font-mono font-bold text-[var(--color-text)]">
              {status.platformId}
            </span>
          </div>
          <button
            type="button"
            onClick={handleUnbind}
            disabled={busy}
            data-testid="chat-bind-unbind"
            className="max-md:min-h-10 w-full inline-flex items-center justify-center gap-1.5 btn-secondary px-3 py-1.5 text-xs disabled:opacity-60"
          >
            <Link2Off className="w-3.5 h-3.5" />
            {busy ? '处理中…' : '解除绑定'}
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-xs flex items-center justify-between gap-2">
            <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">群内命令:</span>
            <code className="font-mono text-xs text-[var(--color-text)] truncate">
              /绑定 邮箱 → /确认 验证码
            </code>
          </div>
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <span className="text-[11px] text-[var(--color-text-muted)] truncate">
              绑定后即可在群内签到与查积分
            </span>
            <button
              type="button"
              onClick={loadStatus}
              data-testid="chat-bind-refresh"
              className="max-md:min-h-10 px-2 text-xs font-semibold text-[var(--color-primary)] hover:underline shrink-0 cursor-pointer"
            >
              刷新绑定状态
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
