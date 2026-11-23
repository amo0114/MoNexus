import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import RouteFallback, { StandaloneRouteFallback, routeFallbackKind } from './RouteFallback'

describe('routeFallbackKind', () => {
  it.each([
    ['/product/42', 'product'],
    ['/shops/7', 'storefront'],
    ['/orders', 'list'],
    ['/notifications', 'list'],
    ['/leaderboard', 'list'],
    ['/profile', 'page'],
    ['/recharge', 'form'],
    ['/admin', 'workspace'],
    ['/admin/products/new', 'form'],
    ['/admin/products/9/edit', 'form'],
    ['/merchant/apply', 'form'],
    ['/merchant/products/new', 'form'],
    ['/merchant/products/9/edit', 'form'],
    ['/merchant/dashboard', 'workspace'],
    ['/merchant/workbench', 'workspace'],
    ['/merchant/promotions', 'workspace'],
    ['/merchant/orders', 'workspace'],
    ['/some-future-page', 'page'],
    ['/product/42/extra', 'page'],
    ['/administrator', 'page'],
    // React Router matches these too (case-insensitive, extra slashes), so must the fallback.
    ['/PRODUCT/42', 'product'],
    ['/product/42/', 'product'],
    ['/product/42//', 'product'],
    ['/Orders', 'list'],
    ['/admin/', 'workspace'],
  ])('%s → %s', (pathname, kind) => {
    expect(routeFallbackKind(pathname)).toBe(kind)
  })
})

function renderAt(pathname: string) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <RouteFallback />
    </MemoryRouter>,
  )
}

describe('RouteFallback', () => {
  // Independent of test ids: the old fallback was a grid of six identical cards.
  function cardGrids(container: HTMLElement) {
    return [...container.querySelectorAll('[class*="grid-cols"]')].filter((el) => el.children.length >= 6)
  }

  it.each(['/product/42', '/orders', '/leaderboard', '/notifications', '/profile', '/recharge', '/admin', '/merchant/dashboard', '/merchant/products/new', '/some-future-page'])(
    'does not pose as a product grid on %s',
    (pathname) => {
      const { container } = renderAt(pathname)
      expect(cardGrids(container)).toHaveLength(0)
    },
  )

  it.each([
    ['/orders', 'route-fallback-row'],
    ['/notifications', 'route-fallback-row'],
    ['/leaderboard', 'route-fallback-row'],
    ['/admin', 'route-fallback-nav'],
    ['/merchant/dashboard', 'route-fallback-nav'],
    ['/recharge', 'route-fallback-field'],
    ['/merchant/products/new', 'route-fallback-field'],
  ])('renders the page-type structure on %s', (pathname, testId) => {
    renderAt(pathname)
    expect(screen.getAllByTestId(testId).length).toBeGreaterThan(0)
  })

  it('renders the product detail skeleton for product routes', () => {
    renderAt('/product/42')
    expect(screen.getByTestId('product-detail-skeleton')).toBeInTheDocument()
  })

  it('keeps a grid for the shop page aligned with ShopPage breakpoints', () => {
    const { container } = renderAt('/shops/7')
    const grid = screen.getByTestId('route-fallback-grid')
    expect(grid).toBeInTheDocument()
    expect(grid.className).toContain('xl:grid-cols-4')
    expect(grid.className).not.toContain('lg:grid-cols-4')
    expect(cardGrids(container)).toHaveLength(1)
  })

  it('aligns orders fallback to the two-column order card grid', () => {
    renderAt('/orders')
    const grid = screen.getByTestId('order-card-skeleton-grid')
    expect(grid.className).toContain('md:grid-cols-2')
    expect(screen.getAllByTestId('route-fallback-row')).toHaveLength(4)
  })

  it('aligns notifications fallback to the centered max-w-3xl message list', () => {
    renderAt('/notifications')
    const container = screen.getByTestId('notifications-fallback')
    expect(container.className).toContain('max-w-3xl')
    expect(container.className).toContain('mx-auto')
    expect(screen.getAllByTestId('route-fallback-row')).toHaveLength(4)
  })

  it('aligns workspace sidebar breakpoints for admin (xl/w-56) vs merchant (md/w-64)', () => {
    const admin = renderAt('/admin')
    const adminNav = screen.getByTestId('route-fallback-nav')
    expect(adminNav.className).toContain('xl:block')
    expect(adminNav.className).toContain('w-56')
    admin.unmount()

    renderAt('/merchant/dashboard')
    const merchantNav = screen.getByTestId('route-fallback-nav')
    expect(merchantNav.className).toContain('md:block')
    expect(merchantNav.className).toContain('w-64')
  })

  it('aligns product detail offers skeleton to 2-col mid / 3-col xl grid', () => {
    const { container } = renderAt('/product/42')
    const offers = container.querySelector('[data-skeleton-part="offers"]')
    expect(offers).not.toBeNull()
    expect(offers?.className).toContain('grid-cols-2')
    expect(offers?.className).toContain('xl:grid-cols-3')
    expect(offers?.children).toHaveLength(3)
  })

  it.each(['/product/42', '/shops/7', '/orders', '/admin', '/recharge', '/profile'])(
    'exposes a single inert loading status on %s',
    (pathname) => {
      const { container } = renderAt(pathname)
      expect(screen.getAllByRole('status')).toHaveLength(1)
      expect(screen.getByRole('status', { name: '正在加载页面' })).toBeInTheDocument()
      expect(container.querySelectorAll('a, button, input, select, textarea, [tabindex]')).toHaveLength(0)
    },
  )
})

describe('StandaloneRouteFallback', () => {
  it('is a visible, labelled, inert status instead of a blank screen', () => {
    const { container } = render(<StandaloneRouteFallback />)
    const status = screen.getByRole('status', { name: '正在加载页面' })
    expect(status.children.length).toBeGreaterThan(0)
    expect(container.querySelectorAll('a, button, input, select, textarea, [tabindex]')).toHaveLength(0)
  })
})
