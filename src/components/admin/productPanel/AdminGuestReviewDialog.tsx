import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useEffect, useState } from 'react'
import { ExternalLink, Loader2, X } from 'lucide-react'
import { DialogOverlay } from '../../ui/Dialog'
import {
  applyAdminGuestEligibility,
  getAdminGuestEligibility,
  type AdminProductListItem,
  type GuestEligibilityAction,
  type GuestEligibilityView,
} from '../../../api/admin'
import { getApiErrorMessage } from '../../../api/error'
import { useAppStore } from '../../../stores/appStore'
import { ADMIN_GUEST_REVIEW_LABELS } from '../../catalog/guestReview'

interface Props {
  product: AdminProductListItem | null
  onClose: () => void
  /** Called after any server-side change or conflict so the list reflects current state. */
  onChanged: () => void
}

const ACTION_LABELS: Record<GuestEligibilityAction, string> = {
  approve: '批准公开',
  reject: '拒绝',
  revoke: '撤销公开资格',
}

/**
 * SPEC-CATALOG-VIS-001 §4.5: the versions the admin reviewed are read when the
 * dialog opens and sent back as CAS expectations, so approving content that
 * changed meanwhile fails with 409 instead of approving the new version unseen.
 */
export default function AdminGuestReviewDialog({ product, onClose, onChanged }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [view, setView] = useState<GuestEligibilityView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<GuestEligibilityAction | null>(null)
  const productId = product?.id ?? null

  async function load(id: number) {
    setView(null)
    setLoadError(null)
    try {
      setView(await getAdminGuestEligibility(id))
    } catch (err) {
      setLoadError(getApiErrorMessage(err, '读取公开审核状态失败'))
    }
  }

  useEffect(() => {
    setConflict(null)
    setSubmitting(null)
    if (productId != null) void load(productId)
  }, [productId])

  async function submit(action: GuestEligibilityAction) {
    if (!product || !view || submitting) return
    setSubmitting(action)
    setConflict(null)
    try {
      await applyAdminGuestEligibility(product.id, {
        action,
        expectedPublicContentRevision: view.publicContentRevision,
        expectedEligibilityVersion: view.version,
        ...(action === 'reject' ? { reasonCode: 'rejected' as const } : {}),
      })
      showToast(`“${product.name}”已${ACTION_LABELS[action]}`)
      onChanged()
      onClose()
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 409) {
        // Reload so the admin re-reviews the current version before acting again.
        setConflict(getApiErrorMessage(err, '商品状态已变化，请重新查看后再操作'))
        await load(product.id)
        onChanged()
      } else {
        showToast(getApiErrorMessage(err, '操作失败'), 'error')
      }
    } finally {
      setSubmitting(null)
    }
  }

  const state = product?.guestReview?.state
  const approvedCurrent =
    view?.decision === 'approved' && view.reviewedRevision === view.publicContentRevision
  // §4.4: switching to public bumps the content revision, so approving a
  // members_only product would be invalidated by the very change that publishes it.
  const membersOnly = state === 'members_only'
  const gateHint =
    membersOnly
      ? '商品当前为仅登录可见，暂不能审核。先将商品改为游客可浏览（平台商品在编辑页修改，商家商品由商家修改），保存后会进入待公开审核，再在此批准。'
      : state === 'category_restricted'
        ? '商品所在分类仅登录可见；批准后仍需分类放开才会展示。'
        : null

  return (
    <DialogPrimitive.Root
      open={product != null}
      onOpenChange={(open) => {
        if (!open && !submitting) onClose()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          data-testid="admin-guest-review-dialog"
          className="modal fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-2xl p-6 focus:outline-none max-md:sheet-enter max-md:inset-x-0 max-md:bottom-0 max-md:top-auto max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-b-none max-md:rounded-t-2xl max-md:max-h-[92dvh] max-md:pb-[calc(1.5rem+var(--safe-bottom))]"
        >
          <div className="flex items-center justify-between pb-3 border-b border-[var(--color-border)]">
            <DialogPrimitive.Title className="font-heading text-lg font-bold text-[var(--color-text)]">
              游客公开审核
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                aria-label="关闭"
                disabled={submitting != null}
                className="p-1 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-background)] transition-colors cursor-pointer disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </DialogPrimitive.Close>
          </div>

          <div className="mt-4 space-y-3 text-xs">
            <DialogPrimitive.Description className="text-[var(--color-text-muted)]">
              批准后，游客无需登录即可浏览「
              <strong className="text-[var(--color-text)]">{product?.name}</strong>
              」的名称、图片、介绍和套餐。商品内容再次变更会自动退回待审核。
            </DialogPrimitive.Description>

            <a
              href={product ? `/product/${product.id}` : undefined}
              target="_blank"
              rel="noreferrer"
              data-testid="admin-guest-review-preview"
              className="inline-flex items-center gap-1 text-[var(--color-primary)] font-semibold"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              在新窗口查看商品页内容
            </a>

            {state && (
              <div data-testid="admin-guest-review-state">
                当前状态：<span className="font-bold text-[var(--color-text)]">{ADMIN_GUEST_REVIEW_LABELS[state]}</span>
                {view && <span className="text-[var(--color-text-muted)]">（内容版本 v{view.publicContentRevision}）</span>}
              </div>
            )}
            {gateHint && <p className="text-[var(--color-text-muted)]">{gateHint}</p>}
            {conflict && (
              <p role="alert" data-testid="admin-guest-review-conflict" className="text-red-500 font-medium">
                {conflict}
              </p>
            )}
            {loadError && (
              <p role="alert" className="text-red-500 font-medium">{loadError}</p>
            )}
          </div>

          <div className="flex items-center justify-end gap-3 pt-5">
            {membersOnly && !approvedCurrent ? null : !view ? (
              !loadError && <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)]" />
            ) : approvedCurrent ? (
              <button
                type="button"
                data-testid="admin-guest-review-revoke"
                disabled={submitting != null}
                onClick={() => void submit('revoke')}
                className="btn bg-red-600 hover:bg-red-700 text-white font-semibold text-xs px-4 py-2 rounded-lg cursor-pointer inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {submitting === 'revoke' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {ACTION_LABELS.revoke}
              </button>
            ) : (
              <>
                {view.decision === 'pending' && (
                  <button
                    type="button"
                    data-testid="admin-guest-review-reject"
                    disabled={submitting != null}
                    onClick={() => void submit('reject')}
                    className="btn btn-secondary text-xs px-4 py-2 cursor-pointer inline-flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {submitting === 'reject' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {ACTION_LABELS.reject}
                  </button>
                )}
                <button
                  type="button"
                  data-testid="admin-guest-review-approve"
                  disabled={submitting != null}
                  onClick={() => void submit('approve')}
                  className="btn btn-primary text-xs px-4 py-2 cursor-pointer inline-flex items-center gap-1.5 disabled:opacity-50"
                >
                  {submitting === 'approve' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {ACTION_LABELS.approve}
                </button>
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
