import { FormEvent, useEffect, useState } from 'react'
import { AdminMailStatus, getAdminMailStatus, sendAdminMailTest } from '../../api/adminMail'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'

const OPS_HINT =
  'SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / SMTP_FROM 需在部署环境中配置，修改后重启后端。'

/**
 * SPEC-OPS-REGMAIL-001 §5.2「邮件投递」卡片。
 * MAIL-01：只渲染 status DTO 的 5 个白名单字段，且逐个显式取值——
 * 绝不把响应对象整体展开进 DOM，否则后端一旦多返回字段就成了泄漏面。
 * 收件地址只存在于本组件 state：不入 localStorage / sessionStorage / URL / 全局 store。
 */
export default function AdminMailPanel() {
  const showToast = useAppStore((s) => s.showToast)
  const [status, setStatus] = useState<AdminMailStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    void fetchStatus()
  }, [])

  async function fetchStatus() {
    setLoading(true)
    try {
      setStatus(await getAdminMailStatus())
      setLoadError(false)
    } catch (err) {
      setLoadError(true)
      showToast(getApiErrorMessage(err, '加载邮件投递状态失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault()
    // 单飞：发送期间禁用按钮并直接短路，保证一次提交恰好一次 POST。
    if (sending || !status?.deliveryReady) return
    const target = email.trim()
    if (!target) {
      showToast('请输入收件地址', 'error')
      return
    }
    setSending(true)
    try {
      const res = await sendAdminMailTest(target)
      showToast(res.message || '测试邮件已提交发送')
      // 成功后立即清空，避免收件地址长期驻留在界面上。
      setEmail('')
    } catch (err) {
      showToast(getApiErrorMessage(err, '测试邮件发送失败'), 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <section data-testid="admin-mail-panel">
      <h2 className="font-heading text-xl font-bold mb-2 text-[var(--color-text)]">邮件投递</h2>
      <p className="text-sm text-[var(--color-text-muted)] mb-4 break-words">{OPS_HINT}</p>

      {loading ? (
        <div className="text-sm text-[var(--color-text-muted)] py-4">加载中...</div>
      ) : loadError || !status ? (
        <div className="text-sm text-[var(--color-danger)] py-2" data-testid="admin-mail-error">
          邮件投递状态加载失败
          <button type="button" className="btn-secondary btn-sm ml-3 px-3" onClick={() => void fetchStatus()}>
            重试
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-3 space-y-3">
          <div data-testid="admin-mail-mode" className="text-sm font-semibold text-[var(--color-text)] break-words">
            {status.mode === 'console'
              ? '未配置真实 SMTP，当前仅记录到服务端日志'
              : status.deliveryReady
                ? '真实 SMTP 已配置'
                : '真实 SMTP 配置不完整，暂不可投递'}
          </div>

          <dl className="text-sm space-y-1">
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-[var(--color-text-muted)]">发件地址：</dt>
              <dd data-testid="admin-mail-from" className="text-[var(--color-text)] min-w-0 break-all">
                {/* C3：就绪但未显式配置 SMTP_FROM 是合法组合，不得表述为未就绪 */}
                {status.from ?? (status.deliveryReady ? '发件地址未公开展示；配置 SMTP_FROM 可显示' : '未配置')}
              </dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-[var(--color-text-muted)]">认证配置：</dt>
              <dd data-testid="admin-mail-auth" className="text-[var(--color-text)]">
                {status.authConfigured ? '已配置' : '未配置'}
              </dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-[var(--color-text-muted)]">配置来源：</dt>
              <dd data-testid="admin-mail-configured-via" className="text-[var(--color-text)]">
                {status.configuredVia === 'environment' ? '部署环境变量' : status.configuredVia}
              </dd>
            </div>
          </dl>

          <form onSubmit={handleSend} className="flex flex-wrap items-center gap-2 pt-1">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={!status.deliveryReady || sending}
              placeholder="收件地址"
              autoComplete="off"
              data-testid="admin-mail-test-email"
              className="input py-1.5 px-2 flex-grow min-w-0 sm:max-w-xs"
            />
            <button
              type="submit"
              /* P.16：启用与否只看 deliveryReady，与 authConfigured 无关 */
              disabled={!status.deliveryReady || sending}
              data-testid="admin-mail-test-send"
              className="btn-primary btn-sm px-4 whitespace-nowrap"
            >
              {sending ? '发送中...' : '发送测试邮件'}
            </button>
          </form>
          {!status.deliveryReady && (
            <div data-testid="admin-mail-disabled-reason" className="text-xs text-[var(--color-text-muted)] break-words">
              {status.mode === 'console'
                ? '当前为降级模式（console mailer），无法发送测试邮件。'
                : 'SMTP 配置不完整，无法发送测试邮件。'}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
