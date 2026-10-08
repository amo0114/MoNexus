import { Link, useNavigate } from 'react-router-dom'
import { AlertTriangle, ClipboardList, PackageX, Timer } from 'lucide-react'
import type { DraftIssue, WorkbenchAction, WorkbenchItem } from '../../../api/merchant/workbench'
import { useMerchantAgentStore } from '../../../stores/merchantAgent'
import { useMerchantWorkbenchStore } from '../../../stores/merchantWorkbench'
import { actionTarget, productNameOf } from './navigation'

// Facts are rendered from structured server fields only (Spec §3.1). Times are
// shown in Asia/Shanghai; nothing here recomputes a rule.

const shanghaiTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
})

export function formatShanghai(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : shanghaiTime.format(date)
}

const ORDER_STATUS_LABEL: Record<string, string> = { pending: '待接单', processing: '处理中' }

/** Closed code → label table; never derived from readiness prose. */
export function draftIssueLabel(issue: DraftIssue): string {
  switch (issue.code) {
    case 'COVER_REQUIRED': return '缺少商品封面'
    case 'PURCHASE_NOTES_REQUIRED': return '缺少购买须知'
    case 'AFTER_SALES_REQUIRED': return '缺少售后说明'
    case 'TEMPLATE_FIELDS_REQUIRED': return issue.offerId == null ? '商品参数未补齐' : '规格参数未补齐'
    case 'OFFER_NOT_SELLABLE':
      if (issue.action.kind === 'manage_availability') return '规格暂无可售量'
      return issue.offerId == null ? '没有启用的规格' : '规格配置需检查'
    case 'FULFILLMENT_CONFIG_INVALID': return '规格交付配置需调整'
    case 'CATEGORY_INACTIVE': return '分类已停用：请更换分类或联系平台'
    case 'EXTERNAL_IDENTITY_INVALID': return '外部开通配置需检查，必要时联系平台'
    default: return '发布条件尚未满足'
  }
}

function actionLabel(item: WorkbenchItem): string {
  if (item.action.kind === 'view_order') return '查看订单'
  if (item.action.kind === 'manage_availability') {
    return item.evidence.kind === 'capacity' ? '调整名额' : item.evidence.kind === 'inventory' ? '补充库存' : '管理可售量'
  }
  return '完善商品'
}

function cardTitle(item: WorkbenchItem): string {
  const evidence = item.evidence
  if (evidence.kind === 'fulfillment') {
    if (evidence.band === 'overdue') return '人工服务订单已超时'
    return new Date(evidence.deadline).getTime() <= new Date(item.evaluatedAt).getTime()
      ? '人工服务订单已到截止时刻'
      : '人工服务订单即将超时'
  }
  if (evidence.kind === 'inventory') return evidence.available === 0 ? '规格库存已售罄' : '规格库存不足'
  if (evidence.kind === 'capacity') return evidence.available === 0 ? '规格名额已用完' : '规格名额不足'
  return '草稿有待补充项目'
}

function CardIcon({ item }: { item: WorkbenchItem }) {
  const className = 'h-5 w-5 shrink-0'
  if (item.rule === 'fulfillment_due') return <Timer className={className} aria-hidden="true" />
  if (item.rule === 'low_availability') return <PackageX className={className} aria-hidden="true" />
  return <ClipboardList className={className} aria-hidden="true" />
}

function ActionLink({ action, item, className, children, testId }: {
  action: WorkbenchAction; item: WorkbenchItem; className: string; children: React.ReactNode; testId: string
}) {
  const target = actionTarget(action, productNameOf(item))
  return (
    <Link
      to={target.to}
      state={target.state}
      className={className}
      data-testid={testId}
      onClick={() => useMerchantWorkbenchStore.getState().rememberNavigation(action)}
    >
      {children}
    </Link>
  )
}

const MAX_VISIBLE_ISSUES = 3

/** Secondary entry: selects this item for the operations agent; never starts a run by itself. */
function AskAgentButton({ item }: { item: WorkbenchItem }) {
  const navigate = useNavigate()
  const ready = useMerchantAgentStore(state => state.availability === 'ready')
  if (!ready) return null
  const evidence = item.evidence
  const label = evidence.kind === 'inventory' || evidence.kind === 'capacity' ? `${evidence.productName} · ${evidence.offerName}`
    : evidence.kind === 'fulfillment' ? `订单 #${item.targetId}` : evidence.productName
  const type = item.rule === 'fulfillment_due' ? 'order' : item.rule === 'low_availability' ? 'offer' : 'product'
  return (
    <button
      type="button"
      className="btn-secondary btn-sm min-h-11 shrink-0 px-3 text-sm"
      data-testid="workbench-card-ask-agent"
      onClick={() => {
        useMerchantAgentStore.getState().select({ type, id: item.targetId, label })
        const panel = document.getElementById('merchant-agent')
        if (panel) panel.scrollIntoView({ block: 'start' })
        else navigate('/merchant/workbench')
      }}
    >
      帮我处理
    </button>
  )
}

export default function WorkbenchCard({ item, stale }: { item: WorkbenchItem; stale: boolean }) {
  const evidence = item.evidence
  const urgent = item.priority === 'urgent'
  return (
    <li
      className={`rounded-xl border p-4 ${urgent
        ? 'border-[var(--color-danger-border)] bg-[var(--color-danger-bg)]'
        : 'border-[var(--color-border)] bg-[var(--color-surface)]'}`}
      data-testid={`workbench-card-${item.key}`}
      data-rule={item.rule}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className={`flex items-center gap-2 font-bold ${urgent ? 'text-[var(--color-danger-text)]' : 'text-[var(--color-text)]'}`}>
            <CardIcon item={item} />
            <span>{cardTitle(item)}</span>
            {stale && (
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-2 py-0.5 text-xs font-medium text-[var(--color-warning-text)]" data-testid="workbench-card-stale">
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />待刷新
              </span>
            )}
          </p>

          {evidence.kind === 'fulfillment' && (
            <p className="mt-1 break-words text-sm text-[var(--color-text-muted)]">
              订单 #{item.targetId} · {evidence.productName}{evidence.offerName ? ` · ${evidence.offerName}` : ''}
              {' · '}{ORDER_STATUS_LABEL[evidence.status] ?? evidence.status}
              {' · '}履约截止 {formatShanghai(evidence.deadline)}
            </p>
          )}

          {(evidence.kind === 'inventory' || evidence.kind === 'capacity') && (
            <p className="mt-1 break-words text-sm text-[var(--color-text-muted)]">
              {evidence.productName} · {evidence.offerName}
              {' · '}当前可售 {evidence.available} 份，提醒阈值 {evidence.threshold} 份
            </p>
          )}

          {evidence.kind === 'draft' && (
            <div className="mt-1 text-sm text-[var(--color-text-muted)]">
              <p className="break-words">{evidence.productName}</p>
              <ul className="mt-1 space-y-1" data-testid="workbench-draft-issues">
                {evidence.issues.slice(0, MAX_VISIBLE_ISSUES).map((issue, index) => (
                  <li key={`${issue.code}:${issue.field}:${issue.offerId ?? ''}`} className="flex flex-wrap items-center gap-x-2">
                    <span>{draftIssueLabel(issue)}</span>
                    {evidence.issues.length > 1 && (
                      <ActionLink
                        action={issue.action}
                        item={item}
                        className="text-[var(--color-primary)] underline-offset-2 hover:underline"
                        testId={`workbench-issue-link-${index}`}
                      >
                        定位
                      </ActionLink>
                    )}
                  </li>
                ))}
              </ul>
              {evidence.issues.length > MAX_VISIBLE_ISSUES && (
                <p className="mt-1" data-testid="workbench-draft-more">其余 {evidence.issues.length - MAX_VISIBLE_ISSUES} 项请在发布检查中查看</p>
              )}
              <p className="mt-1 text-xs">其他发布条件仍须在提交发布时检查。</p>
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <ActionLink
            action={item.action}
            item={item}
            className={`${urgent ? 'btn-primary' : 'btn-secondary'} min-h-11 shrink-0 px-4 text-sm`}
            testId="workbench-card-action"
          >
            {actionLabel(item)}
          </ActionLink>
          <AskAgentButton item={item} />
        </div>
      </div>
    </li>
  )
}
