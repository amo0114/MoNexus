import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { BarChart3, DollarSign, FilePlus2, Megaphone, Package, Settings, ShoppingBag, Store } from 'lucide-react'
import MerchantReadOnlyBanner from './MerchantReadOnlyBanner'

export type MerchantTabKey =
  | 'dashboard' | 'products' | 'orders' | 'settlements' | 'profile' | 'operations' | 'promotions' | 'categoryApplications'

export interface MerchantTab {
  key: MerchantTabKey
  label: string
  Icon: typeof Store
  /** Tabs with a path are their own route; the rest are panels of /merchant. */
  path?: string
}

export const MERCHANT_TABS: MerchantTab[] = [
  { key: 'dashboard', label: '概览', Icon: Store },
  { key: 'products', label: '商品管理', Icon: Package },
  { key: 'orders', label: '订单管理', Icon: ShoppingBag },
  { key: 'settlements', label: '结算管理', Icon: DollarSign },
  { key: 'profile', label: '商家资料', Icon: Settings },
  { key: 'operations', label: '经营数据', Icon: BarChart3, path: '/merchant/dashboard' },
  { key: 'promotions', label: '推广中心', Icon: Megaphone, path: '/merchant/promotions' },
  { key: 'categoryApplications', label: '分类申请', Icon: FilePlus2 },
]

/** Router state key used to open a /merchant panel from another merchant route. */
export const MERCHANT_TAB_STATE = 'merchantTab'

export function MerchantNav({ activeKey, onSelect }: { activeKey: MerchantTabKey | null; onSelect: (tab: MerchantTab) => void }) {
  return (
    <aside className="w-full lg:w-56 xl:w-60 flex-shrink-0 max-lg:sticky max-lg:top-[calc(var(--navbar-h)+var(--safe-top))] max-lg:z-20 max-lg:-mx-4 max-lg:px-4 max-lg:py-2 max-lg:bg-[color-mix(in_srgb,var(--color-background)_95%,transparent)] max-lg:backdrop-blur-md lg:sticky lg:top-[calc(var(--navbar-current-h)+1rem)] lg:self-start">
      <nav aria-label="商家中心" className="lg:card p-0 lg:p-2 flex lg:flex-col gap-1 overflow-x-auto hide-scrollbar scroll-fade-x">
        {MERCHANT_TABS.map((tab) => {
          const active = tab.key === activeKey
          return (
            <button
              key={tab.key}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelect(tab)}
              className={`shrink-0 flex items-center gap-3 px-3.5 py-2.5 lg:px-4 lg:py-3 rounded-lg transition-colors cursor-pointer text-sm whitespace-nowrap ${
                active
                  ? 'bg-[var(--color-primary)] text-[var(--color-on-primary)] font-semibold shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)] hover:text-[var(--color-text)] font-medium'
              }`}
            >
              <tab.Icon className="w-4 h-4 lg:w-5 lg:h-5 shrink-0" />
              {tab.label}
            </button>
          )
        })}
      </nav>
    </aside>
  )
}

/** Gives routed merchant pages the same navigation rail as the merchant centre. */
export default function MerchantShell({ active, children }: { active: MerchantTabKey | null; children: ReactNode }) {
  const navigate = useNavigate()
  return (
    <div className="flex flex-col lg:flex-row gap-5 lg:gap-6">
      <MerchantNav
        activeKey={active}
        onSelect={(tab) => navigate(tab.path ?? '/merchant', tab.path ? undefined : { state: { [MERCHANT_TAB_STATE]: tab.key } })}
      />
      <div className="flex-1 min-w-0">
        <MerchantReadOnlyBanner />
        {children}
      </div>
    </div>
  )
}
