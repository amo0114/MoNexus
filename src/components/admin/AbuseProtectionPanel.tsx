import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw, ShieldAlert } from 'lucide-react'
import {
  getAdminAbuseOverview,
  listAdminAbuseReferrals,
  listAdminAbuseRewards,
  setAdminReferralSuspension,
  voidAdminAbuseReward,
  type AdminAbuseOverview,
  type AdminAbuseReferral,
  type AdminAbuseReferralState,
  type AdminAbuseReward,
  type AdminAbuseRewardState,
  type AdminAbuseWindow,
} from '../../api/adminAbuse'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import EmptyState from '../ui/EmptyState'
import { TableSkeleton } from '../ui/Skeleton'

const PAGE_SIZE = 20
const CASE_REF_PATTERN = /^[A-Z][A-Z0-9_]{1,15}-[0-9]{1,12}$/

type PendingAction =
  | { type: 'referral'; userId: number; email: string; suspended: boolean }
  | { type: 'reward'; rewardId: number; amount: number; rewardKind: string }

function dateLabel(value: string | null) {
  return value ? new Date(value).toLocaleString() : '—'
}

function StatePill({ state }: { state: string }) {
  const tone = state === 'granted' || state === 'qualified'
    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    : state === 'held' || state === 'pending_verification'
      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
      : state === 'voided' || state === 'quota_exhausted'
        ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300'
        : 'bg-[var(--color-border)]/60 text-[var(--color-text-muted)]'
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${tone}`}>{state}</span>
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)]/60 p-3 min-w-0">
      <p className="text-xs text-[var(--color-text-muted)] truncate">{label}</p>
      <p className="mt-1 text-xl font-bold text-[var(--color-text)] tabular-nums">{value.toLocaleString()}</p>
    </div>
  )
}

function Pagination({
  page,
  total,
  onChange,
}: {
  page: number
  total: number
  onChange: (page: number) => void
}) {
  if (total <= PAGE_SIZE) return null
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-3 text-sm">
      <span className="text-[var(--color-text-muted)]">共 {total} 条</span>
      <div className="flex gap-2">
        <button
          type="button"
          className="btn-secondary min-h-10 px-3 text-sm"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          上一页
        </button>
        <span className="inline-flex min-h-10 items-center text-[var(--color-text-muted)]">{page} / {pages}</span>
        <button
          type="button"
          className="btn-secondary min-h-10 px-3 text-sm"
          disabled={page >= pages}
          onClick={() => onChange(page + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  )
}

/**
 * Isolated administration UI for registration-abuse operations. It does not
 * touch the AdminPage navigation/safe-area shell; all data comes from the
 * MFA-protected abuse API, which deliberately returns only masked emails.
 */
export default function AbuseProtectionPanel() {
  const showToast = useAppStore(s => s.showToast)
  const [window, setWindow] = useState<AdminAbuseWindow>('24h')
  const [overview, setOverview] = useState<AdminAbuseOverview | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(true)

  const [referrals, setReferrals] = useState<AdminAbuseReferral[]>([])
  const [referralTotal, setReferralTotal] = useState(0)
  const [referralPage, setReferralPage] = useState(1)
  const [referralState, setReferralState] = useState<AdminAbuseReferralState | ''>('')
  const [referralQueryDraft, setReferralQueryDraft] = useState('')
  const [referralQuery, setReferralQuery] = useState('')
  const [referralsLoading, setReferralsLoading] = useState(true)

  const [rewards, setRewards] = useState<AdminAbuseReward[]>([])
  const [rewardTotal, setRewardTotal] = useState(0)
  const [rewardPage, setRewardPage] = useState(1)
  const [rewardState, setRewardState] = useState<AdminAbuseRewardState | ''>('')
  const [rewardUserIdDraft, setRewardUserIdDraft] = useState('')
  const [rewardUserId, setRewardUserId] = useState<number | undefined>()
  const [rewardsLoading, setRewardsLoading] = useState(true)

  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [caseRef, setCaseRef] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true)
    try {
      setOverview(await getAdminAbuseOverview(window))
    } catch (error) {
      showToast(getApiErrorMessage(error, '加载风控概览失败'), 'error')
    } finally {
      setOverviewLoading(false)
    }
  }, [showToast, window])

  const loadReferrals = useCallback(async () => {
    setReferralsLoading(true)
    try {
      const data = await listAdminAbuseReferrals({
        page: referralPage,
        pageSize: PAGE_SIZE,
        ...(referralState ? { state: referralState } : {}),
        ...(referralQuery ? { q: referralQuery } : {}),
      })
      setReferrals(data.items)
      setReferralTotal(data.total)
    } catch (error) {
      showToast(getApiErrorMessage(error, '加载邀请资格列表失败'), 'error')
    } finally {
      setReferralsLoading(false)
    }
  }, [referralPage, referralQuery, referralState, showToast])

  const loadRewards = useCallback(async () => {
    setRewardsLoading(true)
    try {
      const data = await listAdminAbuseRewards({
        page: rewardPage,
        pageSize: PAGE_SIZE,
        ...(rewardState ? { state: rewardState } : {}),
        ...(rewardUserId ? { userId: rewardUserId } : {}),
      })
      setRewards(data.items)
      setRewardTotal(data.total)
    } catch (error) {
      showToast(getApiErrorMessage(error, '加载奖励账本失败'), 'error')
    } finally {
      setRewardsLoading(false)
    }
  }, [rewardPage, rewardState, rewardUserId, showToast])

  useEffect(() => { void loadOverview() }, [loadOverview])
  useEffect(() => { void loadReferrals() }, [loadReferrals])
  useEffect(() => { void loadRewards() }, [loadRewards])

  function openAction(action: PendingAction) {
    setPendingAction(action)
    setCaseRef('')
    setConfirmed(false)
  }

  async function refreshAll() {
    await Promise.all([loadOverview(), loadReferrals(), loadRewards()])
  }

  function applyReferralQuery() {
    const next = referralQueryDraft.trim()
    setReferralPage(1)
    if (next === referralQuery && referralPage === 1) void loadReferrals()
    setReferralQuery(next)
  }

  function applyRewardUserFilter() {
    const next = Number(rewardUserIdDraft)
    const normalized = Number.isSafeInteger(next) && next > 0 ? next : undefined
    setRewardPage(1)
    if (normalized === rewardUserId && rewardPage === 1) void loadRewards()
    setRewardUserId(normalized)
  }

  async function submitAction() {
    if (!pendingAction) return
    const normalizedCaseRef = caseRef.trim()
    if (!CASE_REF_PATTERN.test(normalizedCaseRef)) {
      showToast('请输入有效工单编号，例如 RAP-123', 'error')
      return
    }
    if (!confirmed) {
      showToast('请先确认本次风控操作', 'error')
      return
    }

    setActionBusy(true)
    try {
      if (pendingAction.type === 'referral') {
        const result = await setAdminReferralSuspension(pendingAction.userId, {
          suspended: pendingAction.suspended,
          caseRef: normalizedCaseRef,
        })
        showToast(
          result.suspended ? `已暂停邀请码资格，作废 ${result.voidedRewards} 条待发奖励` : '已恢复未来邀请码资格',
          'success',
        )
      } else {
        await voidAdminAbuseReward(pendingAction.rewardId, normalizedCaseRef)
        showToast('已作废未发放奖励', 'success')
      }
      setPendingAction(null)
      await refreshAll()
    } catch (error) {
      showToast(getApiErrorMessage(error, '风控操作失败'), 'error')
    } finally {
      setActionBusy(false)
    }
  }

  const actionTitle = pendingAction?.type === 'referral'
    ? pendingAction.suspended ? '暂停邀请码资格' : '恢复邀请码资格'
    : '作废未发放奖励'
  const actionDescription = pendingAction?.type === 'referral'
    ? pendingAction.suspended
      ? `将停止用户 #${pendingAction.userId} 的未来邀请资格，并作废其仍待发放的邀请码奖励。已发放积分不会被本操作追扣。`
      : `将恢复用户 #${pendingAction.userId} 的未来邀请码资格；此前已作废的奖励不会恢复。`
    : pendingAction
      ? `确认作废奖励 #${pendingAction.rewardId}（${pendingAction.amount} 积分）？这不会变更积分余额；已发放奖励不可通过此界面作废。`
      : ''

  return (
    <section className="space-y-6" aria-label="注册反滥用运营面板">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">注册与激励风控</h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">仅展示脱敏标识。暂停与作废都必须记录工单编号。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input min-h-10 w-auto py-2"
            value={window}
            onChange={event => setWindow(event.target.value as AdminAbuseWindow)}
            aria-label="概览时间窗口"
          >
            <option value="1h">最近 1 小时</option>
            <option value="24h">最近 24 小时</option>
          </select>
          <button type="button" className="btn-secondary min-h-10 px-3 text-sm" onClick={() => void refreshAll()}>
            <RefreshCw className="mr-1.5 h-4 w-4" />刷新
          </button>
        </div>
      </div>

      {overviewLoading && !overview ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => <div className="h-20 animate-pulse rounded-lg bg-[var(--color-border)]/50" key={index} />)}
        </div>
      ) : overview ? (
        <div className="space-y-3">
          <p className="text-xs text-[var(--color-text-muted)]">统计起点：{dateLabel(overview.since)}</p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="注册尝试" value={overview.registrations.attempts} />
            <Metric label="注册接受" value={overview.registrations.accepted} />
            <Metric label="注册拒绝 / 限流" value={overview.registrations.rejected} />
            <Metric label="验证挑战失败" value={overview.challengeFailures} />
            <Metric label="验证邮件发送" value={overview.verificationEmail.sent} />
            <Metric label="验证邮件节流" value={overview.verificationEmail.throttled} />
            <Metric label="未验证正常用户" value={overview.unverifiedUsers} />
            <Metric label="邀请待验证" value={overview.referrals.pendingVerification} />
            <Metric label="邀请已合格" value={overview.referrals.qualified} />
            <Metric label="邀请额度耗尽" value={overview.referrals.quotaExhausted} />
            <Metric label="奖励 held" value={overview.rewards.held} />
            <Metric label="奖励已发放" value={overview.rewards.granted} />
          </div>
        </div>
      ) : null}

      <section className="border-t border-[var(--color-border)] pt-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="font-heading text-lg font-bold text-[var(--color-text)]">邀请码资格</h3>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">暂停只影响未来资格和待发奖励，不追扣既有积分。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              className="input min-h-10 w-auto py-2"
              value={referralState}
              onChange={event => { setReferralPage(1); setReferralState(event.target.value as AdminAbuseReferralState | '') }}
              aria-label="邀请码状态筛选"
            >
              <option value="">全部状态</option>
              <option value="pending_verification">待验证</option>
              <option value="qualified">已合格</option>
              <option value="quota_exhausted">额度耗尽</option>
              <option value="voided">已作废</option>
              <option value="legacy">历史记录</option>
            </select>
            <input
              className="input min-h-10 min-w-0 flex-1 py-2 sm:w-40"
              value={referralQueryDraft}
              maxLength={100}
              placeholder="用户 ID 或邮箱片段"
              onChange={event => setReferralQueryDraft(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') applyReferralQuery() }}
              aria-label="邀请码资格搜索"
            />
            <button type="button" className="btn-secondary min-h-10 px-3 text-sm" onClick={applyReferralQuery}>查询</button>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-[var(--color-border)]">
          {referralsLoading && referrals.length === 0 ? <TableSkeleton rows={5} /> : (
            <table className="admin-table table-cards w-full text-sm">
              <thead>
                <tr>
                  <th>关系</th><th>邀请人</th><th>被邀请人</th><th>资格</th><th>奖励</th><th>创建时间</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                {referrals.map(referral => (
                  <tr key={referral.id}>
                    <td data-label="关系">#{referral.id}</td>
                    <td data-label="邀请人">
                      <div>#{referral.inviter.id} · {referral.inviter.email}</div>
                      {referral.inviter.referralSuspended && <span className="text-xs text-rose-600">资格已暂停</span>}
                    </td>
                    <td data-label="被邀请人">#{referral.invitee.id} · {referral.invitee.email}</td>
                    <td data-label="资格"><StatePill state={referral.status} /></td>
                    <td data-label="奖励">
                      {referral.reward ? <><StatePill state={referral.reward.state} /><div className="mt-1 text-xs">{referral.reward.amount} 积分</div></> : '—'}
                    </td>
                    <td data-label="创建时间" className="text-xs text-[var(--color-text-muted)]">{dateLabel(referral.createdAt)}</td>
                    <td data-label="操作">
                      <button
                        type="button"
                        className="btn-secondary min-h-10 px-3 text-xs"
                        onClick={() => openAction({
                          type: 'referral',
                          userId: referral.inviter.id,
                          email: referral.inviter.email,
                          suspended: !referral.inviter.referralSuspended,
                        })}
                      >
                        {referral.inviter.referralSuspended ? '恢复资格' : '暂停资格'}
                      </button>
                    </td>
                  </tr>
                ))}
                {!referralsLoading && referrals.length === 0 && (
                  <tr><td colSpan={7}><EmptyState compact icon={ShieldAlert} title="暂无邀请码关系" description="调整筛选条件或等待新的注册关系" /></td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
        <Pagination page={referralPage} total={referralTotal} onChange={setReferralPage} />
      </section>

      <section className="border-t border-[var(--color-border)] pt-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="font-heading text-lg font-bold text-[var(--color-text)]">奖励账本</h3>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">只可作废待验证或 held 奖励；已发放记录只读。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              className="input min-h-10 w-auto py-2"
              value={rewardState}
              onChange={event => { setRewardPage(1); setRewardState(event.target.value as AdminAbuseRewardState | '') }}
              aria-label="奖励状态筛选"
            >
              <option value="">全部状态</option>
              <option value="pending_verification">待验证</option>
              <option value="held">held</option>
              <option value="granted">已发放</option>
              <option value="voided">已作废</option>
            </select>
            <input
              className="input min-h-10 w-32 py-2"
              value={rewardUserIdDraft}
              inputMode="numeric"
              placeholder="收款用户 ID"
              onChange={event => setRewardUserIdDraft(event.target.value.replace(/\D/g, ''))}
              onKeyDown={event => { if (event.key === 'Enter') applyRewardUserFilter() }}
              aria-label="奖励收款用户 ID"
            />
            <button type="button" className="btn-secondary min-h-10 px-3 text-sm" onClick={applyRewardUserFilter}>查询</button>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-[var(--color-border)]">
          {rewardsLoading && rewards.length === 0 ? <TableSkeleton rows={5} /> : (
            <table className="admin-table table-cards w-full text-sm">
              <thead>
                <tr><th>奖励</th><th>收款用户</th><th>金额</th><th>状态</th><th>可用时间</th><th>邀请关系</th><th>操作</th></tr>
              </thead>
              <tbody>
                {rewards.map(reward => (
                  <tr key={reward.id}>
                    <td data-label="奖励">#{reward.id}<div className="text-xs text-[var(--color-text-muted)]">{reward.kind}</div></td>
                    <td data-label="收款用户">#{reward.recipient.id} · {reward.recipient.email}</td>
                    <td data-label="金额" className="font-semibold">{reward.amount} 积分</td>
                    <td data-label="状态"><StatePill state={reward.state} /></td>
                    <td data-label="可用时间" className="text-xs text-[var(--color-text-muted)]">{dateLabel(reward.availableAt)}</td>
                    <td data-label="邀请关系">
                      {reward.inviteRelation ? <span className="text-xs">#{reward.inviteRelation.id} · <StatePill state={reward.inviteRelation.status} /></span> : '—'}
                    </td>
                    <td data-label="操作">
                      {(reward.state === 'pending_verification' || reward.state === 'held') ? (
                        <button
                          type="button"
                          className="btn-secondary min-h-10 border-[var(--color-danger)] px-3 text-xs text-[var(--color-danger)]"
                          onClick={() => openAction({ type: 'reward', rewardId: reward.id, amount: reward.amount, rewardKind: reward.kind })}
                        >
                          作废奖励
                        </button>
                      ) : <span className="text-xs text-[var(--color-text-muted)]">不可作废</span>}
                    </td>
                  </tr>
                ))}
                {!rewardsLoading && rewards.length === 0 && (
                  <tr><td colSpan={7}><EmptyState compact icon={AlertTriangle} title="暂无奖励记录" description="调整筛选条件或等待新的奖励账本记录" /></td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
        <Pagination page={rewardPage} total={rewardTotal} onChange={setRewardPage} />
      </section>

      <Dialog open={pendingAction !== null} onOpenChange={open => { if (!open && !actionBusy) setPendingAction(null) }}>
        <DialogContent className="max-w-md" data-testid="admin-abuse-confirm-dialog">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-danger)]/10 text-[var(--color-danger)]">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle>{actionTitle}</DialogTitle>
              <DialogDescription>{actionDescription}</DialogDescription>
            </div>
          </div>
          <div className="mt-4 space-y-3">
            <label className="block text-sm font-semibold text-[var(--color-text)]" htmlFor="admin-abuse-case-ref">
              工单编号
              <input
                id="admin-abuse-case-ref"
                className="input mt-1.5 min-h-10"
                value={caseRef}
                maxLength={29}
                placeholder="例如 RAP-123"
                onChange={event => setCaseRef(event.target.value.toUpperCase())}
                autoFocus
              />
            </label>
            <label className="flex min-h-10 cursor-pointer items-start gap-2 text-sm text-[var(--color-text)]">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={confirmed}
                onChange={event => setConfirmed(event.target.checked)}
              />
              <span>我已核对工单与目标，确认执行该不可逆风控操作。</span>
            </label>
          </div>
          <div className="mt-5 flex flex-wrap justify-end gap-3">
            <button type="button" className="btn-secondary min-h-10 px-4 text-sm" disabled={actionBusy} onClick={() => setPendingAction(null)}>取消</button>
            <button
              type="button"
              className="btn-secondary min-h-10 border-[var(--color-danger)] px-4 text-sm text-[var(--color-danger)]"
              disabled={actionBusy || !confirmed || !CASE_REF_PATTERN.test(caseRef.trim())}
              onClick={() => void submitAction()}
              data-testid="admin-abuse-confirm-submit"
            >
              {actionBusy ? '处理中…' : '确认执行'}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
