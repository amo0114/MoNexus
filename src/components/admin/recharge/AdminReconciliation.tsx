import { useEffect, useState } from 'react'
import { Scale } from 'lucide-react'
import { createAdminReconRun, listAdminReconRuns, type AdminReconRun } from '../../../api/adminRecharge'
import { getApiErrorMessage } from '../../../api/error'
import { useAppStore } from '../../../stores/appStore'
import ConfirmDialog from '../../ui/ConfirmDialog'
import EmptyState from '../../ui/EmptyState'
import { TableSkeleton } from '../../ui/Skeleton'
import { PAYMENT_PROVIDERS, providerLabel, RECON_STATUS_LABEL } from '../../../pages/recharge/status'

const SCOPE_TYPE_LABELS: Record<string, string> = {
  statement: '渠道账单',
  provider_query: '渠道主动查询',
  manual: '人工指定范围',
}

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
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <label htmlFor="admin-recon-provider-select" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
            核对渠道:
          </label>
          <select
            id="admin-recon-provider-select"
            className="input py-1.5 text-xs w-40"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            {PAYMENT_PROVIDERS.map((item) => (
              <option key={item} value={item}>{providerLabel(item)}</option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn-primary btn-sm text-xs cursor-pointer"
          onClick={() => setConfirmOpen(true)}
        >
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
                <th>核对渠道 / 环境</th>
                <th>对账范围</th>
                <th>对账状态</th>
                <th>核对结果</th>
                <th>发起时间</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td data-label="核对渠道 / 环境">
                    <div className="font-semibold text-xs text-[var(--color-text)]">
                      {providerLabel(item.provider)}
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                      {item.environment === 'sandbox' ? '沙箱测试' : '正式充值'}
                    </div>
                  </td>
                  <td data-label="对账范围" className="text-xs">
                    <div className="font-medium text-[var(--color-text)]">
                      {SCOPE_TYPE_LABELS[item.scopeType] || item.scopeType}
                    </div>
                    <div className="text-[11px] font-mono text-[var(--color-text-muted)] mt-0.5 truncate max-w-[180px]" title={item.scopeKey}>
                      {item.scopeKey}
                    </div>
                  </td>
                  <td data-label="对账状态">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border border-[var(--color-border)] bg-[var(--color-background)]">
                      {item.status === 'completed_with_mismatches'
                        ? '核对完成（存在差异）'
                        : RECON_STATUS_LABEL[item.status] ?? item.status}
                    </span>
                  </td>
                  <td data-label="核对结果" className="text-xs">
                    <div className={item.mismatchCount > 0 ? 'text-[var(--color-danger)] font-bold' : 'text-[var(--color-cta)] font-semibold'}>
                      发现差异 {item.mismatchCount} 条
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                      已检查 {item.itemCount} 条
                    </div>
                  </td>
                  <td data-label="发起时间" className="text-xs text-[var(--color-text-muted)]">
                    {new Date(item.createdAt).toLocaleString()}
                  </td>
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
        description="核对渠道记录与平台记录，查看未一致的项目。不会手工改写订单或可用积分。"
        confirmLabel="确认发起"
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
