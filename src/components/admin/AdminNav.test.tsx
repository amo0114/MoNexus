import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AdminNav, { ADMIN_NAV_GROUPS, AdminTab } from './AdminNav'

describe('Phase 2B: AdminNav Component & Grouped Navigation', () => {
  it('renders all 5 groups and all 18 items rendered in their respective group regions in the DOM', () => {
    const onTabChange = vi.fn()
    render(<AdminNav activeTab="dashboard" onTabChange={onTabChange} />)

    expect(ADMIN_NAV_GROUPS).toHaveLength(5)

    // Verify all 5 group triggers exist and are named correctly
    const groupMap: Record<string, { title: string; items: AdminTab[] }> = {
      overview: {
        title: '业务概览',
        items: ['dashboard', 'orders', 'recharge', 'logs'],
      },
      merchant_settlement: {
        title: '商家与结算',
        items: ['merchants', 'settlements'],
      },
      product_delivery: {
        title: '商品与交付',
        items: ['products', 'faka', 'merchandising', 'catalogGovernance'],
      },
      user_risk: {
        title: '用户与风控',
        items: ['users', 'abuse', 'audit'],
      },
      system_ops: {
        title: '系统与运维',
        items: ['files', 'storage', 'announcements', 'config', 'backup'],
      },
    }

    let totalRenderedItems = 0
    for (const [groupId, { title, items }] of Object.entries(groupMap)) {
      const trigger = screen.getByTestId(`admin-nav-group-trigger-${groupId}`)
      expect(trigger).toHaveTextContent(title)

      const region = document.getElementById(`admin-nav-group-${groupId}`)
      expect(region).toBeInTheDocument()

      for (const itemId of items) {
        const itemBtn = screen.getByTestId(`admin-nav-item-${itemId}`)
        expect(itemBtn).toBeInTheDocument()
        expect(region?.contains(itemBtn)).toBe(true)
        totalRenderedItems++
      }
    }

    expect(totalRenderedItems).toBe(18)
  })

  it('supports multi-expand disclosure on desktop with aria-expanded and aria-controls', () => {
    const onTabChange = vi.fn()
    render(<AdminNav activeTab="dashboard" onTabChange={onTabChange} />)

    // Non-active group: merchant_settlement
    const merchantsTrigger = screen.getByTestId('admin-nav-group-trigger-merchant_settlement')
    expect(merchantsTrigger).toHaveAttribute('aria-expanded', 'true')
    expect(merchantsTrigger).toHaveAttribute('aria-controls', 'admin-nav-group-merchant_settlement')

    const merchantsRegion = document.getElementById('admin-nav-group-merchant_settlement')
    expect(merchantsRegion).not.toHaveAttribute('hidden')

    // Click to collapse
    fireEvent.click(merchantsTrigger)
    expect(merchantsTrigger).toHaveAttribute('aria-expanded', 'false')
    expect(merchantsRegion).toHaveAttribute('hidden')

    // Other non-active groups remain independent (e.g. system_ops still expanded)
    const systemTrigger = screen.getByTestId('admin-nav-group-trigger-system_ops')
    expect(systemTrigger).toHaveAttribute('aria-expanded', 'true')

    // Click again to re-expand
    fireEvent.click(merchantsTrigger)
    expect(merchantsTrigger).toHaveAttribute('aria-expanded', 'true')
    expect(merchantsRegion).not.toHaveAttribute('hidden')
  })

  it('prevents the active group from being collapsed to keep the current location visible', () => {
    const onTabChange = vi.fn()
    render(<AdminNav activeTab="dashboard" onTabChange={onTabChange} />)

    // Active group for 'dashboard' is 'overview'
    const overviewTrigger = screen.getByTestId('admin-nav-group-trigger-overview')
    expect(overviewTrigger).toHaveAttribute('aria-expanded', 'true')
    const overviewRegion = document.getElementById('admin-nav-group-overview')
    expect(overviewRegion).not.toHaveAttribute('hidden')

    // Attempting to collapse the active group must be a no-op
    fireEvent.click(overviewTrigger)
    expect(overviewTrigger).toHaveAttribute('aria-expanded', 'true')
    expect(overviewRegion).not.toHaveAttribute('hidden')
  })

  it('marks the active tab with aria-current="page" and calls onTabChange when clicked', () => {
    const onTabChange = vi.fn()
    render(<AdminNav activeTab="merchants" onTabChange={onTabChange} />)

    const merchantsItem = screen.getByTestId('admin-nav-item-merchants')
    expect(merchantsItem).toHaveAttribute('aria-current', 'page')

    const settlementsItem = screen.getByTestId('admin-nav-item-settlements')
    expect(settlementsItem).not.toHaveAttribute('aria-current')

    fireEvent.click(settlementsItem)
    expect(onTabChange).toHaveBeenCalledWith('settlements')
  })

  it('automatically expands a collapsed group when its tab becomes active', () => {
    const onTabChange = vi.fn()
    const { rerender } = render(<AdminNav activeTab="dashboard" onTabChange={onTabChange} />)

    // Collapse product_delivery group
    const productTrigger = screen.getByTestId('admin-nav-group-trigger-product_delivery')
    fireEvent.click(productTrigger)
    expect(productTrigger).toHaveAttribute('aria-expanded', 'false')

    // Switch activeTab to 'products'
    rerender(<AdminNav activeTab="products" onTabChange={onTabChange} />)

    // Group should automatically re-expand
    expect(productTrigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('provides accessible Radix mobile drawer with focus trap, explicit close button, and focus return to trigger', async () => {
    const onTabChange = vi.fn()
    render(<AdminNav activeTab="dashboard" onTabChange={onTabChange} />)

    const trigger = screen.getByTestId('admin-mobile-nav-trigger')
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveTextContent('业务概览')
    expect(trigger).toHaveTextContent('数据仪表盘')
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    // Initial state: drawer not open
    expect(screen.queryByTestId('admin-mobile-nav-drawer')).not.toBeInTheDocument()

    // 1. Open drawer and check focus enters drawer
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    const drawer = await screen.findByTestId('admin-mobile-nav-drawer')
    expect(drawer).toBeInTheDocument()
    expect(drawer).toHaveAttribute('role', 'dialog')
    expect(drawer).toHaveAttribute('aria-modal', 'true')

    // Focus has moved inside the drawer
    await waitFor(() => {
      expect(drawer.contains(document.activeElement)).toBe(true)
    })

    // 2. Click explicit close button and verify focus returns to trigger
    const closeBtn = screen.getByTestId('admin-mobile-nav-close')
    expect(closeBtn).toBeInTheDocument()
    fireEvent.click(closeBtn)

    await waitFor(() => {
      expect(screen.queryByTestId('admin-mobile-nav-drawer')).not.toBeInTheDocument()
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(trigger)

    // 3. Open drawer again and test Escape key closes and returns focus
    fireEvent.click(trigger)
    await screen.findByTestId('admin-mobile-nav-drawer')
    fireEvent.keyDown(document.activeElement || window, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByTestId('admin-mobile-nav-drawer')).not.toBeInTheDocument()
    })
    expect(document.activeElement).toBe(trigger)

    // 4. Open drawer again and test item selection closes and returns focus
    fireEvent.click(trigger)
    const mobileMerchantBtn = await screen.findByTestId('admin-mobile-nav-item-merchants')
    fireEvent.click(mobileMerchantBtn)

    expect(onTabChange).toHaveBeenCalledWith('merchants')
    await waitFor(() => {
      expect(screen.queryByTestId('admin-mobile-nav-drawer')).not.toBeInTheDocument()
    })
    expect(document.activeElement).toBe(trigger)
  })
})
