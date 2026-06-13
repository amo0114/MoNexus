import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { createOrderReview, updateOrderReview, OwnReview } from '../api/reviews'
import StarRating from './ui/StarRating'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/Dialog'

interface Props {
  open: boolean
  orderId: number
  mode: 'create' | 'edit'
  initial?: { rating: number; comment: string | null }
  onClose: () => void
  onSaved: (review: OwnReview) => void
}

export default function ReviewDialog({ open, orderId, mode, initial, onClose, onSaved }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [rating, setRating] = useState(initial?.rating ?? 5)
  const [comment, setComment] = useState(initial?.comment ?? '')
  const [saving, setSaving] = useState(false)

  async function handleSubmit() {
    setSaving(true)
    try {
      const body = { rating, comment: comment.trim() || undefined }
      const saved = mode === 'create'
        ? await createOrderReview(orderId, body)
        : await updateOrderReview(orderId, body)
      showToast(mode === 'create' ? '评价已提交' : '评价已修改')
      onSaved(saved)
    } catch (e: any) {
      showToast(e.response?.data?.error?.message || '操作失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="!z-[120]" data-testid="review-dialog">
        <DialogTitle>{mode === 'create' ? '评价商品' : '修改评价'}</DialogTitle>
        <DialogDescription>
          {mode === 'edit' ? '修改机会仅一次，提交后不可再改。' : '评分必填，评价内容可选（500 字内）。'}
        </DialogDescription>
        <div className="mt-4 space-y-4">
          <StarRating value={rating} onChange={setRating} size="md" />
          <textarea
            className="input min-h-[80px] resize-y text-sm w-full"
            placeholder="说说你的使用体验（可选）..."
            maxLength={500}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid="review-comment-input"
          />
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <button type="button" onClick={onClose} className="btn-secondary !px-5 !py-2 !text-sm">取消</button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving}
            className="btn-primary !px-5 !py-2 !text-sm"
            data-testid="review-submit"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : '提交'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
