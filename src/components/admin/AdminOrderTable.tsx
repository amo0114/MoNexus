import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { getAdminOrders, AdminOrderItem } from '../../api/admin'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import RegistryPill from '../ui/RegistryPill'
import AdminPagination from './AdminPagination'

const PAGE_SIZE = 20

/** 订单记录 Tab：状态下拉筛选 + 搜索（邮箱模糊 / 纯数字订单号精确）+ 分页 */
export default function AdminOrderTable() {
  const showToast = useAppStore((s) => s.showToast)
  const registry = useAppStore((s) => s.registry)

  const [orders, setOrders] = useState<AdminOrderItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const [searchDebounced, setSearchDebounced] = useState('')

  // 搜索 300ms 防抖，筛选变化时重置页码到 1
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchDebounced(search.trim())
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    fetchOrders()
  }, [page, statusFilter, searchDebounced])

  async function fetchOrders() {
    try {
      const data = await getAdminOrders({
        page,
        pageSize: PAGE_SIZE,
        status: statusFilter || undefined,
        q: searchDebounced || undefined,
      })
      setOrders(data.items)
      setTotal(data.total)
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '加载订单列表失败'), 'error')
    }
  }

  const statusOptions = registry?.orderStatuses ?? []

  return (
    <div className="space-y-4">
      <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">订单记录</h2>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索买家邮箱 / 订单号"
            data-testid="admin-order-search"
            className="input !py-1.5 !text-sm !pl-8 w-64"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value)
            setPage(1)
          }}
          data-testid="admin-order-status-filter"
          className="input !py-1.5 !text-sm w-36"
        >
          <option value="">全部状态</option>
          {statusOptions.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="admin-table">
          <thead>
            <tr>
              <th>订单号 / 时间</th>
              <th>买家</th>
              <th>商品信息</th>
              <th>扣除积分</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>
                  <div className="font-mono text-xs text-[var(--color-text-muted)]">ORD-{o.id}</div>
                  <div className="text-[10px] text-[var(--color-text-muted)] mt-1">{new Date(o.createdAt).toLocaleString()}</div>
                </td>
                <td className="text-sm">
                  <div className="font-bold text-[var(--color-text)]">U{o.user?.id}</div>
                  <div className="text-xs text-[var(--color-text-muted)]">{o.user?.email}</div>
                </td>
                <td className="text-[var(--color-text-muted)] text-sm">{o.product?.name}</td>
                <td className="text-[var(--color-cta)] font-bold">{o.price}</td>
                <td>
                  <RegistryPill value={o.status} category="orderStatuses" />
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center py-8 text-[var(--color-text-muted)]">
                  暂无数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <AdminPagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} testId="admin-order-pagination" />
    </div>
  )
}
