import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  deliverAdminPlatformOrder,
  postAdminPlatformProgress,
  rejectAdminPlatformOrder,
  startAdminPlatformFulfillment,
  type AdminOrderDetail,
} from '../../api/admin'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'

export interface AdminPlatformFulfillmentActionsProps {
  order: AdminOrderDetail
  onSuccess?: () => void
}

type ActionPanel = 'progress' | 'deliver' | 'reject' | null

/** 平台自营人工单且非 Faka/Xboard、非自动开通任务，才露出平台履约入口。 */
export function isPlatformManualFulfillmentOrder(order: AdminOrderDetail): boolean {
  const merchantId = order.merchantId !== undefined ? order.merchantId : (order.merchant?.id ?? null)
  if (merchantId != null) return false
  if (order.provisionTask) return false
  if (order.fakaBridgeTask != null) return false
  if (order.product?.fakaBridge) return false
  const mode = order.deliveryModeSnapshot ?? order.product?.deliveryMode ?? null
  return mode === 'manual_service'
}

export default function AdminPlatformFulfillmentActions({
  order,
  onSuccess,
}: AdminPlatformFulfillmentActionsProps) {
  const showToast = useAppStore((s) => s.showToast)
  const [panel, setPanel] = useState<ActionPanel>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [content, setContent] = useState('')
  const [structuredValues, setStructuredValues] = useState<Record<string, string>>({})
  const [attachmentFileId, setAttachmentFileId] = useState('')
  const [publicNote, setPublicNote] = useState('')
  const [rejectReason, setRejectReason] = useState('')

  const template = order.deliveryFieldsSnapshot ?? []
  const isStructured = template.length > 0
  const showStart = isPlatformManualFulfillmentOrder(order) && order.status === 'pending'
  const showProcessing = isPlatformManualFulfillmentOrder(order) && order.status === 'processing'

  useEffect(() => {
    setPanel(null)
    setNote('')
    setContent('')
    setStructuredValues({})
    setAttachmentFileId('')
    setPublicNote('')
    setRejectReason('')
    setBusy(false)
  }, [order.id, order.status])

  if (!showStart && !showProcessing) return null

  async function runAction(action: () => Promise<unknown>, successMessage: string) {
    setBusy(true)
    try {
      await action()
      showToast(successMessage)
      setPanel(null)
      onSuccess?.()
    } catch (err: unknown) {
      showToast(getApiErrorMessage(err, '操作失败'), 'error')
    } finally {
      setBusy(false)
    }
  }

  function parsedAttachmentFileId(): number | undefined {
    const trimmed = attachmentFileId.trim()
    if (!trimmed) return undefined
    const id = Number(trimmed)
    if (!Number.isSafeInteger(id) || id <= 0) return undefined
    return id
  }

  return (
    <div
      className="p-3.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] space-y-3"
      data-testid="admin-platform-fulfillment-actions"
    >
      <div className="text-xs font-bold text-[var(--color-text)]">平台履约操作</div>
      <div className="flex flex-wrap gap-2">
        {showStart && (
          <>
            <button
              type="button"
              className="btn-primary btn-sm text-xs px-2.5 py-1 cursor-pointer inline-flex items-center gap-1"
              disabled={busy}
              data-testid="admin-platform-start-fulfillment"
              onClick={() =>
                void runAction(() => startAdminPlatformFulfillment(order.id), '已开始履约')
              }
            >
              {busy && panel === null ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              开始履约
            </button>
            <button
              type="button"
              className="btn-secondary btn-sm text-xs px-2.5 py-1 cursor-pointer border-[var(--color-danger)] text-[var(--color-danger)]"
              disabled={busy}
              data-testid="admin-platform-reject"
              onClick={() => setPanel((current) => (current === 'reject' ? null : 'reject'))}
            >
              拒单
            </button>
          </>
        )}
        {showProcessing && (
          <>
            <button
              type="button"
              className="btn-secondary btn-sm text-xs px-2.5 py-1 cursor-pointer"
              disabled={busy}
              data-testid="admin-platform-progress"
              onClick={() => setPanel((current) => (current === 'progress' ? null : 'progress'))}
            >
              进度备注
            </button>
            <button
              type="button"
              className="btn-primary btn-sm text-xs px-2.5 py-1 cursor-pointer"
              disabled={busy}
              data-testid="admin-platform-deliver"
              onClick={() => setPanel((current) => (current === 'deliver' ? null : 'deliver'))}
            >
              交付
            </button>
          </>
        )}
      </div>

      {panel === 'progress' && (
        <form
          className="space-y-2"
          data-testid="admin-platform-progress-form"
          onSubmit={(e) => {
            e.preventDefault()
            const publicNoteValue = note.trim()
            if (!publicNoteValue) {
              showToast('请填写进度说明', 'error')
              return
            }
            void runAction(
              () => postAdminPlatformProgress(order.id, { publicNote: publicNoteValue }),
              '进度已更新',
            )
          }}
        >
          <label className="block text-xs font-semibold text-[var(--color-text)]">
            进度说明（买家可见） <span className="text-red-500">*</span>
          </label>
          <textarea
            className="input min-h-[88px] resize-y text-xs"
            maxLength={500}
            value={note}
            disabled={busy}
            placeholder="例如：素材已确认，开始制作，预计明天完成初稿"
            data-testid="admin-platform-progress-note"
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex items-center justify-between text-[10px] text-[var(--color-text-muted)]">
            <span>{note.length}/500</span>
            <button
              type="submit"
              className="btn-primary btn-sm text-xs px-3 py-1.5 cursor-pointer inline-flex items-center gap-1"
              disabled={busy}
              data-testid="admin-platform-progress-submit"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              发布进度
            </button>
          </div>
        </form>
      )}

      {panel === 'deliver' && (
        <form
          className="space-y-2"
          data-testid="admin-platform-deliver-form"
          onSubmit={(e) => {
            e.preventDefault()
            const fileId = parsedAttachmentFileId()
            if (attachmentFileId.trim() && fileId == null) {
              showToast('附件文件 ID 无效', 'error')
              return
            }
            if (isStructured) {
              const missing = template.find((field) => !(structuredValues[field.key] ?? '').trim())
              if (missing) {
                showToast(`交付字段「${missing.label}」不能为空`, 'error')
                return
              }
            } else if (!content.trim() && fileId == null) {
              showToast('发货内容与附件至少提供一项', 'error')
              return
            }
            void runAction(
              () =>
                deliverAdminPlatformOrder(order.id, {
                  ...(isStructured
                    ? {
                        structuredValues: Object.fromEntries(
                          template.map((field) => [field.key, (structuredValues[field.key] ?? '').trim()]),
                        ),
                      }
                    : content.trim()
                      ? { content: content.trim() }
                      : {}),
                  ...(fileId != null ? { attachmentFileId: fileId } : {}),
                  ...(publicNote.trim() ? { publicNote: publicNote.trim() } : {}),
                }),
              '已交付',
            )
          }}
        >
          {isStructured ? (
            <div className="space-y-2" data-testid="admin-platform-deliver-structured">
              {template.map((field) => (
                <div key={field.key}>
                  <label className="block text-xs font-semibold text-[var(--color-text)] mb-1">
                    {field.label} <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    className="input font-mono text-xs"
                    placeholder={field.placeholder ?? ''}
                    maxLength={2000}
                    value={structuredValues[field.key] ?? ''}
                    disabled={busy}
                    data-testid={`admin-platform-deliver-field-${field.key}`}
                    onChange={(e) =>
                      setStructuredValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                  />
                </div>
              ))}
            </div>
          ) : (
            <div>
              <label className="block text-xs font-semibold text-[var(--color-text)] mb-1">
                交付内容
              </label>
              <textarea
                className="input min-h-[88px] font-mono resize-y text-xs"
                value={content}
                disabled={busy}
                placeholder={'例如:\nABCD-1234-EFGH-5678'}
                data-testid="admin-platform-deliver-content"
                onChange={(e) => setContent(e.target.value)}
              />
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-[var(--color-text)] mb-1">
              附件文件 ID（可选）
            </label>
            <input
              type="number"
              min={1}
              className="input text-xs"
              value={attachmentFileId}
              disabled={busy}
              placeholder="已上传的平台交付文件 ID"
              data-testid="admin-platform-deliver-file-id"
              onChange={(e) => setAttachmentFileId(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[var(--color-text)] mb-1">
              验收说明（买家可见，可选）
            </label>
            <textarea
              className="input min-h-[64px] resize-y text-xs"
              maxLength={1000}
              value={publicNote}
              disabled={busy}
              placeholder="例如：已按需求完成交付，请查收并验收"
              data-testid="admin-platform-deliver-public-note"
              onChange={(e) => setPublicNote(e.target.value)}
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              className="btn-primary btn-sm text-xs px-3 py-1.5 cursor-pointer inline-flex items-center gap-1"
              disabled={busy}
              data-testid="admin-platform-deliver-submit"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              确认交付
            </button>
          </div>
        </form>
      )}

      {panel === 'reject' && (
        <form
          className="space-y-2"
          data-testid="admin-platform-reject-form"
          onSubmit={(e) => {
            e.preventDefault()
            const reason = rejectReason.trim()
            if (!reason) {
              showToast('请填写拒单原因', 'error')
              return
            }
            void runAction(
              () => rejectAdminPlatformOrder(order.id, { reason }),
              '已拒单，积分将退还用户',
            )
          }}
        >
          <label className="block text-xs font-semibold text-[var(--color-text)]">
            拒单原因 <span className="text-red-500">*</span>
          </label>
          <textarea
            className="input min-h-[80px] resize-y text-xs"
            maxLength={500}
            value={rejectReason}
            disabled={busy}
            placeholder="例如：暂无服务档期"
            data-testid="admin-platform-reject-reason"
            onChange={(e) => setRejectReason(e.target.value)}
          />
          <div className="flex items-center justify-between text-[10px] text-[var(--color-text-muted)]">
            <span>{rejectReason.trim().length}/500</span>
            <button
              type="submit"
              className="btn-secondary btn-sm text-xs px-3 py-1.5 cursor-pointer border-[var(--color-danger)] text-[var(--color-danger)] inline-flex items-center gap-1"
              disabled={busy}
              data-testid="admin-platform-reject-submit"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              确认拒单
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
