import { useState, useMemo, useEffect } from 'react'
import { X, DatabaseZap, FileText, AlertCircle, Loader2 } from 'lucide-react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useAppStore } from '../../stores/appStore'
import { previewMerchantInventory } from '../../api/merchant'
import type { Offer } from '../../types/merchant'

interface Props {
  isOpen: boolean
  onClose: () => void
  onSubmit: (items: string[], offerId?: number) => Promise<void>
  productName: string
  productId?: number
  /** 目标商品的即时库存 active 规格；>1 时渲染规格选择器（P4a）。 */
  offers?: Offer[]
}

interface PreviewStats {
  totalRows: number
  validRows: number
  emptyRows: number
  duplicateRows: number
  existingDuplicateRows: number
  canImport: boolean
  details?: any[]
  /** P4b：模板行级错误（1 起行号）。 */
  rowErrors?: Array<{ row: number; message: string }>
  /** P4b：结构化解析预览（模板 + 前 N 行值）。 */
  structured?: { fields: Array<{ key: string; label: string; sensitive: boolean }>; rows: Array<Record<string, string>> }
}

export default function MerchantInventoryImportModal({ isOpen, onClose, onSubmit, productName, productId, offers }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [loading, setLoading] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [inventoryText, setInventoryText] = useState('')
  const [stats, setStats] = useState<PreviewStats | null>(null)
  // 多规格时渲染选择器让商家指定卡密归属；单规格不渲染但仍显式提交它的
  // offerId（默认 Offer 未必是即时库存那条）。offers 为空才回落到服务端默认。
  const multiOffer = (offers?.length ?? 0) > 1
  const [selectedOfferId, setSelectedOfferId] = useState<number | undefined>(offers?.[0]?.id)
  // P4b：选中规格的交付字段模板；非空时导入按 | 分隔映射字段。
  const template = offers?.find(o => o.id === selectedOfferId)?.deliveryFields ?? []

  const lineCount = useMemo(() => {
    if (!inventoryText) return 0
    return inventoryText.split('\n').map(s => s.trim()).filter(Boolean).length
  }, [inventoryText])

  // 打开或切换商品时，把选中规格重置为该商品的第一条即时库存规格。
  useEffect(() => {
    if (isOpen) {
      setSelectedOfferId(offers?.[0]?.id)
      setInventoryText('')
      setStats(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, productId])

  if (!isOpen) return null

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInventoryText(e.target.value)
    if (stats) setStats(null)
  }

  async function handlePreview() {
    if (!productId) return
    const text = inventoryText.trim()
    if (!text) {
      showToast('请输入至少一个交付单元', 'error')
      return
    }
    setPreviewing(true)
    try {
      // P4b：模板挂在规格上，预览带上目标规格才能按模板解析。
      const data = await previewMerchantInventory(productId, {
        text,
        ...(selectedOfferId != null ? { offerId: selectedOfferId } : {}),
      })
      setStats(data)
    } catch (e: any) {
      const errData = e.response?.data?.error
      if (errData?.details) {
        setStats({
          canImport: false,
          totalRows: lineCount,
          validRows: 0,
          emptyRows: 0,
          duplicateRows: errData.details.find((d: any) => d.duplicateRows)?.duplicateRows || 0,
          existingDuplicateRows: errData.details.find((d: any) => d.existingDuplicateRows)?.existingDuplicateRows || 0,
          details: errData.details
        })
      }
      showToast(errData?.message || '预览失败', 'error')
    } finally {
      setPreviewing(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!stats?.canImport) {
      return
    }

    const items = inventoryText
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)

    if (items.length === 0) {
      showToast('请至少输入一行有效交付单元', 'error')
      return
    }

    setLoading(true)
    try {
      // 只要已知目标规格就显式携带：product 的默认 Offer 未必是即时库存规格，
      // 省略 offerId 会让服务端落到默认 Offer 而报"仅即时库存支持库存管理"。
      await onSubmit(items, selectedOfferId)
      setInventoryText('')
      setStats(null)
      onClose()
    } catch (e: any) {
      showToast(e.response?.data?.error?.message || '导入失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="modal-overlay" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[calc(100%-2rem)] max-w-lg max-h-[92dvh] flex flex-col overflow-hidden bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-xl focus-visible:outline-none">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-[var(--color-primary)]/10 flex items-center justify-center text-[var(--color-primary)]">
              <DatabaseZap className="w-6 h-6" />
            </div>
            <div>
              <DialogPrimitive.Title className="font-heading text-xl font-bold text-[var(--color-text)]">
                导入交付单元
              </DialogPrimitive.Title>
              <p className="text-xs text-[var(--color-text-muted)] mt-0.5 font-medium truncate max-w-[200px]" title={productName}>
                目标商品: {productName}
              </p>
            </div>
          </div>
          <DialogPrimitive.Close
            className="p-2.5 rounded-full hover:bg-[var(--color-background)] transition-colors text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer"
            aria-label="关闭"
          >
            <X className="w-5 h-5" />
          </DialogPrimitive.Close>
        </div>

        {/* Body */}
        <div className="px-6 py-6 overflow-y-auto flex-1 bg-[var(--color-background)]">
          <form id="inventoryForm" onSubmit={handleSubmit} className="space-y-5">
            {/* 多规格：选择卡密归属的规格（P4a） */}
            {multiOffer && (
              <div>
                <label className="block text-sm font-bold text-[var(--color-text)] mb-1.5">导入到规格</label>
                <select
                  className="input appearance-none cursor-pointer"
                  value={selectedOfferId ?? ''}
                  onChange={(e) => { setSelectedOfferId(Number(e.target.value)); setStats(null) }}
                  data-testid="import-offer-select"
                >
                  {offers!.map(o => (
                    <option key={o.id} value={o.id}>
                      {o.name}（{o.price} 积分{o.status === 'inactive' ? ' · 已下架' : ''}）
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">卡密将归属到所选规格；不同规格的库存相互独立。</p>
              </div>
            )}
            {/* Guidelines */}
            <div className="bg-[var(--color-primary)]/8 border border-[var(--color-primary)]/20 rounded-lg p-4 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-[var(--color-primary)] flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-bold text-[var(--color-primary)] mb-1">导入须知</h4>
                <ul className="text-xs text-[var(--color-text-muted)] space-y-1 list-disc ml-3">
                  <li>仅适用于“即时库存发货”商品，请将可独立交付给一位买家的内容粘贴到下方。</li>
                  <li><strong className="text-[var(--color-text)]">每行代表一个交付单元</strong>，购买后系统将自动抽取其中一行发货。</li>
                  <li>交付单元可以是账号、卡密、节点配置、邀请码等；同一买家应收到的完整内容请写在同一行。</li>
                  <li>空行会被自动忽略。</li>
                </ul>
              </div>
            </div>

            {/* P4b：模板化导入格式提示 */}
            {template.length > 0 && (
              <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-3 text-xs" data-testid="import-template-hint">
                <div className="font-bold text-[var(--color-text)] mb-1.5">该规格已配置交付字段模板，每行按以下顺序用 <code className="font-mono">|</code> 分隔：</div>
                <code className="font-mono text-[var(--color-primary)]">
                  {template.map(f => f.label).join(' | ')}
                </code>
                <p className="mt-1.5 text-[var(--color-text-muted)]">内容里的竖线写作 <code className="font-mono">\|</code>；每个字段都不能为空。</p>
              </div>
            )}

            <div className="relative">
              <div className="flex items-center justify-between mb-2">
                <label className="flex items-center gap-2 text-sm font-bold text-[var(--color-text)]">
                  <FileText className="w-4 h-4 text-[var(--color-text-muted)]" />
                  交付单元内容
                </label>
                <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded-full border ${
                  lineCount > 0
                    ? 'bg-[var(--color-cta)]/10 text-[var(--color-cta)] border-[var(--color-cta)]/25'
                    : 'bg-[var(--color-background)] text-[var(--color-text-muted)] border-[var(--color-border)]'
                }`}>
                  已解析: {lineCount} 个交付单元
                </span>
              </div>
              <textarea
                className="input min-h-[220px] font-mono leading-relaxed resize-y"
                placeholder="例如：&#10;卡密：ABCD-1234-EFGH-5678&#10;账号：user@example.com | 密码：example-password&#10;节点：sg-01.example.com:443 | UUID：xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx&#10;邀请码：INVITE-2026-ABC"
                value={inventoryText}
                onChange={handleTextChange}
                required
                spellCheck="false"
              />
              {lineCount >= 500 && (
                <p className="mt-2 text-xs text-[var(--color-warning)]">
                  当前为较大批量导入。请先预览；如需定位重复项或修正内容，建议拆分为更小批次后再导入。
                </p>
              )}
            </div>

            {stats && (
              <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-4">
                <h4 className="text-sm font-bold text-[var(--color-text)] mb-3">预览结果</h4>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-[var(--color-text-muted)]">共解析</span>
                    <span className="font-bold text-[var(--color-text)]">{stats.totalRows} 行</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--color-text-muted)]">有效交付单元</span>
                    <span className="font-bold text-[var(--color-cta)]">{stats.validRows} 个</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--color-text-muted)]">空行</span>
                    <span className="font-bold text-[var(--color-text-muted)]">{stats.emptyRows} 行</span>
                  </div>
                  {stats.duplicateRows > 0 && (
                    <div className="flex justify-between">
                      <span className="text-[var(--color-warning)]">请求内重复</span>
                      <span className="font-bold text-[var(--color-warning)]">{stats.duplicateRows} 行</span>
                    </div>
                  )}
                  {stats.existingDuplicateRows > 0 && (
                    <div className="flex justify-between">
                      <span className="text-[var(--color-danger)]">与既有库存重复</span>
                      <span className="font-bold text-[var(--color-danger)]">{stats.existingDuplicateRows} 行</span>
                    </div>
                  )}
                </div>

                {/* P4b：模板行级错误 */}
                {(stats.rowErrors?.length ?? 0) > 0 && (
                  <div className="mt-3 pt-3 border-t border-[var(--color-border)]" data-testid="import-row-errors">
                    <div className="text-xs font-bold text-[var(--color-danger)] mb-1.5">以下行不符合模板，修正后重新预览：</div>
                    <ul className="text-xs text-[var(--color-danger)] space-y-0.5 max-h-32 overflow-y-auto">
                      {stats.rowErrors!.map(err => (
                        <li key={err.row}>第 {err.row} 行：{err.message}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* P4b：结构化解析预览表 */}
                {stats.structured && stats.structured.rows.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-[var(--color-border)] overflow-x-auto" data-testid="import-structured-preview">
                    <div className="text-xs font-bold text-[var(--color-text)] mb-1.5">解析预览（前 {stats.structured.rows.length} 条）</div>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-[var(--color-text-muted)]">
                          {stats.structured.fields.map(f => (
                            <th key={f.key} className="py-1 pr-3 font-medium whitespace-nowrap">{f.label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {stats.structured.rows.map((row, i) => (
                          <tr key={i} className="border-t border-[var(--color-border)]">
                            {stats.structured!.fields.map(f => (
                              <td key={f.key} className="py-1 pr-3 font-mono max-w-[10rem] truncate" title={f.sensitive ? undefined : row[f.key]}>
                                {f.sensitive ? '••••••' : row[f.key]}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </form>
        </div>

        {/* Footer */}
        <div className="px-6 py-5 border-t border-[var(--color-border)] flex justify-end gap-3 flex-wrap">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary px-6 py-2.5"
            disabled={loading || previewing}
          >
            取消
          </button>
          {!stats ? (
            <button
              type="button"
              onClick={handlePreview}
              disabled={previewing || lineCount === 0}
              className="btn-primary min-w-[140px]"
            >
              {previewing ? <Loader2 className="w-4 h-4 animate-spin inline" /> : '预览导入内容'}
            </button>
          ) : (
            <button
              type="submit"
              form="inventoryForm"
              disabled={loading || !stats.canImport}
              className="btn-primary min-w-[140px]"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin inline" /> : `确认导入 ${stats.validRows} 个`}
            </button>
          )}
        </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
