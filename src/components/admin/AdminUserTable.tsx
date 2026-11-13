import { useEffect, useRef, useState } from 'react'
import { Search, UsersRound, Loader2, AlertTriangle, SlidersHorizontal } from 'lucide-react'
import {
  getAdminUsers,
  banUser,
  unbanUser,
  adjustUserPoints,
  AdminUserItem,
} from '../../api/admin'
import { listGovernanceUsers } from '../../api/governance'
import { getApiErrorCode, getApiErrorMessage } from '../../api/error'
import { newIdempotencyKey } from '../../utils/idempotencyKey'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'
import { useAdminCapabilities } from '../../stores/adminCapabilities'
import type {
  AccountStatus,
  GVUserListItem,
  GVUserListQuery,
  GVUserRole,
  GVUserSort,
  MerchantLifecycleStatus,
} from '../../types/governance'
import {
  accountStatusLabel,
  formatDateTime,
  merchantStatusLabel,
  roleLabel,
  shanghaiDayStart,
} from '../../utils/governance'
import AdminPagination from './AdminPagination'
import { Dialog, DialogContent, DialogTitle } from '../ui/Dialog'
import ConfirmDialog from '../ui/ConfirmDialog'
import { TableSkeleton } from '../ui/Skeleton'
import EmptyState from '../ui/EmptyState'
import { StatusChip } from './governance/GovernanceKit'
import UserDetailSheet from './governance/UserDetailSheet'
import { BanUserDialog } from './governance/BanDialogs'
import { ExportButton } from './governance/Exports'

const PAGE_SIZE = 20

/** 用户管理 Tab：搜索（300ms 防抖）+ 筛选排序 + 分页 + 详情/封禁/解封/调整积分 */
// Mirrors adjustPointsSchema on the server.
const MAX_ADJUST_POINTS = 1_000_000

/** Legacy rows lack the governance-v1 fields; governed rows carry all of them. */
type UserRow = AdminUserItem & Partial<GVUserListItem>

interface Filters {
  accountStatus: '' | AccountStatus
  role: '' | GVUserRole
  merchantStatus: '' | MerchantLifecycleStatus
  emailVerified: '' | 'true' | 'false'
  registeredFrom: string
  registeredTo: string
  sort: `${GVUserSort}:${'asc' | 'desc'}`
}

const EMPTY_FILTERS: Filters = {
  accountStatus: '',
  role: '',
  merchantStatus: '',
  emailVerified: '',
  registeredFrom: '',
  registeredTo: '',
  sort: 'createdAt:desc',
}

const SORT_OPTIONS: Array<{ value: Filters['sort']; label: string }> = [
  { value: 'createdAt:desc', label: '最新注册' },
  { value: 'createdAt:asc', label: '最早注册' },
  { value: 'lastLoginAt:desc', label: '最近登录' },
  { value: 'orderCount:desc', label: '订单最多' },
  { value: 'netSpentPoints:desc', label: '净消费最高' },
]

function toQuery(search: string, f: Filters): GVUserListQuery {
  const [sort, direction] = f.sort.split(':') as [GVUserSort, 'asc' | 'desc']
  return {
    q: search || undefined,
    accountStatus: f.accountStatus || undefined,
    role: f.role || undefined,
    merchantStatus: f.merchantStatus || undefined,
    emailVerified: f.emailVerified === '' ? undefined : f.emailVerified === 'true',
    registeredFrom: shanghaiDayStart(f.registeredFrom),
    registeredTo: shanghaiDayStart(f.registeredTo, 1),
    sort,
    direction,
  }
}

const filterCount = (f: Filters) =>
  (Object.keys(EMPTY_FILTERS) as Array<keyof Filters>).filter((k) => k !== 'sort' && f[k] !== EMPTY_FILTERS[k]).length

export default function AdminUserTable() {
  const showToast = useAppStore((s) => s.showToast)
  const currentUser = useAuthStore((s) => s.user)
  const caps = useAdminCapabilities()
  // Wait for the capability answer so an old backend never receives the new query params.
  const capsSettled = caps.state.status !== 'idle' && caps.state.status !== 'loading'
  const governed = caps.governed
  const canDetail = caps.allows('userDetails', 'users.read')
  const structuredBans = caps.allows('accountBans', 'users.ban')
  const canAdjust = !governed || caps.can('points.adjust')
  const canBan = !governed || caps.can('users.ban')

  const [users, setUsers] = useState<UserRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [searchDebounced, setSearchDebounced] = useState('')
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const reqSeqRef = useRef(0)

  const [detailUser, setDetailUser] = useState<{ id: number; tab?: 'bans' } | null>(null)
  const [structuredBanTarget, setStructuredBanTarget] = useState<{ id: number; email: string } | null>(null)

  // 搜索 300ms 防抖，筛选变化时重置页码到 1
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchDebounced(search.trim())
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    if (!capsSettled) return
    void fetchUsers()
  }, [page, searchDebounced, filters, governed, capsSettled, reloadTick])

  const refresh = () => setReloadTick((t) => t + 1)

  async function fetchUsers() {
    const seq = ++reqSeqRef.current
    setLoading(true)
    setLoadError(null)
    try {
      const data = governed
        ? await listGovernanceUsers({ page, pageSize: PAGE_SIZE, ...toQuery(searchDebounced, filters) })
        : await getAdminUsers({ page, pageSize: PAGE_SIZE, q: searchDebounced || undefined })
      if (seq !== reqSeqRef.current) return
      setUsers(data.items as UserRow[])
      setTotal(data.total)
    } catch (err: any) {
      if (seq !== reqSeqRef.current) return
      const message = getApiErrorMessage(err, '加载用户列表失败')
      setLoadError(message)
      showToast(message, 'error')
    } finally {
      if (seq === reqSeqRef.current) setLoading(false)
    }
  }

  const updateFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
    setPage(1)
  }

  // Ban modal (legacy backend)
  const [showBan, setShowBan] = useState(false)
  const [banTarget, setBanTarget] = useState<UserRow | null>(null)
  const [banReason, setBanReason] = useState('')
  const [banning, setBanning] = useState(false)

  async function confirmBan() {
    if (!banTarget || banning) return
    if (!banReason.trim()) {
      showToast('请输入封禁原因', 'error')
      return
    }
    setBanning(true)
    try {
      await banUser(banTarget.id, banReason)
      showToast('已成功封禁该用户')
      setShowBan(false)
      refresh()
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '封禁失败'), 'error')
    } finally {
      setBanning(false)
    }
  }

  // Unban confirm dialog (legacy backend)
  const [unbanTarget, setUnbanTarget] = useState<number | null>(null)
  const [unbanning, setUnbanning] = useState(false)

  async function confirmUnban() {
    if (unbanTarget === null) return
    setUnbanning(true)
    try {
      await unbanUser(unbanTarget)
      showToast('已成功解封该用户')
      setUnbanTarget(null)
      refresh()
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '解封失败'), 'error')
    } finally {
      setUnbanning(false)
    }
  }

  // Adjust points modal
  const [showAdjust, setShowAdjust] = useState(false)
  const [adjustTarget, setAdjustTarget] = useState<UserRow | null>(null)
  const [adjustType, setAdjustType] = useState<'add' | 'deduct'>('add')
  const [adjustAmount, setAdjustAmount] = useState('')
  const [adjustReason, setAdjustReason] = useState('')
  const [adjusting, setAdjusting] = useState(false)
  // One key per opened dialog: a retry after a timeout replays the grant instead of repeating it.
  const adjustKeyRef = useRef('')

  async function confirmAdjust() {
    if (!adjustTarget || adjusting) return
    const amount = /^\d+$/.test(adjustAmount.trim()) ? Number(adjustAmount) : 0
    if (!Number.isSafeInteger(amount) || amount <= 0 || !adjustReason) {
      showToast('请填写有效的数量和原因', 'error')
      return
    }
    if (amount > MAX_ADJUST_POINTS) {
      showToast(`单次调整不能超过 ${MAX_ADJUST_POINTS} 积分`, 'error')
      return
    }
    setAdjusting(true)
    try {
      await adjustUserPoints(adjustTarget.id, { type: adjustType, amount, reason: adjustReason }, adjustKeyRef.current)
      showToast(`已成功${adjustType === 'add' ? '发放' : '扣除'} ${amount} 积分`)
      setShowAdjust(false)
      refresh()
    } catch (err: any) {
      if (getApiErrorCode(err) === 'IDEMPOTENCY_KEY_REUSED') {
        // The earlier attempt with this key committed (e.g. it timed out client-side).
        showToast('上次调整可能已生效，请先核对该用户积分流水再决定是否重新调整', 'error')
        refresh()
      } else {
        showToast(getApiErrorMessage(err, '操作失败'), 'error')
      }
    } finally {
      setAdjusting(false)
    }
  }

  const isBanned = (u: UserRow) => (u.accountStatus ? u.accountStatus === 'banned' : u.status === '已封禁')

  function openBan(u: UserRow) {
    if (structuredBans) {
      setStructuredBanTarget({ id: u.id, email: u.email })
      return
    }
    setBanTarget(u)
    setBanReason('')
    setShowBan(true)
  }

  function openUnban(u: UserRow) {
    // Structured bans are released per record (id + version) from the detail view.
    if (structuredBans && canDetail) setDetailUser({ id: u.id, tab: 'bans' })
    else setUnbanTarget(u.id)
  }

  const activeFilterCount = filterCount(filters)
  const query = toQuery(searchDebounced, filters)
  const exportFilters = {
    q: query.q,
    accountStatus: query.accountStatus,
    role: query.role,
    merchantStatus: query.merchantStatus,
    emailVerified: query.emailVerified,
    from: query.registeredFrom,
    to: query.registeredTo,
  }
  const colCount = governed ? 6 : 5

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">用户管理</h2>
          {governed && (
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">共 {total.toLocaleString('en-US')} 位用户。打开详情可查看订单、积分来源、会话与操作记录。</p>
          )}
        </div>
        {governed && <ExportButton kind="users" filters={exportFilters} />}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[14rem] max-w-md">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={governed ? '搜索邮箱 / 昵称 / 商家名称' : '搜索邮箱 / 商家名称'}
            data-testid="admin-user-search"
            className="input py-1.5 pl-8 w-full"
          />
        </div>
        {governed && (
          <>
            <select
              aria-label="排序"
              className="input py-1.5 w-auto"
              value={filters.sort}
              onChange={(e) => updateFilter('sort', e.target.value as Filters['sort'])}
              data-testid="admin-user-sort"
            >
              {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button
              type="button"
              className="btn-tonal"
              aria-expanded={filtersOpen}
              aria-controls="admin-user-filters"
              onClick={() => setFiltersOpen((o) => !o)}
              data-testid="admin-user-filter-toggle"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
              筛选
              {activeFilterCount > 0 && (
                <span className="rounded-full bg-[var(--color-primary)] px-1.5 text-[10px] text-[var(--color-on-primary)]">{activeFilterCount}</span>
              )}
            </button>
          </>
        )}
      </div>

      {governed && filtersOpen && (
        <div
          id="admin-user-filters"
          data-testid="admin-user-filters"
          className="grid grid-cols-2 gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-3 sm:grid-cols-3 lg:grid-cols-6"
        >
          <FilterSelect
            label="账号状态"
            value={filters.accountStatus}
            onChange={(v) => updateFilter('accountStatus', v as Filters['accountStatus'])}
            options={[['', '全部'], ['active', '正常'], ['banned', '已封禁']]}
            testId="admin-user-filter-account-status"
          />
          <FilterSelect
            label="角色"
            value={filters.role}
            onChange={(v) => updateFilter('role', v as Filters['role'])}
            options={[['', '全部'], ['user', '用户'], ['merchant', '商家'], ['admin', '管理员']]}
          />
          <FilterSelect
            label="商家状态"
            value={filters.merchantStatus}
            onChange={(v) => updateFilter('merchantStatus', v as Filters['merchantStatus'])}
            options={[['', '全部'], ['pending', '待审核'], ['active', '营业中'], ['suspended', '已停用'], ['rejected', '已驳回']]}
          />
          <FilterSelect
            label="邮箱验证"
            value={filters.emailVerified}
            onChange={(v) => updateFilter('emailVerified', v as Filters['emailVerified'])}
            options={[['', '全部'], ['true', '已验证'], ['false', '未验证']]}
          />
          <label className="text-[11px] font-medium text-[var(--color-text-muted)]">
            注册起
            <input type="date" className="input mt-1 py-1.5 text-xs" value={filters.registeredFrom} onChange={(e) => updateFilter('registeredFrom', e.target.value)} />
          </label>
          <label className="text-[11px] font-medium text-[var(--color-text-muted)]">
            注册止（含当天）
            <input type="date" className="input mt-1 py-1.5 text-xs" value={filters.registeredTo} onChange={(e) => updateFilter('registeredTo', e.target.value)} />
          </label>
          {activeFilterCount > 0 && (
            <div className="col-span-full flex justify-end">
              <button
                type="button"
                className="text-xs font-semibold text-[var(--color-primary)] hover:underline cursor-pointer"
                onClick={() => {
                  setFilters((f) => ({ ...EMPTY_FILTERS, sort: f.sort }))
                  setPage(1)
                }}
              >
                清除筛选
              </button>
            </div>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        {loading && users.length === 0 ? (
          <TableSkeleton />
        ) : (
        <table className="admin-table table-cards" data-testid="admin-user-table">
          <thead>
            {governed ? (
              <tr>
                <th>用户</th>
                <th>状态</th>
                <th>注册 / 最近登录</th>
                <th>订单 / 净消费</th>
                <th>积分</th>
                <th className="text-right">操作</th>
              </tr>
            ) : (
              <tr>
                <th>UID / 邮箱</th>
                <th>注册时间</th>
                <th>当前积分</th>
                <th>状态</th>
                <th className="text-right">操作</th>
              </tr>
            )}
          </thead>
          <tbody>
            {users.map((u) => {
              const banned = isBanned(u)
              const actions = (
                <td className="text-right space-x-2 whitespace-nowrap" data-label="操作">
                  {canDetail && (
                    <button type="button" className="btn-tonal" onClick={() => setDetailUser({ id: u.id })} data-testid={`admin-user-detail-${u.id}`}>
                      详情
                    </button>
                  )}
                  {canBan && !banned && u.role !== 'admin' && (
                    <button
                      disabled={u.id === currentUser?.id}
                      onClick={() => openBan(u)}
                      className="text-[var(--color-danger)] hover:bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[color-mix(in_srgb,var(--color-danger)_25%,transparent)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      封禁
                    </button>
                  )}
                  {canBan && banned && u.role !== 'admin' && (
                    <button
                      onClick={() => openUnban(u)}
                      className="text-[var(--color-primary)] hover:bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[color-mix(in_srgb,var(--color-primary)_25%,transparent)] cursor-pointer"
                    >
                      解封
                    </button>
                  )}
                  {canAdjust && (
                    <button
                      onClick={() => {
                        setAdjustTarget(u)
                        setAdjustType('add')
                        setAdjustAmount('')
                        setAdjustReason('')
                        adjustKeyRef.current = newIdempotencyKey()
                        setShowAdjust(true)
                      }}
                      className="text-[var(--color-primary)] hover:bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[color-mix(in_srgb,var(--color-primary)_25%,transparent)] cursor-pointer"
                    >
                      调整积分
                    </button>
                  )}
                </td>
              )

              if (!governed) {
                return (
                  <tr key={u.id}>
                    <td data-label="UID / 邮箱">
                      <div className="font-bold text-[var(--color-text)] flex items-center gap-1.5">
                        U{u.id}
                        {u.role === 'admin' && (
                          <span className="text-xs bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] text-[var(--color-primary)] border border-[color-mix(in_srgb,var(--color-primary)_25%,transparent)] px-1.5 py-0.5 rounded font-medium">管理员</span>
                        )}
                      </div>
                      <div className="text-xs text-[var(--color-text-muted)] mt-1">{u.email}</div>
                    </td>
                    <td className="text-[var(--color-text-muted)] text-sm" data-label="注册时间">{new Date(u.createdAt).toLocaleDateString()}</td>
                    <td className="font-bold text-[var(--color-cta)]" data-label="当前积分">{u.pointAccount?.balance ?? 0}</td>
                    <td data-label="状态">
                      <span className={`inline-flex items-center px-2.5 py-1 text-xs rounded font-bold border ${
                        !banned
                          ? 'bg-[color-mix(in_srgb,var(--color-cta)_10%,transparent)] text-[var(--color-cta)] border-[color-mix(in_srgb,var(--color-cta)_25%,transparent)]'
                          : 'bg-red-500/10 text-red-500 border-red-500/25'
                      }`}>
                        {u.status}
                      </span>
                    </td>
                    {actions}
                  </tr>
                )
              }

              const initial = (u.nickname || u.email).trim().charAt(0).toUpperCase()
              const merchant = u.merchantStatus ? merchantStatusLabel(u.merchantStatus) : null
              return (
                <tr key={u.id} data-testid={`admin-user-row-${u.id}`}>
                  <td data-label="用户">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--color-primary-tint)] text-xs font-bold text-[var(--color-primary)]">
                        {initial}
                      </span>
                      <div className="min-w-0">
                        <button
                          type="button"
                          disabled={!canDetail}
                          onClick={() => setDetailUser({ id: u.id })}
                          className="flex max-w-full items-center gap-1.5 text-left font-semibold text-[var(--color-text)] enabled:hover:text-[var(--color-primary)] enabled:cursor-pointer"
                        >
                          <span className="truncate">{u.nickname || u.email}</span>
                          {u.role && u.role !== 'user' && <StatusChip status={roleLabel(u.role)} />}
                        </button>
                        <div className="truncate text-xs text-[var(--color-text-muted)]">
                          <span className="font-mono">U{u.id}</span>{u.nickname ? ` · ${u.email}` : ''}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td data-label="状态">
                    <div className="flex flex-wrap items-center gap-1">
                      <StatusChip status={accountStatusLabel(u.accountStatus)} testId={`admin-user-status-${u.id}`} />
                      {merchant && <StatusChip status={{ ...merchant, label: `商家·${merchant.label}` }} />}
                    </div>
                    {!u.emailVerified && <div className="mt-1 text-[11px] text-[var(--color-warning-text)]">邮箱未验证</div>}
                  </td>
                  <td className="text-xs" data-label="注册 / 最近登录">
                    <div className="text-[var(--color-text)]">{new Date(u.createdAt).toLocaleDateString('zh-CN')}</div>
                    <div className="text-[var(--color-text-muted)]" title="最近一次成功登录">
                      {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : '登录时间未知'}
                    </div>
                  </td>
                  <td className="text-xs tabular-nums" data-label="订单 / 净消费">
                    <div className="text-[var(--color-text)]">{u.orderCount ?? 0} 单</div>
                    <div className="flex items-center gap-1 text-[var(--color-text-muted)]">
                      {(u.netSpentPoints ?? 0).toLocaleString('en-US')} 积分
                      {u.legacyCompleteness && u.legacyCompleteness !== 'complete' && (
                        <AlertTriangle className="h-3 w-3 text-[var(--color-warning)]" aria-label="含历史统计缺口" />
                      )}
                    </div>
                  </td>
                  <td className="font-bold tabular-nums text-[var(--color-points)]" data-label="积分">
                    {u.pointAccount ? u.pointAccount.balance.toLocaleString('en-US') : <span className="font-normal text-[var(--color-text-muted)]">—</span>}
                  </td>
                  {actions}
                </tr>
              )
            })}
            {!loading && users.length === 0 && (
              <tr>
                <td colSpan={colCount}>
                  {loadError ? (
                    <EmptyState compact icon={UsersRound} title="加载失败" description={loadError} />
                  ) : (
                    <EmptyState compact icon={UsersRound} title="暂无用户" description="调整搜索条件试试" />
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        )}
      </div>

      <AdminPagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} testId="admin-user-pagination" />

      {canDetail && (
        <UserDetailSheet
          userId={detailUser?.id ?? null}
          initialTab={detailUser?.tab}
          onOpenChange={(o) => { if (!o) setDetailUser(null) }}
          onChanged={refresh}
        />
      )}

      {structuredBans && (
        <BanUserDialog
          target={structuredBanTarget}
          onOpenChange={(o) => { if (!o) setStructuredBanTarget(null) }}
          onBanned={() => {
            setStructuredBanTarget(null)
            showToast('已封禁该账号')
            refresh()
          }}
        />
      )}

      {/* Ban User Modal (legacy backend) */}
      <Dialog open={showBan && !!banTarget} onOpenChange={(o) => { if (!o) setShowBan(false) }}>
        <DialogContent className="max-w-sm">
          <DialogTitle className="text-xl mb-5">封禁用户</DialogTitle>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">目标用户</label>
              <input
                type="text"
                disabled
                value={banTarget ? `U${banTarget.id} (${banTarget.email})` : ''}
                className="input bg-[var(--color-background)] text-[var(--color-text-muted)] cursor-not-allowed"
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
            <button
              onClick={confirmBan}
              disabled={banning}
              className="btn-primary w-full mt-2 bg-[var(--color-danger)] hover:opacity-90 border-[var(--color-danger)] text-white shadow-md"
            >
              {banning ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {banning ? '执行中…' : '确认封禁'}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Adjust Points Modal */}
      <Dialog open={showAdjust && !!adjustTarget} onOpenChange={(o) => { if (!o) setShowAdjust(false) }}>
        <DialogContent className="max-w-sm">
          <DialogTitle className="text-xl mb-4">调整用户积分</DialogTitle>
          <div className="space-y-4">
              <div>
                <span className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">
                  目标用户
                </span>
                <div className="p-3 bg-[var(--color-background)] rounded-lg border border-[var(--color-border)] text-sm space-y-1">
                  <div className="font-bold text-[var(--color-text)]">
                    用户编号：U{adjustTarget?.id} {adjustTarget?.email ? `(${adjustTarget.email})` : ''}
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)]">
                    当前可用积分：<span className="font-bold text-[var(--color-cta)]">{adjustTarget?.pointAccount?.balance ?? 0}</span> 积分
                  </div>
                </div>
              </div>

              <div>
                <span className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">
                  调整方向
                </span>
                <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="调整方向">
                  {(['add', 'deduct'] as const).map((t) => (
                    <label
                      key={t}
                      className={`flex items-center gap-2 p-2.5 border rounded-lg cursor-pointer transition-colors hover:bg-[var(--color-background)] ${
                        adjustType === t
                          ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_5%,transparent)] ring-1 ring-[var(--color-primary)]'
                          : 'border-[var(--color-border)]'
                      }`}
                    >
                      <input
                        type="radio"
                        name="adjust-points-type"
                        checked={adjustType === t}
                        onChange={() => setAdjustType(t)}
                        className="accent-[var(--color-primary)]"
                      />
                      <span className={`font-bold text-sm ${t === 'add' ? 'text-[var(--color-cta)]' : 'text-[var(--color-danger)]'}`}>
                        {t === 'add' ? '增加积分 (+)' : '扣除积分 (-)'}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label htmlFor="adjust-points-amount" className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">
                  调整积分数（正整数）
                </label>
                <input
                  id="adjust-points-amount"
                  type="number"
                  min="1"
                  max={MAX_ADJUST_POINTS}
                  step="1"
                  value={adjustAmount}
                  onChange={(e) => setAdjustAmount(e.target.value)}
                  placeholder="请输入正整数积分"
                  className="input"
                />
              </div>

              <div>
                <label htmlFor="adjust-points-reason" className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">
                  调整原因（用户可见）
                </label>
                <input
                  id="adjust-points-reason"
                  type="text"
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  placeholder="例如：参与活动奖励"
                  aria-describedby="adjust-points-reason-hint"
                  className="input"
                />
                <p id="adjust-points-reason-hint" className="text-xs text-[var(--color-text-muted)] mt-1">
                  将显示在该用户的积分明细中，请填写可向用户解释的原因，勿填内部排障信息。
                </p>
              </div>

              <button
                type="button"
                onClick={confirmAdjust}
                disabled={adjusting}
                className="btn-primary w-full mt-2"
              >
                {adjusting ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
                {adjusting
                  ? '提交中…'
                  : adjustType === 'add'
                    ? '确认增加积分'
                    : '确认扣除积分'}
              </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Unban confirm (legacy backend) — replaces window.confirm */}
      <ConfirmDialog
        open={unbanTarget !== null}
        onOpenChange={(o) => { if (!o) setUnbanTarget(null) }}
        title="解封用户"
        description="确定要解封该用户吗？解封后其将恢复正常访问。"
        confirmLabel="解封"
        tone="primary"
        loading={unbanning}
        onConfirm={confirmUnban}
      />
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  testId,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<[string, string]>
  testId?: string
}) {
  return (
    <label className="text-[11px] font-medium text-[var(--color-text-muted)]">
      {label}
      <select className="input mt-1 py-1.5 text-xs" value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  )
}
