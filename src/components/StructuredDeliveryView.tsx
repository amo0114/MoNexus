import { useState } from 'react'
import { Copy, Eye, EyeOff } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import type { StructuredDeliveryContent } from '../types/merchant'

/**
 * P4b：结构化交付内容的字段化展示。每字段独立复制;sensitive 字段默认遮蔽,
 * 点击眼睛显示——遮蔽是 UI 行为,数据本来就只到订单详情接口。
 * 成功弹窗与订单详情共用。
 */
export default function StructuredDeliveryView({ content }: { content: StructuredDeliveryContent }) {
  const showToast = useAppStore((s) => s.showToast)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})

  function copyValue(label: string, value: string) {
    navigator.clipboard.writeText(value).catch(() => {})
    showToast(`「${label}」已复制`)
  }

  return (
    <div className="space-y-2 text-left" data-testid="structured-delivery">
      {content.fields.map(field => {
        const value = content.values[field.key] ?? ''
        const masked = field.sensitive && !revealed[field.key]
        return (
          <div
            key={field.key}
            className="flex items-center gap-2 bg-[var(--color-surface)] rounded border border-[var(--color-border)] px-3 py-2"
            data-testid={`structured-field-${field.key}`}
          >
            <span className="text-xs font-bold text-[var(--color-text-muted)] shrink-0 min-w-[3.5rem]">{field.label}</span>
            <span className="font-mono text-sm break-all flex-1 text-[var(--color-text)] select-all">
              {masked ? '••••••••' : value}
            </span>
            {field.sensitive && (
              <button
                type="button"
                onClick={() => setRevealed(prev => ({ ...prev, [field.key]: !prev[field.key] }))}
                className="icon-btn p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer shrink-0"
                aria-label={masked ? `显示${field.label}` : `隐藏${field.label}`}
                data-testid={`structured-reveal-${field.key}`}
              >
                {masked ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
              </button>
            )}
            <button
              type="button"
              onClick={() => copyValue(field.label, value)}
              className="icon-btn p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-primary)] cursor-pointer shrink-0"
              aria-label={`复制${field.label}`}
              data-testid={`structured-copy-${field.key}`}
            >
              <Copy className="w-4 h-4" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
