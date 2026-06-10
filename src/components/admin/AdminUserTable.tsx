import { useEffect, useState } from 'react'
import { Search, X } from 'lucide-react'
import {
  getAdminUsers,
  banUser,
  unbanUser,
  adjustUserPoints,
  AdminUserItem,
} from '../../api/admin'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'
import AdminPagination from './AdminPagination'

const PAGE_SIZE = 20

/** 用户管理 Tab：搜索（邮箱/商家名，300ms 防抖）+ 分页 + 封禁/解封/调整积分 */
export default function AdminUserTable() {
  const showToast = useAppStore((s) => s.showToast)
  const currentUser = useAuthStore((s) => s.user)

  const [users, setUsers] = useState<AdminUserItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
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
    fetchUsers()
  }, [page, searchDebounced])

  async function fetchUsers() {
    try {
      const data = await getAdminUsers({
        page,
        pageSize: PAGE_SIZE,
        q: searchDebounced || undefined,
      })
      setUsers(data.items)
      setTotal(data.total)
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '加载用户列表失败'), 'error')
    }
  }

  // Ban modal
  const [showBan, setShowBan] = useState(false)
  const [banTarget, setBanTarget] = useState<AdminUserItem | null>(null)
  const [banReason, setBanReason] = useState('')

  async function confirmBan() {
    if (!banTarget) return
    if (!banReason.trim()) {
      showToast('请输入封禁原因', 'error')
      return
    }
    try {
      await banUser(banTarget.id, banReason)
      showToast('已成功封禁该用户')
      setShowBan(false)
      fetchUsers()
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '封禁失败'), 'error')
    }
  }

  async function handleUnban(userId: number) {
    if (!confirm('确定要解封该用户吗？')) return
    try {
      await unbanUser(userId)
      showToast('已成功解封该用户')
      fetchUsers()
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '解封失败'), 'error')
    }
  }

  // Adjust points modal
  const [showAdjust, setShowAdjust] = useState(false)
  const [adjustTarget, setAdjustTarget] = useState<AdminUserItem | null>(null)
  const [adjustType, setAdjustType] = useState<'add' | 'deduct'>('add')
  const [adjustAmount, setAdjustAmount] = useState('')
  const [adjustReason, setAdjustReason] = useState('')

  async function confirmAdjust() {
    if (!adjustTarget) return
    const amount = parseInt(adjustAmount)
    if (!amount || amount <= 0 || !adjustReason) {
      showToast('请填写有效的数量和原因', 'error')
      return
    }
    try {
      await adjustUserPoints(adjustTarget.id, { type: adjustType, amount, reason: adjustReason })
      showToast(`已成功${adjustType === 'add' ? '发放' : '扣除'} ${amount} 积分`)
      setShowAdjust(false)
      fetchUsers()
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '操作失败'), 'error')
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">用户管理</h2>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索邮箱 / 商家名称"
            data-testid="admin-user-search"
            className="input !py-1.5 !text-sm !pl-8 w-64"
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="admin-table">
          <thead>
            <tr>
              <th>UID / 邮箱</th>
              <th>注册时间</th>
              <th>当前积分</th>
              <th>状态</th>
              <th className="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <div className="font-bold text-[var(--color-text)] flex items-center gap-1.5">
                    U{u.id}
                    {u.role === 'admin' && (
                      <span className="text-[10px] bg-[var(--color-primary)]/12 text-[var(--color-primary)] border border-[var(--color-primary)]/25 px-1.5 py-0.5 rounded font-medium">管理员</span>
                    )}
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)] mt-1">{u.email}</div>
                </td>
                <td className="text-[var(--color-text-muted)] text-sm">{new Date(u.createdAt).toLocaleDateString()}</td>
                <td className="font-bold text-[var(--color-cta)]">{u.pointAccount?.balance ?? 0}</td>
                <td>
                  <span className={`inline-flex items-center px-2.5 py-1 text-[11px] rounded font-bold border ${
                    u.status === '正常'
                      ? 'bg-[var(--color-cta)]/10 text-[var(--color-cta)] border-[var(--color-cta)]/25'
                      : 'bg-red-500/10 text-red-500 border-red-500/25'
                  }`}>
                    {u.status}
                  </span>
                </td>
                <td className="text-right space-x-2 whitespace-nowrap">
                  {u.status === '正常' && u.role !== 'admin' && (
                    <button
                      disabled={u.id === currentUser?.id}
                      onClick={() => {
                        setBanTarget(u)
                        setBanReason('')
                        setShowBan(true)
                      }}
                      className="text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 font-semibold text-xs px-3 py-1.5 rounded-lg transition-colors border border-[var(--color-danger)]/25 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      封禁
                    </button>
                  )}
                  {u.status === '已封禁' && u.role !== 'admin' && (
                    <button
                      onClick={() => handleUnban(u.id)}
                      className="text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-semibold text-xs px-3 py-1.5 rounded-lg transition-colors border border-[var(--color-primary)]/25 cursor-pointer"
                    >
                      解封
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setAdjustTarget(u)
                      setAdjustType('add')
                      setAdjustAmount('')
                      setAdjustReason('')
                      setShowAdjust(true)
                    }}
                    className="text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-semibold text-xs px-3 py-1.5 rounded-lg transition-colors border border-[var(--color-primary)]/25 cursor-pointer"
                  >
                    调整积分
                  </button>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center py-8 text-[var(--color-text-muted)]">
                  暂无数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <AdminPagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} testId="admin-user-pagination" />

      {/* Ban User Modal */}
      {showBan && banTarget && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center">
          <div className="modal-overlay" onClick={() => setShowBan(false)} />
          <div className="modal relative z-10 fade-in !max-w-sm">
            <div className="flex justify-between items-center mb-5">
              <h3 className="font-heading text-xl font-bold text-[var(--color-text)]">封禁用户</h3>
              <button
                onClick={() => setShowBan(false)}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer"
                aria-label="关闭"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">目标用户</label>
                <input
                  type="text"
                  disabled
                  value={`U${banTarget.id} (${banTarget.email})`}
                  className="input !text-sm !bg-[var(--color-background)] !text-[var(--color-text-muted)] cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">封禁原因</label>
                <input
                  type="text"
                  value={banReason}
                  onChange={(e) => setBanReason(e.target.value)}
                  placeholder="请输入封禁原因"
                  className="input"
                />
              </div>
              <button onClick={confirmBan} className="btn-primary w-full mt-2 bg-[var(--color-danger)] hover:opacity-90 border-[var(--color-danger)] text-white shadow-md">
                确认封禁
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Adjust Points Modal */}
      {showAdjust && adjustTarget && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center">
          <div className="modal-overlay" onClick={() => setShowAdjust(false)} />
          <div className="modal relative z-10 fade-in !max-w-sm">
            <div className="flex justify-between items-center mb-5">
              <h3 className="font-heading text-xl font-bold text-[var(--color-text)]">调整用户积分</h3>
              <button
                onClick={() => setShowAdjust(false)}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer"
                aria-label="关闭"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">目标用户</label>
                <input
                  type="text"
                  disabled
                  value={`U${adjustTarget.id} (${adjustTarget.email}) - 当前: ${adjustTarget.pointAccount?.balance ?? 0}`}
                  className="input !text-sm !bg-[var(--color-background)] !text-[var(--color-text-muted)] cursor-not-allowed"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                {(['add', 'deduct'] as const).map((t) => (
                  <label
                    key={t}
                    className={`flex items-center gap-2 p-2.5 border rounded-lg cursor-pointer transition-colors hover:bg-[var(--color-background)] ${
                      adjustType === t
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5'
                        : 'border-[var(--color-border)]'
                    }`}
                  >
                    <input
                      type="radio"
                      checked={adjustType === t}
                      onChange={() => setAdjustType(t)}
                      className="accent-[var(--color-primary)]"
                    />
                    <span className={`font-bold text-sm ${t === 'add' ? 'text-[var(--color-cta)]' : 'text-red-500'}`}>
                      {t === 'add' ? '增加 (+)' : '扣除 (-)'}
                    </span>
                  </label>
                ))}
              </div>
              <div>
                <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">调整数量</label>
                <input
                  type="number"
                  value={adjustAmount}
                  onChange={(e) => setAdjustAmount(e.target.value)}
                  placeholder="输入整数"
                  className="input"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">操作原因</label>
                <input
                  type="text"
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  placeholder="例如：参与活动奖励"
                  className="input"
                />
              </div>
              <button onClick={confirmAdjust} className="btn-primary w-full mt-2">
                确认执行
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
