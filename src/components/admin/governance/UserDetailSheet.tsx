import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2, RefreshCw, ShieldBan } from 'lucide-react'
import SideSheet from '../../ui/SideSheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/Tabs'
import {
  getAdminUserDetail,
  listUserAudit,
  listUserBans,
  listUserOrders,
  listUserPointLogs,
  listUserReferrals,
  listUserSecurityEvents,
  listUserSessions,
} from '../../../api/governance'
import { useCursorList, type CursorFetcher } from '../../../hooks/useCursorList'
import { useAdminCapabilities } from '../../../stores/adminCapabilities'
import { useAppStore } from '../../../stores/appStore'
import { useAuthStore } from '../../../stores/authStore'
import type {
  GVAuditSummary,
  GVBan,
  GVPointLog,
  GVReferral,
  GVSecurityEvent,
  GVSession,
  GVUserDetail,
  GVUserOrder,
} from '../../../types/governance'
import {
  accountStatusLabel,
  classifyGovernanceError,
  completenessLabel,
  formatDateTime,
  formatOrderRef,
  merchantStatusLabel,
  pointOriginLabel,
  roleLabel,
  shopOrderStatusLabel,
} from '../../../utils/governance'
import { BanUserDialog, ReleaseBanDialog, banReasonLabel } from './BanDialogs'
import { ExportButton } from './Exports'
import AdminAuthorizationEditor from './AdminAuthorizationEditor'
import { AuditDetailInline } from './AuditDetail'
import {
  FactGrid,
  ForbiddenNotice,
  LoadMore,
  Notice,
  Section,
  StatusChip,
} from './GovernanceKit'

type TabId = 'orders' | 'pointLogs' | 'sessions' | 'referrals' | 'securityEvents' | 'audit' | 'bans' | 'authorization'

const TAB_LABEL: Record<TabId, string> = {
  orders: '订单',
  pointLogs: '积分流水',
  sessions: '登录会话',
  referrals: '邀请',
  securityEvents: '安全事件',
  audit: '操作记录',
  bans: '封禁记录',
  authorization: '后台权限',
}

interface Props {
  userId: number | null
  initialTab?: TabId
  onOpenChange: (open: boolean) => void
  /** Called after a ban/release so the list reflects the new status. */
  onChanged?: () => void
}

export default function UserDetailSheet({ userId, initialTab, onOpenChange, onChanged }: Props) {
  const caps = useAdminCapabilities()
  const currentAdminId = useAuthStore((s) => s.user?.id)
  const showToast = useAppStore((s) => s.showToast)
  const [detail, setDetail] = useState<GVUserDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [tab, setTab] = useState<TabId | null>(null)
  const [banTarget, setBanTarget] = useState<{ id: number; email: string } | null>(null)
  const [releaseTarget, setReleaseTarget] = useState<GVBan | null>(null)
  const [bansVersion, setBansVersion] = useState(0)
  const controllerRef = useRef<AbortController | null>(null)

  const load = useCallback((id: number) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    setError(null)
    getAdminUserDetail(id, controller.signal)
      .then((next) => {
        // Aborting on every user switch keeps a late response for user A out of user B's view.
        if (controller.signal.aborted) return
        setDetail(next)
        setForbidden(false)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        const f = classifyGovernanceError(err, '加载用户详情失败')
        if (f.kind === 'forbidden') setForbidden(true)
        else setError(f.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
  }, [])

  useEffect(() => {
    setDetail(null)
    setForbidden(false)
    setError(null)
    setTab(null)
    if (userId !== null) load(userId)
    return () => controllerRef.current?.abort()
  }, [userId, load])

  const canBan = caps.allows('accountBans', 'users.ban')
  const tabs: TabId[] = detail
    ? ([
        detail.sections.orders && 'orders',
        detail.sections.pointLogs && 'pointLogs',
        detail.sections.sessions && 'sessions',
        detail.sections.referrals && 'referrals',
        detail.sections.securityEvents && 'securityEvents',
        detail.sections.audit && 'audit',
        canBan && 'bans',
        detail.user.role === 'admin' && caps.can('admin.permissions.manage') && 'authorization',
      ].filter(Boolean) as TabId[])
    : []
  const activeTab = tab && tabs.includes(tab) ? tab : initialTab && tabs.includes(initialTab) ? initialTab : tabs[0] ?? null

  const user = detail?.user
  const activeBan = detail?.ban && detail.ban.effective ? detail.ban : null
  const canIssueBan = Boolean(
    user && canBan && user.accountStatus === 'active' && user.role !== 'admin' && user.id !== currentAdminId,
  )

  return (
    <>
      <SideSheet
        open={userId !== null}
        onOpenChange={onOpenChange}
        testId="user-detail-sheet"
        title={user ? user.nickname || user.email : `用户 U${userId ?? ''}`}
        description={user ? <span><span className="font-mono">U{user.id}</span>{user.nickname ? ` · ${user.email}` : ''}</span> : '读取中…'}
        meta={
          <>
            {user && <StatusChip status={accountStatusLabel(user.accountStatus)} testId="user-detail-account-status" />}
            <button
              type="button"
              aria-label="刷新"
              disabled={userId === null || loading}
              onClick={() => userId !== null && load(userId)}
              className="icon-btn rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-border)] cursor-pointer"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </>
        }
        footer={canIssueBan && user ? (
          <div className="flex justify-end">
            <button
              type="button"
              className="btn-tonal !bg-[var(--color-danger-bg)] !text-[var(--color-danger-text)]"
              onClick={() => setBanTarget({ id: user.id, email: user.email })}
              data-testid="user-detail-ban"
            >
              <ShieldBan className="h-3.5 w-3.5" aria-hidden="true" />封禁账号
            </button>
          </div>
        ) : undefined}
      >
        {forbidden ? (
          <ForbiddenNotice what="用户详情" />
        ) : !detail ? (
          loading ? (
            <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />读取用户资料…</div>
          ) : error ? (
            <Notice tone="danger" role="alert" title="加载用户详情失败">{error}</Notice>
          ) : null
        ) : (
          <div className="space-y-6">
            {activeBan && (
              <Notice
                tone="danger"
                title={activeBan.expiresAt ? `封禁中，${formatDateTime(activeBan.expiresAt)} 到期` : '永久封禁中'}
                testId="user-detail-active-ban"
                action={canBan && (
                  <button type="button" className="btn-tonal" onClick={() => setReleaseTarget(activeBan)} data-testid="user-detail-release-ban">
                    解封
                  </button>
                )}
              >
                {activeBan.reason ?? '未记录理由（历史封禁）'} · {banReasonLabel(activeBan.reasonCode)}
                {activeBan.source === 'legacy' && ' · 来自旧版封禁，操作人与开始时间可能未知'}
                {activeBan.createdByUserId !== null && ` · 操作人 U${activeBan.createdByUserId}`}
              </Notice>
            )}

            <Section title="账户">
              <FactGrid
                items={[
                  { label: '角色', value: <StatusChip status={roleLabel(detail.user.role)} /> },
                  {
                    label: '商家',
                    value: detail.merchant
                      ? <span className="inline-flex items-center gap-1.5 min-w-0"><span className="truncate">{detail.merchant.name}</span><StatusChip status={merchantStatusLabel(detail.merchant.status)} /></span>
                      : '未入驻',
                  },
                  { label: '邮箱验证', value: detail.user.emailVerified ? formatDateTime(detail.user.emailVerified) : '未验证' },
                  { label: '注册时间', value: formatDateTime(detail.user.createdAt) },
                  { label: '最近成功登录', value: formatDateTime(detail.activity.lastLoginAt), hint: '成功登录的时刻；未知表示没有可靠记录' },
                  { label: '会话最近使用', value: formatDateTime(detail.activity.lastSessionUsedAt), hint: '任一会话最近一次刷新使用的时刻' },
                  { label: '最近活跃日', value: detail.activity.lastActiveDay ?? '未知', hint: '仅精确到自然日' },
                  { label: '邀请人', value: detail.invites.inviterUserId !== null ? <span className="font-mono">U{detail.invites.inviterUserId}</span> : '无' },
                  { label: '已邀请', value: `${detail.invites.inviteeCount} 人` },
                ]}
              />
            </Section>

            <div className="grid gap-4 md:grid-cols-2">
              <WalletCard detail={detail} />
              <StatsCard detail={detail} />
            </div>

            {tabs.length > 0 && activeTab && (
              <Tabs value={activeTab} onValueChange={(v) => setTab(v as TabId)}>
                <div className="-mx-1 overflow-x-auto hide-scrollbar px-1">
                  <TabsList className="!justify-start">
                    {tabs.map((t) => (
                      <TabsTrigger key={t} value={t} data-testid={`user-detail-tab-${t}`}>{TAB_LABEL[t]}</TabsTrigger>
                    ))}
                  </TabsList>
                </div>
                {/* Radix unmounts inactive panels, so each section fetches only when opened. */}
                <TabsContent value="orders"><OrdersSection userId={detail.user.id} /></TabsContent>
                <TabsContent value="pointLogs"><PointLogsSection userId={detail.user.id} /></TabsContent>
                <TabsContent value="sessions"><SessionsSection userId={detail.user.id} /></TabsContent>
                <TabsContent value="referrals"><ReferralsSection userId={detail.user.id} /></TabsContent>
                <TabsContent value="securityEvents"><SecurityEventsSection userId={detail.user.id} /></TabsContent>
                <TabsContent value="audit"><AuditSection userId={detail.user.id} /></TabsContent>
                <TabsContent value="bans">
                  <BansSection userId={detail.user.id} version={bansVersion} onRelease={setReleaseTarget} />
                </TabsContent>
                <TabsContent value="authorization"><AdminAuthorizationEditor userId={detail.user.id} /></TabsContent>
              </Tabs>
            )}
            <p className="text-[11px] text-[var(--color-text-muted)]">数据截至 {formatDateTime(detail.asOf)}</p>
          </div>
        )}
      </SideSheet>

      <BanUserDialog
        target={banTarget}
        onOpenChange={(o) => { if (!o) setBanTarget(null) }}
        onBanned={() => {
          setBanTarget(null)
          showToast('已封禁该账号')
          setBansVersion((v) => v + 1)
          if (userId !== null) load(userId)
          onChanged?.()
        }}
      />
      <ReleaseBanDialog
        ban={releaseTarget}
        onOpenChange={(o) => { if (!o) setReleaseTarget(null) }}
        onReleased={() => {
          setReleaseTarget(null)
          showToast('已解除封禁，用户需要重新登录')
          setBansVersion((v) => v + 1)
          if (userId !== null) load(userId)
          onChanged?.()
        }}
        onConflict={() => {
          setReleaseTarget(null)
          showToast('封禁记录已被他人处理，已刷新为最新状态', 'error')
          setBansVersion((v) => v + 1)
          if (userId !== null) load(userId)
        }}
      />
    </>
  )
}

function WalletCard({ detail }: { detail: GVUserDetail }) {
  const wallet = detail.wallet
  return (
    <div className="rounded-xl border border-[var(--color-border)] p-4" data-testid="user-detail-wallet">
      <div className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">积分账户</div>
      {!wallet ? (
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">你没有积分查看权限，余额不在此显示。</p>
      ) : (
        <>
          <div className="mt-2 flex items-baseline gap-3">
            <span className="text-2xl font-bold tabular-nums text-[var(--color-points)]">{wallet.balance.toLocaleString('en-US')}</span>
            <span className="text-xs text-[var(--color-text-muted)]">可用</span>
            {wallet.frozenBalance > 0 && (
              <span className="text-xs text-[var(--color-text-muted)]">冻结 {wallet.frozenBalance.toLocaleString('en-US')}</span>
            )}
          </div>
          {wallet.sources.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {wallet.sources.map((s) => (
                <li key={s.origin} className="flex items-center justify-between gap-2 text-xs">
                  <StatusChip status={pointOriginLabel(s.origin)} />
                  <span className="tabular-nums text-[var(--color-text)]">
                    {s.availablePoints.toLocaleString('en-US')}
                    {s.frozenPoints > 0 && <span className="text-[var(--color-text-muted)]"> · 冻结 {s.frozenPoints.toLocaleString('en-US')}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

function StatsCard({ detail }: { detail: GVUserDetail }) {
  const stats = detail.stats
  return (
    <div className="rounded-xl border border-[var(--color-border)] p-4" data-testid="user-detail-stats">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">商城消费</span>
        {stats && <StatusChip status={completenessLabel(stats.legacyCompleteness)} testId="user-detail-completeness" />}
      </div>
      {!stats ? (
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">你没有消费统计的查看权限。</p>
      ) : (
        <>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums text-[var(--color-text)]">{stats.netSpentPoints.toLocaleString('en-US')}</span>
            <span className="text-xs text-[var(--color-text-muted)]">净消费积分</span>
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <div><dt className="text-[var(--color-text-muted)]">订单</dt><dd className="font-semibold tabular-nums">{stats.orderCount}</dd></div>
            <div><dt className="text-[var(--color-text-muted)]">扣款</dt><dd className="font-semibold tabular-nums">{stats.chargedPoints.toLocaleString('en-US')}</dd></div>
            <div><dt className="text-[var(--color-text-muted)]">已退回</dt><dd className="font-semibold tabular-nums">{stats.refundedPoints.toLocaleString('en-US')}</dd></div>
          </dl>
          {stats.legacyCompleteness !== 'complete' && (
            <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">部分历史订单缺少售后记录，以上为可证明部分的统计。</p>
          )}
        </>
      )}
    </div>
  )
}

// ── Sections ─────────────────────────────────────────────────────────────

function SectionList<T>({
  sectionKey,
  fetcher,
  what,
  empty,
  toolbar,
  render,
}: {
  sectionKey: string
  fetcher: CursorFetcher<T>
  what: string
  empty: string
  toolbar?: ReactNode
  render: (items: T[]) => ReactNode
}) {
  const list = useCursorList(sectionKey, fetcher)
  if (list.forbidden) return <ForbiddenNotice what={what} />
  return (
    <div className="space-y-3">
      {toolbar && <div className="flex justify-end">{toolbar}</div>}
      {list.error && <Notice tone="danger" role="alert" title={`加载${what}失败`} action={<button type="button" className="btn-tonal" onClick={list.reload}>重试</button>}>{list.error}</Notice>}
      {list.loading && list.items.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />加载中…</div>
      ) : !list.error && list.items.length === 0 ? (
        <p className="py-4 text-center text-xs text-[var(--color-text-muted)]">{empty}</p>
      ) : (
        render(list.items)
      )}
      <LoadMore hasNextPage={list.hasNextPage} loadingMore={list.loadingMore} onLoadMore={list.loadMore} />
    </div>
  )
}

const ROW = 'flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2.5'

function OrdersSection({ userId }: { userId: number }) {
  return (
    <SectionList<GVUserOrder>
      sectionKey={`orders:${userId}`}
      fetcher={({ cursor, signal }) => listUserOrders(userId, { cursor, signal })}
      what="订单"
      empty="没有商城订单"
      toolbar={<ExportButton kind="orders" filters={{ userId }} label="导出该用户订单" />}
      render={(items) => (
        <ul className="space-y-2" data-testid="user-detail-orders">
          {items.map((o) => (
            <li key={o.id} className={ROW}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-[var(--color-text)]" title={`订单 ID ${o.id}`}>{formatOrderRef(o.orderNo, o.id)}</span>
                  <StatusChip status={shopOrderStatusLabel(o.status)} />
                </div>
                <div className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">{o.productName} · {formatDateTime(o.createdAt)}</div>
              </div>
              <div className="shrink-0 text-right text-xs tabular-nums">
                <div className="font-semibold text-[var(--color-text)]">-{o.chargedPoints.toLocaleString('en-US')}</div>
                {o.refundedPoints > 0 && <div className="text-[var(--color-success-text)]">退回 {o.refundedPoints.toLocaleString('en-US')}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
    />
  )
}

function PointLogsSection({ userId }: { userId: number }) {
  return (
    <SectionList<GVPointLog>
      sectionKey={`pointLogs:${userId}`}
      fetcher={({ cursor, signal }) => listUserPointLogs(userId, { cursor, signal })}
      what="积分流水"
      empty="没有积分流水"
      toolbar={<ExportButton kind="point_logs" filters={{ userId }} label="导出该用户流水" />}
      render={(items) => (
        <ul className="space-y-2" data-testid="user-detail-point-logs">
          {items.map((l) => (
            <li key={l.id} className={ROW}>
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-semibold text-[var(--color-text)]">{l.reason || l.type}</span>
                  {l.origin && <StatusChip status={pointOriginLabel(l.origin)} />}
                </div>
                <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                  {formatDateTime(l.createdAt)}
                  {l.orderId !== null && ` · 订单 #${l.orderId}`}
                  {l.operationId !== null && ` · 凭证 ${l.operationId}`}
                </div>
              </div>
              <div className="shrink-0 text-right text-xs tabular-nums">
                <div className={`font-semibold ${l.amount >= 0 ? 'text-[var(--color-success-text)]' : 'text-[var(--color-danger-text)]'}`}>
                  {l.amount >= 0 ? '+' : ''}{l.amount.toLocaleString('en-US')}
                </div>
                <div className="text-[var(--color-text-muted)]">余额 {l.balanceAfter.toLocaleString('en-US')}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    />
  )
}

function SessionsSection({ userId }: { userId: number }) {
  return (
    <SectionList<GVSession>
      sectionKey={`sessions:${userId}`}
      fetcher={({ cursor, signal }) => listUserSessions(userId, { cursor, signal })}
      what="登录会话"
      empty="没有登录会话"
      render={(items) => (
        <ul className="space-y-2" data-testid="user-detail-sessions">
          {items.map((s) => (
            <li key={s.id} className={ROW}>
              <div className="min-w-0 text-xs">
                <div className="font-semibold text-[var(--color-text)]">{s.deviceName || '未知设备'}</div>
                <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                  创建 {formatDateTime(s.createdAt)} · 最近使用 {formatDateTime(s.lastUsedAt)}
                </div>
              </div>
              <StatusChip
                status={s.revoked
                  ? { label: '已撤销', tone: 'neutral' }
                  : Date.parse(s.expiresAt) <= Date.now()
                    ? { label: '已过期', tone: 'neutral' }
                    : { label: '有效', tone: 'success' }}
              />
            </li>
          ))}
        </ul>
      )}
    />
  )
}

function ReferralsSection({ userId }: { userId: number }) {
  return (
    <SectionList<GVReferral>
      sectionKey={`referrals:${userId}`}
      fetcher={({ cursor, signal }) => listUserReferrals(userId, { cursor, signal })}
      what="邀请关系"
      empty="没有邀请关系"
      render={(items) => (
        <ul className="space-y-2" data-testid="user-detail-referrals">
          {items.map((r) => (
            <li key={r.id} className={ROW}>
              <div className="text-xs">
                <span className="font-semibold">{r.inviterUserId === userId ? `邀请了 U${r.inviteeUserId}` : `由 U${r.inviterUserId} 邀请`}</span>
                <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{formatDateTime(r.createdAt)}</div>
              </div>
              <span className="text-[11px] text-[var(--color-text-muted)]">{r.status}</span>
            </li>
          ))}
        </ul>
      )}
    />
  )
}

function SecurityEventsSection({ userId }: { userId: number }) {
  return (
    <SectionList<GVSecurityEvent>
      sectionKey={`security:${userId}`}
      fetcher={({ cursor, signal }) => listUserSecurityEvents(userId, { cursor, signal })}
      what="安全事件"
      empty="没有安全事件"
      render={(items) => (
        <ul className="space-y-2" data-testid="user-detail-security-events">
          {items.map((e) => (
            <li key={e.id} className={ROW}>
              <code className="text-xs text-[var(--color-text)]">{e.type}</code>
              <span className="text-[11px] text-[var(--color-text-muted)]">{formatDateTime(e.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    />
  )
}

function AuditSection({ userId }: { userId: number }) {
  const caps = useAdminCapabilities()
  const [openId, setOpenId] = useState<number | null>(null)
  return (
    <SectionList<GVAuditSummary>
      sectionKey={`audit:${userId}`}
      fetcher={({ cursor, signal }) => listUserAudit(userId, { cursor, signal })}
      what="操作记录"
      empty="没有与该用户相关的后台操作"
      render={(items) => (
        <ul className="space-y-2" data-testid="user-detail-audit">
          {items.map((a) => (
            <li key={a.id} className="rounded-lg border border-[var(--color-border)] px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 text-xs">
                  <div className="font-semibold text-[var(--color-text)]">{a.action}</div>
                  <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                    U{a.adminId} · {formatDateTime(a.createdAt)}{a.actionCode && <> · <code>{a.actionCode}</code></>}
                  </div>
                </div>
                {caps.can('audit.details.read') && (
                  <button type="button" className="btn-tonal" onClick={() => setOpenId(openId === a.id ? null : a.id)} aria-expanded={openId === a.id}>
                    {openId === a.id ? '收起' : '详情'}
                  </button>
                )}
              </div>
              {openId === a.id && <AuditDetailInline id={a.id} />}
            </li>
          ))}
        </ul>
      )}
    />
  )
}

function BansSection({ userId, version, onRelease }: { userId: number; version: number; onRelease: (ban: GVBan) => void }) {
  return (
    <SectionList<GVBan>
      sectionKey={`bans:${userId}:${version}`}
      fetcher={({ cursor, signal }) => listUserBans(userId, { cursor, signal })}
      what="封禁记录"
      empty="没有封禁记录"
      render={(items) => (
        <ul className="space-y-2" data-testid="user-detail-bans">
          {items.map((b) => (
            <li key={b.id} className="rounded-lg border border-[var(--color-border)] px-3 py-2.5 text-xs">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <StatusChip
                    status={b.effective
                      ? { label: '生效中', tone: 'danger' }
                      : b.releasedAt
                        ? { label: '已解除', tone: 'neutral' }
                        : { label: '已到期', tone: 'neutral' }}
                  />
                  <span className="font-semibold text-[var(--color-text)]">{b.reason ?? '未记录理由'}</span>
                </div>
                {b.effective && (
                  <button type="button" className="btn-tonal" onClick={() => onRelease(b)}>解封</button>
                )}
              </div>
              <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                {banReasonLabel(b.reasonCode)} · 开始 {formatDateTime(b.startsAt)} · {b.expiresAt ? `到期 ${formatDateTime(b.expiresAt)}` : '永久'}
                {b.createdByUserId !== null ? ` · 操作人 U${b.createdByUserId}` : b.source === 'legacy' ? ' · 历史封禁，操作人未知' : ''}
              </div>
              {b.releasedAt && (
                <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                  {formatDateTime(b.releasedAt)} 由 {b.releasedByUserId !== null ? `U${b.releasedByUserId}` : '系统'} 解除：{b.releaseReason ?? '—'}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    />
  )
}
