import { useEffect, useState } from 'react'
import { Loader2, ShieldCheck, Copy, Check, AlertTriangle } from 'lucide-react'
import {
  getMyWebhookConfig,
  saveMyWebhookConfig,
  deleteMyWebhookConfig,
  testMyWebhookConfig,
} from '../../api/merchant'
import type { MerchantWebhookConfig } from '../../types/merchant'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/Dialog'
import ConfirmDialog from '../ui/ConfirmDialog'

/**
 * P7b：商家自动开通 webhook 配置（商家资料页内嵌）。
 *
 * - secret 明文只在保存响应里返回一次，用不可复现的一次性弹窗展示（硬验收 ⑤）。
 * - 撤销会强制关闭该商家全部规格的自动开通开关，故成功后提示受影响规格数并
 *   触发父级刷新（`onChanged`）。
 * - 测试事件走与真实外呼同一安全路径，只回 HTTP 状态与脱敏诊断码。
 */
export default function MerchantWebhookConfigSection({ onChanged }: { onChanged?: () => void }) {
  const showToast = useAppStore((s) => s.showToast)
  const [loading, setLoading] = useState(true)
  const [config, setConfig] = useState<MerchantWebhookConfig | null>(null)
  const [url, setUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [revoking, setRevoking] = useState(false)
  // 一次性明文密钥弹窗——关闭后无法再取。
  const [plaintext, setPlaintext] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const data = await getMyWebhookConfig()
      setConfig(data)
      setUrl(data?.url ?? '')
    } catch (err) {
      showToast(getApiErrorMessage(err, '加载 webhook 配置失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleSave() {
    const trimmed = url.trim()
    if (!trimmed) {
      showToast('请填写 webhook 地址', 'error')
      return
    }
    setSaving(true)
    try {
      const result = await saveMyWebhookConfig(trimmed)
      setConfig({ url: result.url, secretLast4: result.secretLast4, createdAt: result.createdAt })
      setUrl(result.url)
      setCopied(false)
      setPlaintext(result.secret)
    } catch (err) {
      showToast(getApiErrorMessage(err, '保存失败'), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    try {
      const result = await testMyWebhookConfig()
      if (result.ok) {
        showToast(`测试成功（HTTP ${result.httpStatus}）`, 'success')
      } else {
        const detail = result.httpStatus != null ? `HTTP ${result.httpStatus}` : result.error ?? '连接失败'
        showToast(`测试失败：${detail}`, 'error')
      }
    } catch (err) {
      showToast(getApiErrorMessage(err, '测试失败'), 'error')
    } finally {
      setTesting(false)
    }
  }

  async function handleRevoke() {
    setRevoking(true)
    try {
      const result = await deleteMyWebhookConfig()
      setConfig(null)
      setUrl('')
      setRevokeOpen(false)
      showToast(
        result.disabledOffers > 0
          ? `已撤销，同时关闭了 ${result.disabledOffers} 个规格的自动开通`
          : '已撤销 webhook 配置',
        'success',
      )
      onChanged?.()
    } catch (err) {
      showToast(getApiErrorMessage(err, '撤销失败'), 'error')
    } finally {
      setRevoking(false)
    }
  }

  async function copyPlaintext() {
    if (!plaintext) return
    try {
      await navigator.clipboard.writeText(plaintext)
      setCopied(true)
    } catch {
      showToast('复制失败，请手动选择', 'error')
    }
  }

  return (
    <div className="mt-10 border-t border-[var(--color-border)] pt-8" data-testid="webhook-config-section">
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck className="w-5 h-5 text-[var(--color-primary)]" />
        <h3 className="font-heading text-lg font-bold text-[var(--color-text)]">自动开通 Webhook</h3>
      </div>
      <p className="text-sm text-[var(--color-text-muted)] mb-5 leading-relaxed">
        配置后，勾选「自动开通」的人工服务规格在买家下单时会把订单与买家填写的表单信息
        推送到此地址，由你的服务返回开通内容自动交付。仅支持 HTTPS，请求带签名（校验方式见接入文档）。
        推送失败会按退避重试，最终失败自动转人工并邮件通知你。
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin" /> 加载中…
        </div>
      ) : (
        <>
          <div>
            <label className="block text-sm font-medium mb-1.5 text-[var(--color-text)]">Webhook 地址</label>
            <input
              type="url"
              className="input"
              placeholder="https://your-domain.com/monexus/provision"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              data-testid="webhook-url-input"
            />
          </div>

          {config && (
            <div className="mt-3 text-sm text-[var(--color-text-muted)] flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>
                密钥：<code className="font-mono text-[var(--color-text)]">****{config.secretLast4}</code>
              </span>
              <span>配置于 {new Date(config.createdAt).toLocaleString()}</span>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" className="btn-primary" onClick={handleSave} disabled={saving} data-testid="webhook-save-btn">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : config ? '更新并重置密钥' : '保存并启用'}
            </button>
            {config && (
              <>
                <button type="button" className="btn-secondary" onClick={handleTest} disabled={testing} data-testid="webhook-test-btn">
                  {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : '发送测试事件'}
                </button>
                <button
                  type="button"
                  className="btn-secondary border-[var(--color-danger)] text-[var(--color-danger)]"
                  onClick={() => setRevokeOpen(true)}
                  data-testid="webhook-revoke-btn"
                >
                  撤销
                </button>
              </>
            )}
          </div>
          {config && (
            <p className="mt-2 text-xs text-[var(--color-text-muted)]">
              更新地址或重置密钥会生成新密钥并使旧密钥立即失效；尚未推送的旧任务安全转人工。
            </p>
          )}
        </>
      )}

      {/* 一次性明文密钥——关闭后不可再取。 */}
      <Dialog open={plaintext != null} onOpenChange={(o) => { if (!o) setPlaintext(null) }}>
        <DialogContent className="max-w-md" data-testid="webhook-secret-modal">
          <DialogTitle>请立即保存签名密钥</DialogTitle>
          <DialogDescription>
            这是此密钥的唯一一次明文展示，用于校验推送请求的签名。关闭后将无法再次查看，
            如遗失需重置密钥。
          </DialogDescription>
          <div className="mt-4 flex items-center gap-2">
            <code className="flex-1 min-w-0 break-all font-mono text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-[var(--color-text)]">
              {plaintext}
            </code>
            <button type="button" className="btn-secondary shrink-0" onClick={copyPlaintext} aria-label="复制密钥">
              {copied ? <Check className="w-4 h-4 text-[var(--color-success)]" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
          <div className="mt-3 flex items-start gap-2 text-xs text-[var(--color-text-muted)]">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[var(--color-warning)]" />
            <span>妥善保存于你的服务端配置。任何人拿到该密钥即可伪造推送请求。</span>
          </div>
          <div className="mt-5 flex justify-end">
            <button type="button" className="btn-primary" onClick={() => setPlaintext(null)}>
              我已保存
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        title="撤销自动开通 Webhook？"
        description="撤销后将立即停用，并关闭你名下所有规格的自动开通开关（这些规格将恢复为人工交付）。此操作不可撤销。"
        confirmLabel="撤销"
        loading={revoking}
        onConfirm={handleRevoke}
      />
    </div>
  )
}
