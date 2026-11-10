import { useEffect, useState } from 'react'
import { getMerchantFinanceSummary } from '../../../api/merchant'
import type { MerchantFinanceSummary as Summary } from '../../../types/merchant'

const ITEMS: Array<{ key: keyof Summary; label: string; hint: string }> = [
  { key: 'netEarned', label: '净收益', hint: '有效订单的应得积分，已扣除作废与售后冲正' },
  { key: 'awaitingCompletion', label: '等待完成', hint: '订单尚未完成验收或暂不满足结算条件' },
  { key: 'settleable', label: '可结算', hint: '已满足条件，等待平台批量入账' },
  { key: 'credited', label: '已入账', hint: '已真实入账到商家积分账户的累计金额' },
  { key: 'clawedBack', label: '售后扣回', hint: '已从结算积分中扣回的售后冲正' },
  { key: 'outstandingRecovery', label: '待追偿', hint: '售后冲正时结算积分不足、尚未结清的部分' },
  { key: 'walletBalance', label: '钱包可用', hint: '当前可用积分余额，可能已用于消费，与累计收益不同' },
]

/** Points earned on the platform; none of these figures is withdrawable cash. */
export default function MerchantFinanceSummary() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    getMerchantFinanceSummary().then(data => { if (alive) setSummary(data) }).catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [])
  if (failed) return <p className="text-xs text-[var(--color-text-muted)] mb-4">收益汇总暂时无法加载</p>
  if (!summary) return null
  return (
    <section className="mb-6" data-testid="merchant-finance-summary">
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        {ITEMS.map(item => (
          <div key={item.key} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3" title={item.hint}>
            <div className="text-xs text-[var(--color-text-muted)]">{item.label}</div>
            <div className={`font-heading text-lg font-bold ${item.key === 'outstandingRecovery' && summary.outstandingRecovery > 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-text)]'}`}>
              {Number(summary[item.key]).toLocaleString()}
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-[var(--color-text-muted)] mt-2">单位：积分。收益为平台内可消费的结算积分，不代表可提现现金。</p>
    </section>
  )
}
