import { useEffect, useState } from 'react'
import { Scale } from 'lucide-react'
import { createAdminReconRun, listAdminReconRuns, type AdminReconRun } from '../../../api/adminRecharge'
import { getApiErrorMessage } from '../../../api/error'
import { useAppStore } from '../../../stores/appStore'
import ConfirmDialog from '../../ui/ConfirmDialog'
import EmptyState from '../../ui/EmptyState'
import { TableSkeleton } from '../../ui/Skeleton'
import { PAYMENT_PROVIDERS, providerLabel, RECON_STATUS_LABEL } from '../../../pages/recharge/status'

export default function AdminReconciliation() {
  const showToast = useAppStore((s) => s.showToast)
  const [items, setItems] = useState<AdminReconRun[]>([])
  const [loading, setLoading] = useState(true)
  const [provider, setProvider] = useState('simulator')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [acting, setActing] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const data = await listAdminReconRuns()
      setItems(data.items)
    } catch (err) {
      showToast(getApiErrorMessage(err, '加载对账批次失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="space-y-4" data-testid="admin-reconciliation">
      <div className="flex flex-wrap items-center gap-2">
        <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)}>
          {PAYMENT_PROVIDERS.map((item) => (
            <option key={item} value={item}>{providerLabel(item)}</option>
          ))}
        </select>
        <button type="button" className="btn-primary" onClick={() => setConfirmOpen(true)}>
          发起对账
        </button>
      </div>
      {loading && items.length === 0 ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <EmptyState compact icon={Scale} title="暂无对账批次" />
      ) : (
        <div className="overflow-x-auto">
          <table className="admin-table table-cards">
            <thead>
              <tr>
                <th>渠道</th>
                <th>范围</th>
                <th>状态</th>
                <th>差异</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td data-label="渠道">
                    {providerLabel(item.provider)}
                    <div className="text-xs text-[var(--color-text-muted)]">{item.environment}</div>
                  </td>
                  <td data-label="范围" className="text-xs">{item.scopeType} · {item.scopeKey}</td>
                  <td data-label="状态">{RECON_STATUS_LABEL[item.status] ?? item.status}</td>
                  <td data-label="差异">{item.mismatchCount} / {item.itemCount}</td>
                  <td data-label="时间">{new Date(item.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => { if (!acting) setConfirmOpen(open) }}
        title="发起渠道对账？"
        description="将按服务端对账合同查询渠道，不会手工改写订单或余额。"
        confirmLabel="发起"
        tone="primary"
        loading={acting}
        onConfirm={() => {
          setActing(true)
          createAdminReconRun({ provider })
            .then(() => {
              showToast('对账已执行')
              setConfirmOpen(false)
              void load()
            })
            .catch((err) => showToast(getApiErrorMessage(err, '对账失败'), 'error'))
            .finally(() => setActing(false))
        }}
      />
    </div>
  )
}
