import { useEffect, useRef, useState } from 'react'
import { Activity } from 'lucide-react'
import api from '../../api/client'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { TableSkeleton } from '../ui/Skeleton'
import EmptyState from '../ui/EmptyState'
import { pointLogVisual, formatPointLogAmount } from '../../utils/pointLogDisplay'

interface Props {
  active?: boolean
}

export default function AdminPointLogPanel({ active = true }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [logs, setLogs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const seqRef = useRef(0)

  useEffect(() => {
    if (!active) {
      seqRef.current++
      return
    }

    const seq = ++seqRef.current
    async function fetchLogs() {
      setLoading(true)
      try {
        const { data } = await api.get('/admin/logs')
        if (seq !== seqRef.current) return
        setLogs(Array.isArray(data) ? data : [])
      } catch (err) {
        if (seq !== seqRef.current) return
        showToast(getApiErrorMessage(err, '加载失败'), 'error')
      } finally {
        if (seq === seqRef.current) {
          setLoading(false)
        }
      }
    }
    void fetchLogs()

    return () => {
      seqRef.current++
    }
  }, [active, showToast])

  return (
    <div className="space-y-4">
      <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">积分流水</h2>
      <div className="overflow-x-auto">
        {loading && logs.length === 0 ? (
          <TableSkeleton />
        ) : (
          <table className="admin-table table-cards">
            <thead>
              <tr>
                <th>时间</th>
                <th>关联用户</th>
                <th>类型</th>
                <th>事件描述</th>
                <th className="text-right">积分变动</th>
                <th className="text-right">变动后余额</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l: any) => {
                const visual = pointLogVisual(l.type)
                const formattedAmount = formatPointLogAmount(l.type, l.amount)
                return (
                  <tr key={l.id}>
                    <td className="text-[var(--color-text-muted)] text-xs" data-label="时间">
                      {new Date(l.createdAt).toLocaleString()}
                    </td>
                    <td className="font-bold text-[var(--color-text)] text-sm" data-label="关联用户">
                      U{l.user?.id ?? l.userId}
                    </td>
                    <td data-label="类型">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border ${visual.iconWrapClass}`}>
                        {visual.typeLabel}
                      </span>
                    </td>
                    <td className="text-sm text-[var(--color-text-muted)]" data-label="事件描述">
                      <div>{l.reason || '—'}</div>
                      {visual.hint && (
                        <div className="text-[11px] text-[var(--color-text-muted)]/80 mt-0.5">
                          {visual.hint}
                        </div>
                      )}
                    </td>
                    <td className={`text-right font-bold text-base ${visual.amountClass}`} data-label="积分变动">
                      {formattedAmount}
                    </td>
                    <td className="text-right font-bold text-sm text-[var(--color-text)]" data-label="变动后余额">
                      {l.balanceAfter != null ? l.balanceAfter.toLocaleString() : '—'}
                    </td>
                  </tr>
                )
              })}
              {!loading && logs.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <EmptyState compact icon={Activity} title="暂无积分流水" />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
