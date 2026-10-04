import { useRef, useState, type MutableRefObject } from 'react'
import { setAdminFakaCapacity, type AdminProductListItem } from '../../../api/admin'
import { getApiErrorMessage } from '../../../api/error'
import { useAppStore } from '../../../stores/appStore'
import { Dialog, DialogContent, DialogTitle } from '../../ui/Dialog'

interface ProductCapacityDialogProps {
  /** 待调整名额的商品；为 null 表示弹窗关闭 */
  product: AdminProductListItem | null
  /** 请求父层关闭弹窗（父层据此清空 product） */
  onClose: () => void
  /** 保存成功并同步 Xboard 后，请求父层安全刷新列表 */
  onSaved: () => void
}

interface CapacityDialogBodyProps {
  product: AdminProductListItem
  /** 保存中标记，供外层关闭守卫读取，避免同步过程中被 Esc/遮罩关闭 */
  savingRef: MutableRefObject<boolean>
  onClose: () => void
  onSaved: () => void
}

/**
 * 弹窗正文。只在 DialogContent 实际挂载（弹窗打开）时渲染，
 * 因此草稿输入与「不限制人数」开关会在每次打开时按当前商品的
 * capacityLimit 重新播种——等价于基线在父层 openFakaCapacity 中的初始化。
 */
function CapacityDialogBody({
  product,
  savingRef,
  onClose,
  onSaved,
}: CapacityDialogBodyProps) {
  const showToast = useAppStore((s) => s.showToast)
  const initialLimit = product.fakaCapacity?.capacityLimit
  const [input, setInput] = useState(initialLimit != null ? String(initialLimit) : '')
  const [unlimited, setUnlimited] = useState(initialLimit == null)
  const [saving, setSaving] = useState(false)

  function markSaving(value: boolean) {
    savingRef.current = value
    setSaving(value)
  }

  return (
    <>
      <DialogTitle>调整 Xboard 人数上限</DialogTitle>
      <p className="text-xs text-[var(--color-text-muted)] mb-3">
        设置该套餐在 Xboard 的用户数上限；达到上限后将自动下架对应规格。
      </p>
      {product.fakaCapacity && (
        <p className="text-xs text-[var(--color-text-muted)] mb-3">
          当前容量：
          {product.fakaCapacity.capacityLimit == null
            ? '不限制'
            : `${product.fakaCapacity.capacityLimit} 人`}
          ，在用 {product.fakaCapacity.activeUsers ?? 0}
        </p>
      )}
      <label className="flex items-center gap-2 text-sm mb-3 cursor-pointer">
        <input
          type="checkbox"
          checked={unlimited}
          onChange={(e) => setUnlimited(e.target.checked)}
          data-testid="admin-faka-cap-unlimited"
        />
        不限制人数
      </label>
      {!unlimited && (
        <input
          type="number"
          min={0}
          className="input font-mono mb-4"
          placeholder="人数上限"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          data-testid="admin-faka-cap-input"
        />
      )}
      <button
        type="button"
        className="btn-primary w-full cursor-pointer"
        disabled={saving}
        data-testid="admin-faka-cap-save"
        onClick={async () => {
          const limit = unlimited ? null : Number(input)
          if (!unlimited && (!Number.isInteger(limit) || (limit as number) < 0)) {
            showToast('请输入有效的非负整数上限', 'error')
            return
          }
          markSaving(true)
          try {
            const fakaOffer = (product.offers ?? []).find(
              (o) => o.externalIntegration === 'faka_bridge',
            )
            await setAdminFakaCapacity(product.id, {
              offerId: fakaOffer?.id,
              capacityLimit: limit as number | null,
            })
            showToast('已同步到 Xboard')
            onClose()
            onSaved()
          } catch (err) {
            showToast(getApiErrorMessage(err, '同步失败'), 'error')
          } finally {
            markSaving(false)
          }
        }}
      >
        {saving ? '同步中…' : '保存并同步到 Xboard'}
      </button>
    </>
  )
}

export default function ProductCapacityDialog({
  product,
  onClose,
  onSaved,
}: ProductCapacityDialogProps) {
  const savingRef = useRef(false)

  return (
    <Dialog
      open={product != null}
      onOpenChange={(open) => {
        if (!open && !savingRef.current) onClose()
      }}
    >
      <DialogContent>
        {product != null && (
          <CapacityDialogBody
            product={product}
            savingRef={savingRef}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
