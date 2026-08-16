// T-MERCH-FE-004 — AdminMerchandisingPage: standalone, independently-mountable
// composite page composing the five frozen admin merchandising managers.
//
// It deliberately does NOT own business data: it holds only the current
// section state, never fires API calls, and never holds child loading/error/
// mutation state. The five existing managers own their own data lifecycle and
// default adapters; this page only passes the provided adapters through
// unchanged.
import { useState } from 'react'
import type { ReactNode } from 'react'
import AdminEditorialManager from './AdminEditorialManager'
import type { AdminEditorialAdapter } from './AdminEditorialManager'
import AdminEntitlementManager from './AdminEntitlementManager'
import type { AdminEntitlementAdapter } from './AdminEntitlementManager'
import AdminMerchandisingRunPanel from './AdminMerchandisingRunPanel'
import type { AdminMerchandisingRunAdapter } from './AdminMerchandisingRunPanel'
import AdminPromotionCampaignManager from './AdminPromotionCampaignManager'
import type { AdminPromotionCampaignAdapter } from './AdminPromotionCampaignManager'
import AdminPromotionPackageManager from './AdminPromotionPackageManager'
import type { AdminPromotionPackageAdapter } from './AdminPromotionPackageManager'

/** The five governance sections governed by this composite page. */
export type MerchandisingSection =
  | 'packages'
  | 'campaigns'
  | 'editorial'
  | 'entitlements'
  | 'ranking'

/** Aggregated passthrough adapters — the page never rebuilds the underlying API. */
export interface AdminMerchandisingPageAdapters {
  packageAdapter?: AdminPromotionPackageAdapter
  campaignAdapter?: AdminPromotionCampaignAdapter
  editorialAdapter?: AdminEditorialAdapter
  entitlementAdapter?: AdminEntitlementAdapter
  runAdapter?: AdminMerchandisingRunAdapter
}

export interface AdminMerchandisingPageProps extends AdminMerchandisingPageAdapters {
  className?: string
}

interface MerchandisingTabDef {
  id: MerchandisingSection
  label: string
}

/** Fixed, internally-owned tab order — switching is driven by these ids, never by DOM text. */
const MERCHANDISING_TABS: ReadonlyArray<MerchandisingTabDef> = [
  { id: 'packages', label: '推广套餐' },
  { id: 'campaigns', label: '推广活动' },
  { id: 'editorial', label: '平台精选' },
  { id: 'entitlements', label: '合作权益' },
  { id: 'ranking', label: '自然热卖' },
]

function tabId(section: MerchandisingSection): string {
  return `merchandising-tab-${section}`
}

function panelId(section: MerchandisingSection): string {
  return `merchandising-panel-${section}`
}

/** Mounts only the active manager — the page never renders all five at once. */
function renderSectionContent(
  section: MerchandisingSection,
  adapters: AdminMerchandisingPageAdapters,
): ReactNode {
  switch (section) {
    case 'packages':
      return <AdminPromotionPackageManager adapter={adapters.packageAdapter} />
    case 'campaigns':
      return <AdminPromotionCampaignManager adapter={adapters.campaignAdapter} />
    case 'editorial':
      return <AdminEditorialManager adapter={adapters.editorialAdapter} />
    case 'entitlements':
      return <AdminEntitlementManager adapter={adapters.entitlementAdapter} />
    case 'ranking':
      return <AdminMerchandisingRunPanel adapter={adapters.runAdapter} />
  }
}

export default function AdminMerchandisingPage({
  className = '',
  packageAdapter,
  campaignAdapter,
  editorialAdapter,
  entitlementAdapter,
  runAdapter,
}: AdminMerchandisingPageProps) {
  const [section, setSection] = useState<MerchandisingSection>('packages')

  const adapters: AdminMerchandisingPageAdapters = {
    packageAdapter,
    campaignAdapter,
    editorialAdapter,
    entitlementAdapter,
    runAdapter,
  }

  return (
    <div className={className}>
      <h1 className="text-2xl font-bold text-[var(--color-text)]">营销与陈列治理</h1>
      <p className="mt-1 text-sm text-[var(--color-text-muted)]">
        统一管理推广套餐、活动审核、平台精选、合作权益与自然热卖排名，一处掌握营销与陈列治理。
      </p>

      <div
        role="tablist"
        aria-label="营销与陈列管理导航"
        className="mt-4 flex gap-1 overflow-x-auto hide-scrollbar p-1 rounded-xl bg-[var(--color-background)] border border-[var(--color-border)]"
      >
        {MERCHANDISING_TABS.map((tab) => {
          const selected = section === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-controls={panelId(tab.id)}
              aria-selected={selected}
              onClick={() => setSection(tab.id)}
              className={`flex-1 min-w-[6rem] px-3 py-2 rounded-lg text-sm font-bold transition-colors cursor-pointer whitespace-nowrap ${
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

      {MERCHANDISING_TABS.map((tab) =>
        tab.id === section ? (
          <div
            key={tab.id}
            role="tabpanel"
            id={panelId(tab.id)}
            aria-labelledby={tabId(tab.id)}
            className="mt-4"
          >
            {renderSectionContent(tab.id, adapters)}
          </div>
        ) : null,
      )}
    </div>
  )
}
