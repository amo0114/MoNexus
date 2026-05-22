import { create } from 'zustand'
import { Range } from '../api/merchant/dashboard'

interface DashboardState {
  range: Range
  setRange: (range: Range) => void
}

export const useDashboardStore = create<DashboardState>((set) => ({
  range: '30d',
  setRange: (range) => set({ range })
}))
