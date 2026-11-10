import { useState } from 'react'
import { importAdminStatement, previewAdminStatement, type AdminStatementPreview } from '../../../api/adminRecharge'
import { getApiErrorMessage } from '../../../api/error'
import { useAppStore } from '../../../stores/appStore'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/Dialog'

const HEADER = 'provider_entry_key,provider_payment_id,status,amount_minor,currency,occurred_at'

/**
 * Import a statement in the documented monexus-statement-v1 CSV. Imported rows
 * only open reconciliation items; compensation still requires a fresh provider
 * query, and the same file (SHA-256) maps to the same run.
 */
export default function AdminStatementImport({ provider, onImported }: { provider: string; onImported?: () => void }) {
  const showToast = useAppStore((s) => s.showToast)
  const [open, setOpen] = useState(false)
  const [accountKey, setAccountKey] = useState('')
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [csv, setCsv] = useState('')
  const [preview, setPreview] = useState<AdminStatementPreview | null>(null)
  const [busy, setBusy] = useState(false)

  const period = () => ({ periodStart: new Date(periodStart).toISOString(), periodEnd: new Date(periodEnd).toISOString() })
  const ready = Boolean(accountKey.trim() && periodStart && periodEnd && csv)

  async function readFile(file: File | undefined) {
    setPreview(null)
    setCsv(file ? await file.text() : '')
  }

  async function runPreview() {
    if (!ready || busy) return
    setBusy(true)
    try {
      setPreview(await previewAdminStatement({ ...period(), csv }))
    } catch (err) {
      showToast(getApiErrorMessage(err, '账单预览失败'), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function runImport() {
    if (!preview || busy) return
    setBusy(true)
    try {
      const run = await importAdminStatement({ provider, providerAccountKey: accountKey.trim(), ...period(), csv })
      showToast(`账单已导入：发现差异 ${run.mismatchCount} 条`)
      setOpen(false)
      setPreview(null)
      setCsv('')
      onImported?.()
    } catch (err) {
      showToast(getApiErrorMessage(err, '账单导入失败'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" className="btn-secondary btn-sm text-xs" onClick={() => setOpen(true)} data-testid="admin-statement-import-open">
        导入账单
      </button>
      <Dialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o) }}>
        <DialogContent className="max-w-lg">
          <DialogTitle>导入渠道账单</DialogTitle>
          <DialogDescription className="text-xs">
            仅支持 monexus-statement-v1 CSV（表头 <code className="break-all">{HEADER}</code>）。金额为最小货币单位整数，时间须带时区；区间为 [开始, 结束)。
          </DialogDescription>
          <div className="space-y-2 text-xs mt-2">
            <label className="block">渠道商户账户
              <input className="input mt-1" value={accountKey} onChange={(e) => { setAccountKey(e.target.value); setPreview(null) }} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">开始（含）
                <input type="datetime-local" className="input mt-1" value={periodStart} onChange={(e) => { setPeriodStart(e.target.value); setPreview(null) }} />
              </label>
              <label className="block">结束（不含）
                <input type="datetime-local" className="input mt-1" value={periodEnd} onChange={(e) => { setPeriodEnd(e.target.value); setPreview(null) }} />
              </label>
            </div>
            <label className="block">账单文件（CSV，单文件不超过 5000 行）
              <input type="file" accept=".csv,text/csv" className="mt-1 block" onChange={(e) => void readFile(e.target.files?.[0])} />
            </label>
            {preview && (
              <div className="p-2 rounded border border-[var(--color-border)] space-y-1" data-testid="admin-statement-preview">
                <div>有效 {preview.validRows} 行；无效 {preview.invalidRows.length} 行；重复 {preview.duplicateLines.length} 行</div>
                <div>合计：{Object.entries(preview.totals).map(([c, v]) => `${c} ${v}`).join('，') || '—'}</div>
                <div className="font-mono break-all text-[11px] text-[var(--color-text-muted)]">SHA-256 {preview.sha256}</div>
                {preview.invalidRows.slice(0, 5).map((row) => (
                  <div key={row.line} className="text-[var(--color-danger)]">第 {row.line} 行：{row.error}</div>
                ))}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button type="button" className="btn-secondary btn-sm text-xs" disabled={busy || !ready} onClick={() => void runPreview()}>预览</button>
            <button type="button" className="btn-primary btn-sm text-xs"
              disabled={busy || !preview || preview.invalidRows.length > 0 || preview.validRows === 0}
              onClick={() => void runImport()}>确认导入</button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
