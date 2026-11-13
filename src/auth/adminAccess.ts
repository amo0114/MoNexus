import type { AdminTab } from '../components/admin/AdminNav'
import { useAdminCapabilities } from '../stores/adminCapabilities'
import type { AdminPermission, GovernanceFeature } from '../types/governance'

interface TabAccessRule {
  readonly entryAllOf: readonly AdminPermission[]
  /** Governance-only tabs also need their feature switched on. */
  readonly feature?: GovernanceFeature
  /** Extra checks per section/button; never implies other permissions. */
  readonly actions: Readonly<Record<string, readonly AdminPermission[]>>
}

/** Mirror of docs/api/governance-v1/admin-navigation.json (contract 1.0.3); a unit test guards drift. */
export const ADMIN_TAB_ACCESS = {
  dashboard: {
    entryAllOf: ['catalog.read'],
    actions: {},
  },
  users: {
    entryAllOf: ['users.read'],
    actions: {
      ban: ['users.ban'],
      wallet: ['points.read'],
      adjustPoints: ['points.adjust'],
      orders: ['orders.read'],
      audit: ['audit.read'],
      auditDetails: ['audit.details.read'],
      authorizations: ['admin.permissions.manage'],
    },
  },
  products: {
    entryAllOf: ['catalog.read'],
    actions: {
      edit: ['catalog.write'],
      inventory: ['inventory.manage'],
      ai: ['ai.manage'],
      videos: ['videos.read'],
      manageVideos: ['videos.manage'],
      uploadImage: ['files.manage'],
    },
  },
  orders: {
    entryAllOf: ['orders.read'],
    actions: {
      detail: ['orders.delivery.read'],
      resolve: ['orders.resolve'],
      executeAfterSales: ['orders.after_sales.execute'],
      uploadDelivery: ['files.manage'],
    },
  },
  logs: {
    entryAllOf: ['points.read'],
    actions: {
      adjust: ['points.adjust'],
    },
  },
  audit: {
    entryAllOf: ['audit.read'],
    actions: {
      detail: ['audit.details.read'],
    },
  },
  files: {
    entryAllOf: ['orders.delivery.read'],
    actions: {
      revoke: ['files.manage'],
    },
  },
  merchants: {
    entryAllOf: ['merchants.read'],
    actions: {
      review: ['merchants.review'],
      suspendRestore: ['merchants.suspend'],
      commission: ['settings.manage'],
    },
  },
  settlements: {
    entryAllOf: ['settlements.read'],
    actions: {
      execute: ['settlements.execute'],
    },
  },
  announcements: {
    entryAllOf: ['announcements.read'],
    actions: {
      write: ['announcements.write'],
    },
  },
  config: {
    entryAllOf: ['settings.manage'],
    actions: {
      ai: ['ai.manage'],
    },
  },
  backup: {
    entryAllOf: ['backups.manage'],
    actions: {},
  },
  faka: {
    entryAllOf: ['orders.read'],
    actions: {
      retryRevoke: ['orders.resolve'],
    },
  },
  abuse: {
    entryAllOf: ['settings.manage'],
    actions: {},
  },
  storage: {
    entryAllOf: ['settings.manage'],
    actions: {},
  },
  merchandising: {
    entryAllOf: ['marketing.read'],
    actions: {
      write: ['marketing.write'],
    },
  },
  catalogGovernance: {
    entryAllOf: ['catalog.read'],
    actions: {
      write: ['catalog.write'],
    },
  },
  recharge: {
    entryAllOf: ['payments.read'],
    actions: {
      reviewRefund: ['payments.refunds.review'],
      resolveDisputeRecovery: ['payments.disputes.resolve'],
      otherPaymentCommands: ['settings.manage'],
    },
  },
  walletIntegrity: {
    entryAllOf: ['wallet.integrity.read'],
    feature: 'walletIntegrity',
    actions: {
      recheck: ['wallet.integrity.read'],
    },
  },
  exports: {
    entryAllOf: ['exports.create'],
    feature: 'exports',
    actions: {
      users: ['exports.create', 'users.read'],
      orders: ['exports.create', 'orders.read'],
      point_logs: ['exports.create', 'points.read'],
    },
  },
} as const satisfies Record<AdminTab, TabAccessRule>

export type AdminTabAction<T extends AdminTab> = keyof (typeof ADMIN_TAB_ACCESS)[T]['actions'] & string

/**
 * - pending: capabilities not settled yet; nothing may mount (never assume super).
 * - legacy: pre-governance backend; old tabs keep their old unrestricted behavior,
 *   governance-only tabs stay hidden.
 * - governed: tabs by entryAllOf (+feature), sections/buttons by actions.
 */
export type AdminAccessMode = 'pending' | 'legacy' | 'governed' | 'error'

export interface AdminAccess {
  mode: AdminAccessMode
  errorMessage: string | null
  canEnter: (tab: AdminTab) => boolean
  can: <T extends AdminTab>(tab: T, action: AdminTabAction<T>) => boolean
  reload: () => void
}

export function useAdminAccess(): AdminAccess {
  const caps = useAdminCapabilities()
  const { state } = caps
  const mode: AdminAccessMode =
    state.status === 'ready' ? 'governed'
      : state.status === 'unavailable' ? 'legacy'
        : state.status === 'error' ? 'error'
          : 'pending'
  const all = (perms: readonly AdminPermission[]) => perms.every(caps.can)
  const rule = (tab: AdminTab): TabAccessRule => ADMIN_TAB_ACCESS[tab]
  return {
    mode,
    errorMessage: state.status === 'error' ? state.message : null,
    canEnter: (tab) => {
      const r = rule(tab)
      if (mode === 'legacy') return !r.feature
      if (mode !== 'governed') return false
      return all(r.entryAllOf) && (!r.feature || caps.feature(r.feature))
    },
    can: (tab, action) => {
      if (mode === 'legacy') return true
      if (mode !== 'governed') return false
      const perms = rule(tab).actions[action]
      return Boolean(perms) && all(perms)
    },
    reload: caps.reload,
  }
}

/** Section/button checks scoped to one tab. */
export function useTabActions<T extends AdminTab>(tab: T): (action: AdminTabAction<T>) => boolean {
  const access = useAdminAccess()
  return (action) => access.can(tab, action)
}
