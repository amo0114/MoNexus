import { useState } from 'react'
import { Download, Loader2, FileArchive } from 'lucide-react'
import { issueOrderFileDownloadUrl } from '../api/orders'
import { getApiErrorCode, getApiErrorMessage } from '../api/error'
import { useAppStore } from '../stores/appStore'
import { formatFileSize } from '../utils/formatFileSize'

interface Props {
  orderId: number
  fileName: string
  size?: number | null
}

/**
 * P5：买家侧文件交付卡片。每次点击都向发放端点重新请求短时签名 URL——
 * 链接不落地组件状态/DOM,拿到即跳转下载;争议/退款/窗口过期时服务端
 * 会以具体文案拒绝。
 */
export default function FileDeliveryCard({ orderId, fileName, size }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [downloading, setDownloading] = useState(false)

  async function handleDownload() {
    setDownloading(true)
    try {
      const grant = await issueOrderFileDownloadUrl(orderId)
      // 直接导航触发下载(签名头强制 attachment,不会离开页面)。
      window.location.assign(grant.url)
    } catch (err: any) {
      // P6a：订阅过期的发放拒绝给出续费指引；其余沿用服务端文案。
      if (getApiErrorCode(err) === 'FILE_SUBSCRIPTION_EXPIRED') {
        showToast('订阅已过期，续费后可恢复下载', 'error')
      } else {
        showToast(getApiErrorMessage(err, '下载链接获取失败'), 'error')
      }
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div
      className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-3"
      data-testid="file-delivery-card"
    >
      <div className="flex items-center gap-3 min-w-0">
        <FileArchive className="w-8 h-8 shrink-0 text-[var(--color-primary)]" />
        <div className="min-w-0">
          <div className="font-bold text-sm text-[var(--color-text)] break-all">{fileName}</div>
          <div className="text-xs text-[var(--color-text-muted)]">
            {size != null ? `约 ${formatFileSize(size)} · ` : ''}短时签名下载，链接数分钟内有效
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={handleDownload}
        disabled={downloading}
        className="btn-primary px-4 py-2 text-sm shrink-0 flex items-center gap-1.5"
        data-testid="file-delivery-download"
      >
        {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
        下载文件
      </button>
    </div>
  )
}
