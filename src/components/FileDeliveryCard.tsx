import { useState } from 'react'
import { Download, Loader2, FileArchive, AlertCircle, Ban } from 'lucide-react'
import { issueOrderFileDownloadUrl } from '../api/orders'
import { getApiErrorCode, getApiErrorMessage } from '../api/error'
import { useAppStore } from '../stores/appStore'
import { formatFileSize } from '../utils/formatFileSize'

interface Props {
  orderId: number
  fileName: string
  size?: number | null
  orderStatus?: string
  disabled?: boolean
}

/**
 * P5 / Phase 3：买家侧文件交付卡片。
 * 每次点击都向发放端点重新请求短时签名 URL——链接不落地组件状态/DOM，拿到即跳转下载。
 * 当订单处于争议 (disputed) 或已退款 (refunded) 状态时，下载按钮置灰禁用，并给出清晰文案说明。
 * 买家 DTO 无 SHA-256 字段，严格不展示虚构哈希。
 */
export default function FileDeliveryCard({
  orderId,
  fileName,
  size,
  orderStatus,
  disabled = false,
}: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [downloading, setDownloading] = useState(false)

  const isDisputed = orderStatus === 'disputed'
  const isRefunded = orderStatus === 'refunded'
  const isDownloadDisabled = disabled || isDisputed || isRefunded

  async function handleDownload() {
    if (isDownloadDisabled || downloading) return
    setDownloading(true)
    try {
      const grant = await issueOrderFileDownloadUrl(orderId)
      // 直接导航触发下载(签名头强制 attachment,不会离开页面)。
      window.location.assign(grant.url)
    } catch (err: any) {
      // P6a：订阅过期的发放拒绝给出续费指引；其余沿用服务端文案。
      if (getApiErrorCode(err) === 'FILE_SUBSCRIPTION_EXPIRED') {
        showToast('订阅已过期，续费后可在新订单中下载', 'error')
      } else {
        showToast(getApiErrorMessage(err, '下载链接获取失败'), 'error')
      }
    } finally {
      setDownloading(false)
    }
  }

  let actionLabel = '下载文件'
  if (downloading) {
    actionLabel = '获取链接中…'
  } else if (isDisputed) {
    actionLabel = '下载已暂停'
  } else if (isRefunded) {
    actionLabel = '下载已关闭'
  }

  return (
    <div
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3.5 space-y-2.5"
      data-testid="file-delivery-card"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center shrink-0">
            <FileArchive className="w-5 h-5 text-[var(--color-primary)]" />
          </div>
          <div className="min-w-0">
            <div className="font-bold text-sm text-[var(--color-text)] break-all">{fileName}</div>
            <div className="text-xs text-[var(--color-text-muted)]">
              {size != null ? `文件大小约 ${formatFileSize(size)} · ` : ''}
              短时签名下载
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={handleDownload}
          disabled={downloading || isDownloadDisabled}
          className={`btn-sm px-3.5 py-2 text-xs font-semibold shrink-0 flex items-center gap-1.5 rounded-lg transition-colors cursor-pointer ${
            isDownloadDisabled
              ? 'btn-secondary opacity-60 cursor-not-allowed'
              : 'btn-primary'
          }`}
          data-testid="file-delivery-download"
        >
          {downloading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : isDisputed ? (
            <AlertCircle className="w-3.5 h-3.5 text-[var(--color-warning)]" />
          ) : isRefunded ? (
            <Ban className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
          ) : (
            <Download className="w-3.5 h-3.5" />
          )}
          {actionLabel}
        </button>
      </div>

      {isDisputed && (
        <div
          className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded bg-[var(--color-danger-bg)] border border-[var(--color-danger-border)] text-[var(--color-danger-text)] font-medium"
          data-testid="file-delivery-disputed-notice"
        >
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>争议处理中，文件下载已暂停。待争议解决后恢复。</span>
        </div>
      )}

      {isRefunded && (
        <div
          className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded bg-[var(--color-warning-bg)] border border-[var(--color-warning-border)] text-[var(--color-warning-text)] font-medium"
          data-testid="file-delivery-refunded-notice"
        >
          <Ban className="w-3.5 h-3.5 shrink-0" />
          <span>订单已全额退款，文件下载授权已关闭。</span>
        </div>
      )}
    </div>
  )
}
