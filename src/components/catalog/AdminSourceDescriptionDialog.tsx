import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { AdminProductListItem } from '../../api/admin'
import {
  applyAdminSourceDescription,
  previewAdminSourceDescription,
  type SourceDescriptionField,
  type SourceDescriptionPreview,
} from '../../api/sourceDescription'
import { getApiErrorCode, getApiErrorMessage } from '../../api/error'
import { useIsMobileViewport } from '../../hooks/useMediaQuery'
import { useAppStore } from '../../stores/appStore'
import { createLatestRequestGuard } from '../../utils/latestRequest'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import RichTextHtml from './RichTextHtml'

interface Props {
  product: AdminProductListItem | null
  onClose: () => void
  onApplied: () => void | Promise<void>
}

type PreviewPane = 'local' | 'source'

function selectedFields(
  replaceDescription: boolean,
  replaceRichDescription: boolean,
): SourceDescriptionField[] {
  const fields: SourceDescriptionField[] = []
  if (replaceDescription) fields.push('description')
  if (replaceRichDescription) fields.push('richDescription')
  return fields
}

function applyButtonLabel(fields: SourceDescriptionField[]): string {
  if (fields.length === 0) return '替换已选内容'
  if (fields.length === 2) return '替换简介和正文'
  return fields[0] === 'description' ? '替换简介' : '替换正文'
}

function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim() === ''
}

function PlainBlock({ value }: { value: string | null | undefined }) {
  if (isBlank(value)) {
    return <p className="text-sm text-[var(--color-text-muted)]">（空）</p>
  }
  return (
    <p className="whitespace-pre-wrap break-words text-sm text-[var(--color-text)]">{value}</p>
  )
}

function RichBlock({ html }: { html: string | null | undefined }) {
  if (isBlank(html)) {
    return <p className="text-sm text-[var(--color-text-muted)]">（空）</p>
  }
  return <RichTextHtml html={html} className="text-sm leading-relaxed text-[var(--color-text)]" />
}

function ContentPane({
  title,
  description,
  richDescription,
  testId,
}: {
  title: string
  description: string | null | undefined
  richDescription: string | null | undefined
  testId: string
}) {
  return (
    <section
      data-testid={testId}
      className="min-h-0 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3"
    >
      <h3 className="mb-3 text-sm font-bold text-[var(--color-text)]">{title}</h3>
      <h4 className="mb-1 text-xs font-semibold text-[var(--color-text-muted)]">简介</h4>
      <PlainBlock value={description} />
      <h4 className="mb-1 mt-3 text-xs font-semibold text-[var(--color-text-muted)]">正文</h4>
      <RichBlock html={richDescription} />
    </section>
  )
}

function statusCopy(changedSinceAccepted: boolean | null): { text: string; testId: string } {
  if (changedSinceAccepted === null) {
    return {
      text: '尚未采纳过上游介绍，这是首次对比。请勾选要替换的字段后再替换。',
      testId: 'admin-source-description-first-time',
    }
  }
  if (changedSinceAccepted) {
    return {
      text: '上游介绍已更新。本地内容可能与上游不同。',
      testId: 'admin-source-description-changed',
    }
  }
  return {
    text: '已处理过这次上游介绍。本地内容可能与上游不同。',
    testId: 'admin-source-description-accepted',
  }
}

export default function AdminSourceDescriptionDialog({ product, onClose, onApplied }: Props) {
  const showToast = useAppStore((state) => state.showToast)
  const isMobile = useIsMobileViewport()
  const [preview, setPreview] = useState<SourceDescriptionPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [replaceDescription, setReplaceDescription] = useState(false)
  const [replaceRichDescription, setReplaceRichDescription] = useState(false)
  const [pane, setPane] = useState<PreviewPane>('local')
  const applyingRef = useRef(false)
  const previewGuard = useRef(createLatestRequestGuard()).current
  const productId = product?.id ?? null

  async function loadPreview() {
    if (productId == null) return
    const canCommit = previewGuard.begin()
    setLoading(true)
    setError(null)
    try {
      const result = await previewAdminSourceDescription(productId)
      if (!canCommit()) return
      setPreview(result)
    } catch (err) {
      if (!canCommit()) return
      setPreview(null)
      const message = getApiErrorMessage(err, '预览失败')
      setError(message)
      showToast(message, 'error')
    } finally {
      if (canCommit()) setLoading(false)
    }
  }

  useEffect(() => {
    if (productId == null) {
      previewGuard.invalidate()
      setPreview(null)
      setLoading(false)
      setApplying(false)
      applyingRef.current = false
      setError(null)
      setReplaceDescription(false)
      setReplaceRichDescription(false)
      setPane('local')
      return
    }
    setReplaceDescription(false)
    setReplaceRichDescription(false)
    setPane('local')
    setPreview(null)
    void loadPreview()
    return () => {
      previewGuard.invalidate()
    }
  }, [productId, previewGuard, showToast])

  async function handleApply() {
    if (!product || !preview || applyingRef.current) return
    const fields = selectedFields(replaceDescription, replaceRichDescription)
    if (fields.length === 0) return
    applyingRef.current = true
    setApplying(true)
    try {
      await applyAdminSourceDescription(product.id, {
        sourceHash: preview.sourceHash,
        descriptionHash: preview.descriptionHash,
        expectedContentVersion: preview.local.contentVersion,
        fields,
      })
      showToast('已替换已选内容')
      await onApplied()
      onClose()
    } catch (err) {
      const code = getApiErrorCode(err)
      if (code === 'FAKA_SOURCE_CHANGED') {
        showToast('源已变化，请重新预览', 'error')
        await loadPreview()
      } else if (code === 'PRODUCT_CONTENT_CHANGED') {
        showToast('本地内容已更新，请重新预览', 'error')
        await loadPreview()
      } else {
        showToast(getApiErrorMessage(err, '替换失败'), 'error')
      }
    } finally {
      applyingRef.current = false
      setApplying(false)
    }
  }

  const fields = selectedFields(replaceDescription, replaceRichDescription)
  const canApply = fields.length > 0 && preview != null && !loading && !applying
  const fakaOffer = product?.offers?.find((offer) => offer.externalIntegration || offer.externalSku)
  const sku = product?.fakaCapacity?.sku ?? fakaOffer?.externalSku ?? null
  const planId = product?.fakaCapacity?.planId ?? null

  return (
    <Dialog
      open={product != null}
      onOpenChange={(open) => {
        if (!open && !applying) onClose()
      }}
    >
      <DialogContent
        className="max-h-[90dvh] max-w-4xl overflow-y-auto"
        data-testid="admin-source-description-dialog"
      >
        <DialogTitle>检查上游介绍</DialogTitle>
        <DialogDescription>
          对比「{product?.name ?? '商品'}」的当前介绍与上游介绍。勾选后仅覆盖选中字段，不会改动容量或
          SKU。
        </DialogDescription>

        {loading && !preview ? (
          <p
            className="mt-5 flex items-center gap-2 text-sm text-[var(--color-text-muted)]"
            data-testid="admin-source-description-loading"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取上游介绍…
          </p>
        ) : error && !preview ? (
          <div className="mt-5 space-y-3" data-testid="admin-source-description-error">
            <p className="text-sm text-[var(--color-text-muted)]">{error}</p>
            <button
              type="button"
              className="btn-secondary min-h-11 px-4"
              data-testid="admin-source-description-retry"
              onClick={() => {
                void loadPreview()
              }}
            >
              重新预览
            </button>
          </div>
        ) : preview ? (
          <div className="mt-4 space-y-4 text-sm">
            {(() => {
              const status = statusCopy(preview.changedSinceAccepted)
              return (
                <p
                  className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-[var(--color-text)]"
                  data-testid={status.testId}
                >
                  {status.text}
                </p>
              )
            })()}

            {isMobile ? (
              <div className="space-y-3">
                <div role="tablist" aria-label="介绍对比" className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={pane === 'local'}
                    className={`min-h-11 rounded-lg border px-3 text-sm font-semibold ${
                      pane === 'local'
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary-tint)] text-[var(--color-primary)]'
                        : 'border-[var(--color-border)] text-[var(--color-text)]'
                    }`}
                    data-testid="admin-source-description-tab-local"
                    onClick={() => setPane('local')}
                  >
                    当前内容
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={pane === 'source'}
                    className={`min-h-11 rounded-lg border px-3 text-sm font-semibold ${
                      pane === 'source'
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary-tint)] text-[var(--color-primary)]'
                        : 'border-[var(--color-border)] text-[var(--color-text)]'
                    }`}
                    data-testid="admin-source-description-tab-source"
                    onClick={() => setPane('source')}
                  >
                    上游内容
                  </button>
                </div>
                {pane === 'local' ? (
                  <ContentPane
                    title="当前内容"
                    description={preview.local.description}
                    richDescription={preview.local.richDescription}
                    testId="admin-source-description-current"
                  />
                ) : (
                  <ContentPane
                    title="上游内容"
                    description={preview.source.description}
                    richDescription={preview.source.richDescription}
                    testId="admin-source-description-source"
                  />
                )}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <ContentPane
                  title="当前内容"
                  description={preview.local.description}
                  richDescription={preview.local.richDescription}
                  testId="admin-source-description-current"
                />
                <ContentPane
                  title="上游内容"
                  description={preview.source.description}
                  richDescription={preview.source.richDescription}
                  testId="admin-source-description-source"
                />
              </div>
            )}

            <div className="flex flex-col gap-1">
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={replaceDescription}
                  disabled={applying}
                  onChange={(event) => setReplaceDescription(event.target.checked)}
                  data-testid="admin-source-description-field-description"
                />
                替换简介
              </label>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={replaceRichDescription}
                  disabled={applying}
                  onChange={(event) => setReplaceRichDescription(event.target.checked)}
                  data-testid="admin-source-description-field-richDescription"
                />
                替换正文
              </label>
            </div>

            <details
              className="rounded-lg border border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)]"
              data-testid="admin-source-description-tech"
            >
              <summary className="cursor-pointer font-semibold text-[var(--color-text)]">
                技术信息
              </summary>
              <dl className="mt-2 space-y-1 font-mono break-all">
                {sku ? (
                  <div>
                    <dt className="inline text-[var(--color-text-muted)]">SKU：</dt>
                    <dd className="inline">{sku}</dd>
                  </div>
                ) : null}
                {planId != null ? (
                  <div>
                    <dt className="inline text-[var(--color-text-muted)]">planId：</dt>
                    <dd className="inline">{planId}</dd>
                  </div>
                ) : null}
                <div>
                  <dt className="inline text-[var(--color-text-muted)]">sourceHash：</dt>
                  <dd className="inline">{preview.sourceHash}</dd>
                </div>
                <div>
                  <dt className="inline text-[var(--color-text-muted)]">descriptionHash：</dt>
                  <dd className="inline">{preview.descriptionHash}</dd>
                </div>
              </dl>
            </details>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-secondary min-h-11 px-4"
                onClick={onClose}
                disabled={applying}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary min-h-11 px-4"
                data-testid="admin-source-description-apply"
                disabled={!canApply}
                onClick={() => {
                  void handleApply()
                }}
              >
                {applying ? '替换中…' : applyButtonLabel(fields)}
              </button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
