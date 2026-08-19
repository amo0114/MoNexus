import { useState } from 'react'
import type { ReactNode } from 'react'
import AdminRechargeOrders from './AdminRechargeOrders'
import AdminPaymentEvents from './AdminPaymentEvents'
import AdminRechargeRefunds from './AdminRechargeRefunds'
import AdminPaymentDisputes from './AdminPaymentDisputes'
import AdminReconciliation from './AdminReconciliation'

export type RechargeAdminSection = 'orders' | 'events' | 'refunds' | 'disputes' | 'reconciliation'

const TABS: ReadonlyArray<{ id: RechargeAdminSection; label: string }> = [
  { id: 'orders', label: '充值订单' },
  { id: 'events', label: '支付事件' },
  { id: 'refunds', label: '退款' },
  { id: 'disputes', label: '争议' },
  { id: 'reconciliation', label: '对账' },
]

function renderSection(section: RechargeAdminSection): ReactNode {
  switch (section) {
    case 'orders':
      return <AdminRechargeOrders />
    case 'events':
      return <AdminPaymentEvents />
    case 'refunds':
      return <AdminRechargeRefunds />
    case 'disputes':
      return <AdminPaymentDisputes />
    case 'reconciliation':
      return <AdminReconciliation />
  }
}

export default function AdminRechargePage() {
  const [section, setSection] = useState<RechargeAdminSection>('orders')

  return (
    <div data-testid="admin-recharge-page">
      <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">充值支付</h2>
      <p className="mt-1 text-sm text-[var(--color-text-muted)]">
        订单、事件、退款、争议与对账。危险操作走现有管理员 MFA，不会绕过渠道状态。
      </p>
      <div
        role="tablist"
        aria-label="充值支付管理导航"
        className="mt-4 flex gap-1 overflow-x-auto hide-scrollbar p-1 rounded-xl bg-[var(--color-background)] border border-[var(--color-border)]"
      >
        {TABS.map((tab) => {
          const selected = section === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setSection(tab.id)}
              className={`flex-1 min-w-[5.5rem] px-3 py-2 rounded-lg text-sm font-bold transition-colors cursor-pointer whitespace-nowrap ${
                selected
                  ? 'bg-[var(--color-primary)] text-white shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface)]'
              }`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      <div className="mt-4" role="tabpanel">
        {renderSection(section)}
      </div>
    </div>
  )
}
