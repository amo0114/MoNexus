import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiGet } = vi.hoisted(() => ({
  apiGet: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  default: { get: apiGet },
}))

vi.mock('./AdminOfferReport', () => ({
  default: () => null,
}))

vi.mock('../analytics/TrafficPanel', () => ({
  default: () => null,
}))

import AdminDashboardPanel from './AdminDashboardPanel'

describe('AdminDashboardPanel loading skeleton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiGet.mockReturnValue(new Promise(() => {}))
  })

  it('mirrors the two-card today section and five-card totals section while loading', () => {
    render(<AdminDashboardPanel />)

    const statuses = screen.getAllByRole('status')
    expect(statuses).toHaveLength(1)

    const todayGrid = screen.getByTestId('admin-dashboard-skeleton-today').querySelector('.grid')
    expect(todayGrid?.className).toContain('grid-cols-2')
    expect(todayGrid?.children).toHaveLength(2)

    const totalsGrid = screen.getByTestId('admin-dashboard-skeleton-totals').querySelector('.grid')
    expect(totalsGrid?.className).toContain('xl:grid-cols-5')
    expect(totalsGrid?.children).toHaveLength(5)
  })
})
