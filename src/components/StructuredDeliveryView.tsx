import { useState, useEffect, useRef } from 'react'
import { Check, Copy, Eye, EyeOff } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { copyToClipboard } from '../utils/clipboard'
import type { StructuredDeliveryContent } from '../types/merchant'

/**
 * P4b / Phase 3：结构化交付内容的字段化展示。
 * 每字段独立复制；sensitive 字段默认遮蔽，点击眼睛切换显示。
 * 提供一键全选复制；真实剪贴板 Promise 成功后展示 Check 图标与“已复制”反馈（2秒）。
 * 复制失败时提供选中文本提示。无有效可复制内容时不渲染复制按钮。
 */
export default function StructuredDeliveryView({ content }: { content: StructuredDeliveryContent }) {
  const showToast = useAppStore((s) => s.showToast)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [copiedAll, setCopiedAll] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  async function copyValue(key: string, label: string, value: string) {
    if (!value) return
    const success = await copyToClipboard(value)
    if (success) {
      if (timerRef.current) clearTimeout(timerRef.current)
      setCopiedKey(key)
      timerRef.current = setTimeout(() => {
        setCopiedKey(null)
      }, 2000)
      showToast(`「${label}」已复制`)
    } else {
      showToast('复制失败，请长按或手动选中文本复制', 'error')
    }
  }

  async function copyAll() {
    const lines = (content.fields || [])
      .map((field) => {
        const val = content.values?.[field.key] ?? ''
        return val ? `${field.label}：${val}` : null
      })
      .filter(Boolean)

    if (lines.length === 0) return

    const success = await copyToClipboard(lines.join('\n'))
    if (success) {
      if (timerRef.current) clearTimeout(timerRef.current)
      setCopiedAll(true)
      timerRef.current = setTimeout(() => {
        setCopiedAll(false)
      }, 2000)
      showToast('已复制全部凭据')
    } else {
      showToast('复制失败，请长按或手动选中文本复制', 'error')
    }
  }

  const fields = content.fields || []
  const hasCopyableValues = fields.some((f) => Boolean(content.values?.[f.key]?.trim()))

  return (
    <div className="space-y-2.5 text-left" data-testid="structured-delivery">
      {hasCopyableValues && fields.length > 1 && (
        <div className="flex items-center justify-between px-0.5 pb-1 border-b border-[var(--color-border)]">
          <span className="text-xs font-bold text-[var(--color-text-muted)]">结构化凭据</span>
          <button
            type="button"
            onClick={copyAll}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary-tint)] transition-colors cursor-pointer"
            data-testid="structured-copy-all"
          >
            {copiedAll ? (
              <>
                <Check className="w-3.5 h-3.5 text-[var(--color-points)]" />
                <span className="text-[var(--color-points)] font-bold">已复制全部</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>一键复制全部</span>
              </>
            )}
          </button>
        </div>
      )}

      <div className="space-y-2">
        {fields.map((field) => {
          const value = content.values?.[field.key] ?? ''
          const masked = field.sensitive && !revealed[field.key]
          const isCopied = copiedKey === field.key
          const hasValue = Boolean(value.trim())

          return (
            <div
              key={field.key}
              className="flex items-center gap-2 bg-[var(--color-background)] rounded-lg border border-[var(--color-border)] px-3 py-2 transition-colors"
              data-testid={`structured-field-${field.key}`}
            >
              <span className="text-xs font-bold text-[var(--color-text-muted)] shrink-0 min-w-[3.5rem]">
                {field.label}
              </span>
              <span className="font-mono text-sm break-all flex-1 text-[var(--color-text)] select-all">
                {masked ? '••••••••' : value || <span className="text-[var(--color-text-muted)] italic font-sans text-xs">未填写</span>}
              </span>
              {field.sensitive && hasValue && (
                <button
                  type="button"
                  onClick={() => setRevealed((prev) => ({ ...prev, [field.key]: !prev[field.key] }))}
                  className="icon-btn p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer shrink-0"
                  aria-label={masked ? `显示${field.label}` : `隐藏${field.label}`}
                  data-testid={`structured-reveal-${field.key}`}
                >
                  {masked ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </button>
              )}
              {hasValue && (
                <button
                  type="button"
                  onClick={() => copyValue(field.key, field.label, value)}
                  className="icon-btn p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-primary)] cursor-pointer shrink-0 inline-flex items-center gap-1"
                  aria-label={isCopied ? `已复制${field.label}` : `复制${field.label}`}
                  data-testid={`structured-copy-${field.key}`}
                >
                  {isCopied ? (
                    <>
                      <Check className="w-4 h-4 text-[var(--color-points)]" />
                      <span className="text-[11px] font-bold text-[var(--color-points)]">已复制</span>
                    </>
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
