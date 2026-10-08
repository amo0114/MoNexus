import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Loader2, Sparkles, X } from 'lucide-react'
import type { AgentEvidence, AgentTurnResult } from '../../../api/merchant/agent'
import type { WorkbenchAction } from '../../../api/merchant/workbench'
import { useMerchantAgentStore, type AgentMessage } from '../../../stores/merchantAgent'
import WorkbenchCard, { draftIssueLabel } from '../workbench/WorkbenchCard'
import { actionTarget } from '../workbench/navigation'
import { useMerchantAgent } from './useMerchantAgent'

// SPEC-MERCHANT-AGENT-001 §8.2 — the conversation lives next to the rule
// workbench and never blocks it. Sending is the only thing that starts a
// (billed) run; examples only fill the input. Facts and actions are rendered
// from server evidence; model text is plain text.

const EXAMPLES = ['今天先处理什么？', '这个商品为什么不能发布？', '帮我完善这个商品的说明']

const TOOL_LABELS: Record<string, string> = {
  read_workbench: '查看待办',
  find_products: '查找商品',
  inspect_product: '发布检查',
  read_item: '复查事项',
  read_product_content: '读取商品说明',
  read_help: '查看平台规则',
  prepare_content: '准备文案',
}

const STOP_LABELS: Record<string, string> = {
  budget: '已达到本轮查询步数上限',
  no_progress: '重复查询没有新进展',
  timeout: '本轮时间已用完',
  context_limit: '查询内容超过本轮处理上限',
  content_changed: '商品内容已变化',
}

const GROUP_LABELS: Record<string, string> = {
  fulfillment: '人工履约临期 / 超时',
  sold_out: '已售罄 / 名额用完',
  availability: '库存 / 名额不足',
  drafts: '草稿缺项',
}

function ActionLink({ action, label = '去处理' }: { action: WorkbenchAction; label?: string }) {
  const target = actionTarget(action)
  return <Link to={target.to} state={target.state} className="text-sm font-semibold text-[var(--color-primary)]">{label}</Link>
}

function EvidenceView({ card }: { card: AgentEvidence }) {
  if (card.kind === 'workbench_item') {
    return <ul><WorkbenchCard item={card.item} stale={false} /></ul>
  }
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm" data-testid={`agent-evidence-${card.ref}`}>
      <p className="font-bold text-[var(--color-text)]">{card.name || '商品'}</p>
      {card.kind === 'readiness' && (
        card.ready
          ? <p className="text-[var(--color-text-muted)]">发布检查已通过。</p>
          : (
            <ul className="mt-1 space-y-1">
              {card.issues.map((issue, index) => (
                <li key={index} className="flex flex-wrap items-center gap-x-2">
                  <span>{draftIssueLabel({ code: issue.code, field: issue.field, offerId: issue.offerId, action: issue.action })}</span>
                  <ActionLink action={issue.action} label="定位" />
                </li>
              ))}
            </ul>
          )
      )}
      {card.kind === 'content' && (
        <p className="text-[var(--color-text-muted)]">待补充说明：{card.emptyFields.length} 项；已有：{card.filledFields.length} 项</p>
      )}
    </div>
  )
}

function ResultView({ result }: { result: AgentTurnResult }) {
  const navigate = useNavigate()
  const { select, handOff } = useMerchantAgentStore()
  const byRef = new Map(result.evidence.map(card => [card.ref, card]))
  const referenced = new Set(result.blocks.flatMap(block => block.evidenceRefs))
  const truncated = result.coverage.filter(note => note.truncated || note.hasMore || note.status !== 'complete')
  const productOf = (ref: string) => {
    const card = byRef.get(ref)
    if (!card) return null
    if (card.kind === 'workbench_item') return card.item.productId == null ? null : { id: card.item.productId, name: card.item.evidence.productName }
    return { id: card.productId, name: card.name }
  }

  return (
    <div className="space-y-3" data-testid="agent-result">
      {result.outcome === 'limited' && (
        <p className="rounded-lg border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-3 py-2 text-sm text-[var(--color-warning-text)]" role="status">
          本轮调查未完成（{STOP_LABELS[result.stopReason] ?? '已停止'}）。以下只包含已核实的信息，可以缩小问题后再问。
        </p>
      )}

      {result.blocks.map((block, index) => (
        <div key={index} className="space-y-2" data-testid="agent-block">
          <p className="whitespace-pre-wrap break-words text-sm text-[var(--color-text)]">{block.text}</p>
          {block.evidenceRefs.map(ref => byRef.get(ref)).filter((card): card is AgentEvidence => Boolean(card)).map(card => (
            <EvidenceView key={card.ref} card={card} />
          ))}
          {block.action && <ActionLink action={block.action} />}
        </div>
      ))}

      {result.clarification && (
        <div className="space-y-2" data-testid="agent-clarification">
          <p className="text-sm text-[var(--color-text)]">{result.clarification.question}</p>
          <div className="flex flex-wrap gap-2">
            {result.clarification.candidateRefs.map(ref => {
              const product = productOf(ref)
              if (!product) return null
              return (
                <button key={ref} type="button" className="btn-secondary btn-sm min-h-11"
                  onClick={() => select({ type: 'product', id: product.id, label: product.name })}>
                  {product.name}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {result.proposal && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm" data-testid="agent-proposal">
          <p className="font-bold text-[var(--color-text)]">文案提案已准备好</p>
          <p className="text-[var(--color-text-muted)]">
            可采纳 {Object.values(result.proposal.fields).filter(field => field?.status === 'suggested').length} 项，需在编辑器中逐项核对、填入并手动保存；10 分钟内有效，刷新页面会丢失。
          </p>
          <button type="button" className="btn-primary btn-sm mt-2 min-h-11" data-testid="agent-proposal-review"
            onClick={() => { handOff(result.proposal!); navigate(`/merchant/products/${result.proposal!.productId}/edit`) }}>
            到编辑器审阅
          </button>
        </div>
      )}

      {result.outcome === 'limited' && result.evidence.filter(card => !referenced.has(card.ref)).map(card => <EvidenceView key={card.ref} card={card} />)}

      {truncated.length > 0 && (
        <ul className="space-y-1 text-xs text-[var(--color-text-muted)]" data-testid="agent-coverage">
          {truncated.map((note, index) => (
            <li key={index}>
              {GROUP_LABELS[note.group] ?? note.group}：
              {note.status === 'failed' ? '本次未能检查' : note.hasMore ? '只检查了部分草稿' : `共 ${note.matchedTotal ?? '未知'} 项，仅列出部分`}，完整内容请看待办列表。
            </li>
          ))}
        </ul>
      )}

      {result.steps.length > 0 && (
        <p className="text-xs text-[var(--color-text-muted)]" data-testid="agent-steps">
          已执行：{result.steps.map(step => TOOL_LABELS[step.tool] ?? step.tool).join(' · ')}
        </p>
      )}
    </div>
  )
}

function MessageView({ message }: { message: AgentMessage }) {
  if (message.role === 'user') {
    return (
      <div className="ml-auto max-w-[85%] rounded-xl bg-[var(--color-primary-tint)] px-3 py-2 text-sm text-[var(--color-text)]">
        {message.selection && <p className="text-xs text-[var(--color-text-muted)]">关于：{message.selection.label}</p>}
        <p className="whitespace-pre-wrap break-words">{message.text}</p>
      </div>
    )
  }
  if (message.role === 'error') {
    return <p className="text-sm text-[var(--color-warning-text)]" role="status">{message.text}</p>
  }
  return <ResultView result={message.result} />
}

export default function AgentPanel() {
  const agent = useMerchantAgent()
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pending = agent.pendingRequestId != null

  useEffect(() => {
    if (agent.selection) inputRef.current?.focus()
  }, [agent.selection])

  if (agent.availability === 'unknown' || agent.availability === 'disabled') return null

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!draft.trim() || pending) return
    void agent.send(draft)
    setDraft('')
  }

  return (
    <section id="merchant-agent" className="card mb-6 scroll-mt-20" aria-labelledby="merchant-agent-title" data-testid="merchant-agent">
      <h2 id="merchant-agent-title" className="mb-1 flex items-center gap-2 font-heading text-lg font-bold text-[var(--color-text)]">
        <Sparkles className="h-5 w-5" aria-hidden="true" />经营助手
      </h2>
      <p className="mb-3 text-xs text-[var(--color-text-muted)]">
        只读查询你的待办和商品，给出处理建议或文案提案；不会修改任何数据。请只输入经营问题和公开介绍，不要填写账号、密码、卡密或联系方式。
      </p>

      {agent.messages.length > 0 && (
        <div className="mb-3 space-y-3" data-testid="agent-messages">
          {agent.messages.map(message => <MessageView key={message.id} message={message} />)}
        </div>
      )}

      {agent.availability === 'quota' && (
        <p className="mb-2 text-sm text-[var(--color-text-muted)]" data-testid="agent-quota">今日经营助手次数已用完，可以继续使用下方待办列表手动处理。</p>
      )}
      {agent.availability === 'error' && (
        <p className="mb-2 text-sm text-[var(--color-text-muted)]">暂时无法确认经营助手状态，可以直接提问或稍后再试。</p>
      )}

      {agent.selection && (
        <p className="mb-2 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-text)]" data-testid="agent-selection">
          关于：{agent.selection.label}
          <button type="button" aria-label="取消选择" onClick={() => agent.select(null)}><X className="h-3 w-3" /></button>
        </p>
      )}

      <form onSubmit={submit} className="space-y-2">
        <label htmlFor="merchant-agent-input" className="sr-only">向经营助手提问</label>
        <textarea
          id="merchant-agent-input"
          ref={inputRef}
          className="input min-h-20 w-full"
          maxLength={1000}
          value={draft}
          disabled={pending || agent.availability === 'quota'}
          placeholder="例如：今天先处理什么？"
          onChange={event => setDraft(event.target.value)}
          data-testid="agent-input"
        />
        <div className="flex flex-wrap items-center gap-2">
          {EXAMPLES.map(example => (
            <button key={example} type="button" className="btn-secondary btn-sm min-h-11" disabled={pending} onClick={() => setDraft(example)}>
              {example}
            </button>
          ))}
          <div className="ml-auto flex gap-2">
            {pending && (
              <button type="button" className="btn-secondary btn-sm min-h-11" onClick={agent.cancel} data-testid="agent-cancel">取消</button>
            )}
            <button type="submit" className="btn-primary btn-sm inline-flex min-h-11 items-center gap-1.5"
              disabled={pending || !draft.trim() || agent.availability === 'quota'} data-testid="agent-send">
              {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {pending ? '正在检查，请稍候' : '发送'}
            </button>
          </div>
        </div>
      </form>
    </section>
  )
}
