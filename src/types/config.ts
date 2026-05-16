export interface RegistryItem {
  value: string
  label: string
  tone?: 'success' | 'info' | 'warning' | 'danger' | 'neutral'
}

export interface ProductTypeItem extends RegistryItem {
  deliveryModes: string[]
}

export interface ConfigRegistry {
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
}
