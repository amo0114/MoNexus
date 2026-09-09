import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import ProductCreatePage from './ProductCreatePage'

vi.mock('../../components/catalog/AdminPlatformProductWizard', () => ({
  default: ({
    open,
    onClose,
    onCreated,
  }: {
    open: boolean
    onClose: () => void
    onCreated: (productId: number) => void
  }) =>
    open ? (
      <div data-testid="mock-platform-wizard">
        <button type="button" data-testid="mock-wizard-close" onClick={onClose}>
          Close
        </button>
        <button type="button" data-testid="mock-wizard-created" onClick={() => onCreated(99)}>
          Trigger Created
        </button>
      </div>
    ) : null,
}))

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location-pathname">{location.pathname}</div>
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/products/new']}>
      <Routes>
        <Route path="/admin/products/new" element={<ProductCreatePage />} />
        <Route path="/admin" element={<div data-testid="admin-home">Admin</div>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  )
}

describe('ProductCreatePage', () => {
  it('renders heading, back control, and an open wizard', () => {
    renderPage()
    expect(screen.getByTestId('admin-product-create-page')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '新建平台商品' })).toBeInTheDocument()
    expect(screen.getByTestId('admin-product-create-back')).toBeInTheDocument()
    expect(screen.getByTestId('mock-platform-wizard')).toBeInTheDocument()
  })

  it('navigates to /admin from the back control', () => {
    renderPage()
    fireEvent.click(screen.getByTestId('admin-product-create-back'))
    expect(screen.getByTestId('location-pathname')).toHaveTextContent('/admin')
    expect(screen.getByTestId('admin-home')).toBeInTheDocument()
  })

  it('navigates to /admin when the wizard closes', () => {
    renderPage()
    fireEvent.click(screen.getByTestId('mock-wizard-close'))
    expect(screen.getByTestId('location-pathname')).toHaveTextContent('/admin')
  })

  it('navigates to /admin after create', () => {
    renderPage()
    fireEvent.click(screen.getByTestId('mock-wizard-created'))
    expect(screen.getByTestId('location-pathname')).toHaveTextContent('/admin')
  })
})
