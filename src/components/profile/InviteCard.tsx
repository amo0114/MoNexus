import { useState, useEffect } from 'react'
import { Loader2, Sparkles, Plus, Copy, Link as LinkIcon } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { getApiErrorMessage } from '../../api/error'
import { getMyInvites, createInviteCode, type MyInvitesResponse } from '../../api/invites'
import { copyToClipboard } from '../../utils/clipboard'

// 邀请返佣卡片
export default function InviteCard() {
  const showToast = useAppStore((s) => s.showToast)
  const [inviteData, setInviteData] = useState<MyInvitesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  async function loadInvites() {
    setLoading(true)
    try {
      const data = await getMyInvites()
      setInviteData(data)
    } catch {
      setInviteData(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadInvites()
  }, [])

  async function handleCreateInvite() {
    setCreating(true)
    try {
      const code = await createInviteCode()
      setInviteData((current) => {
        if (!current) return current
        return {
          ...current,
          codes: [code, ...current.codes],
          quota:
            current.quota === null
              ? null
              : {
                  ...current.quota,
                  used: current.quota.used + 1,
                  remaining: Math.max(0, current.quota.remaining - 1),
                },
        }
      })
      showToast('邀请码已生成')
    } catch (err: unknown) {
      showToast(getApiErrorMessage(err, '生成邀请码失败'), 'error')
    } finally {
      setCreating(false)
    }
  }

  async function copyCode(code: string) {
    const copied = await copyToClipboard(code)
    showToast(copied ? '邀请码已复制' : '复制失败，请手动复制', copied ? 'success' : 'error')
  }

  async function copyLink(code: string) {
    const link = `${window.location.origin}/i/${code}`
    const copied = await copyToClipboard(link)
    showToast(copied ? '邀请链接已复制' : '复制失败，请手动复制', copied ? 'success' : 'error')
  }

  if (loading) {
    return (
      <div className="card flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-[var(--color-text-muted)] mr-2" />
        <span className="text-sm text-[var(--color-text-muted)]">加载邀请信息...</span>
      </div>
    )
  }

  const activeCodes = (inviteData?.codes || []).filter((c) => c.status === 'active')
  const inactiveCodes = (inviteData?.codes || []).filter((c) => c.status !== 'active')
  const canGenerate = Boolean(
    inviteData?.eligible &&
      (inviteData.quota === null || (inviteData.quota && inviteData.quota.remaining > 0))
  )

  return (
    <div className="card flex flex-col gap-4">
      <div className="flex items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 rounded-xl flex items-center justify-center shrink-0">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <h4 className="font-heading font-bold text-sm sm:text-base text-[var(--color-text)]">邀请赚积分</h4>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">好友验证邮箱并完成签到，奖励即刻入账</p>
          </div>
        </div>

        {canGenerate && (
          <button
            onClick={handleCreateInvite}
            disabled={creating}
            className="btn-primary text-xs px-3 py-1.5 shrink-0 inline-flex items-center gap-1"
          >
            {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            生成新码
          </button>
        )}
      </div>

      <div className="border-t border-[var(--color-border)]/60 pt-3">
        {activeCodes.length === 0 ? (
          <div className="text-center py-5 bg-[var(--color-background)] rounded-xl border border-dashed border-[var(--color-border)]">
            <p className="text-xs text-[var(--color-text-muted)]">暂无可用邀请码</p>
            {canGenerate && (
              <button
                onClick={handleCreateInvite}
                disabled={creating}
                className="mt-2 text-xs font-bold text-[var(--color-primary)] hover:underline inline-flex items-center gap-1 cursor-pointer"
              >
                立即生成邀请码
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {activeCodes.map((code) => (
              <div
                key={code.code}
                className="flex flex-col sm:flex-row sm:items-center justify-between p-3 bg-[var(--color-background)] rounded-xl border border-[var(--color-border)] gap-2"
              >
                <span className="font-mono text-sm font-bold text-[var(--color-text)]">{code.code}</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => copyCode(code.code)}
                    className="text-xs px-2.5 py-1.5 rounded-lg bg-[var(--color-primary)]/10 text-[var(--color-primary)] hover:bg-[var(--color-primary)]/20 transition-colors inline-flex items-center gap-1 cursor-pointer font-medium"
                    title="复制邀请码"
                  >
                    <Copy className="w-3.5 h-3.5" /> 复制码
                  </button>
                  <button
                    onClick={() => copyLink(code.code)}
                    className="text-xs px-2.5 py-1.5 rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] transition-colors inline-flex items-center gap-1 cursor-pointer font-medium"
                    title="复制邀请链接"
                  >
                    <LinkIcon className="w-3.5 h-3.5" /> 复制链接
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {inactiveCodes.length > 0 && (
          <details className="mt-3">
            <summary className="text-xs text-[var(--color-text-muted)] cursor-pointer hover:text-[var(--color-text)] select-none">
              查看历史邀请码 ({inactiveCodes.length})
            </summary>
            <div className="mt-2 space-y-1.5">
              {inactiveCodes.map((code) => (
                <div
                  key={code.code}
                  className="flex items-center justify-between px-3 py-2 bg-[var(--color-background)] rounded-lg border border-[var(--color-border)]/50 opacity-60 text-xs"
                >
                  <span className="font-mono text-[var(--color-text-muted)]">{code.code}</span>
                  <span className="text-[var(--color-text-muted)]">
                    {code.status === 'used' ? '已使用' : code.status === 'expired' ? '已过期' : '已撤销'}
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  )
}
