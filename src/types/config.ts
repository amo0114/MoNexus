export interface RegistryItem {
  value: string
  label: string
  tone?: 'success' | 'info' | 'warning' | 'danger' | 'neutral'
}

export interface ProductTypeItem extends RegistryItem {
  deliveryModes: string[]
}

export interface ProductCategoryRegistryItem {
  id: number
  code: string
  label: string
  iconKey: string | null
  sortOrder: number
}

export interface ConfigRegistry {
  /** Dynamic taxonomy. Optional only for rolling compatibility with an old backend. */
  productCategories?: ProductCategoryRegistryItem[]
  productTypes: ProductTypeItem[]
  deliveryModes: RegistryItem[]
  orderStatuses: RegistryItem[]
  settlementStatuses: RegistryItem[]
  pagination: {
    defaultPageSize: number
    maxPageSize: number
  }
  inventory: {
    lowStockThreshold: number
  }
  capabilities?: {
    notifications: boolean
    notificationRealtime: boolean
  }
}
