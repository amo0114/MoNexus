import type { DraftChange } from './productDraftReview'

/** Row selection follows beautifului's diff-table pattern; native controls suit long product text and mobile. */
export default function ProductDraftDiff({ changes, selected, onSelect, onApply, onDiscard }: {
  changes: DraftChange[]
  selected: Set<string>
  onSelect: (key: string, checked: boolean) => void
  onApply: () => void
  onDiscard: () => void
}) {
  return <section aria-label="核对本次修改" className="flex flex-col gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5">
    <div><h3 className="font-bold">{changes.length ? `有 ${changes.length} 项可以调整` : '这次没有新的字段变化'}</h3>
      <p className="mt-1 text-sm text-[var(--color-text-muted)]">勾选要采纳的内容。未勾选的字段和你填写的交易设置会保留。</p></div>
    {changes.map(change => <label key={change.key} className="block cursor-pointer rounded-lg border border-[var(--color-border)] p-3">
      <span className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" aria-label={`采纳：${change.label}`} checked={selected.has(change.key)} onChange={event => onSelect(change.key, event.target.checked)} />采纳：{change.label}</span>
      <span className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
        <span className="min-w-0"><span className="mb-1 block text-xs text-[var(--color-text-muted)]">当前内容</span><span className="block whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{change.before}</span></span>
        <span className="min-w-0 rounded bg-[var(--color-background)] p-2"><span className="mb-1 block text-xs text-[var(--color-primary)]">本次建议</span><span className="block whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{change.after}</span></span>
      </span>
    </label>)}
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className="btn-primary min-h-11" disabled={changes.length > 0 && selected.size === 0} onClick={onApply}>
        {changes.length ? `采纳所选 ${selected.size} 项修改` : '确认继续'}</button>
      <button type="button" className="btn-secondary min-h-11" onClick={onDiscard}>保留当前内容</button>
    </div>
  </section>
}
