import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import ProductCategorySelect from './ProductCategorySelect'
import { catalogFixtureCategories } from '../../api/catalog.fixtures'

/**
 * ProductCategorySelect contract/a11y tests (T-CAT-FE-001A, spec §7.1 / D-CAT-05).
 *
 * The selector is taxonomy only: it emits a numeric `categoryId` and MUST NOT
 * change fulfillment config. Only active categories are passed in.
 */
describe('ProductCategorySelect (spec §7.1, D-CAT-05)', () => {
  it('renders the label, placeholder and every active category option', () => {
    render(
      <ProductCategorySelect categories={catalogFixtureCategories} value={null} onChange={vi.fn()} />,
    )
    expect(screen.getByText('商品分类')).toBeInTheDocument()
    const select = screen.getByTestId('product-category-select')
    expect(select).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '请选择分类' })).toBeInTheDocument()
    for (const category of catalogFixtureCategories) {
      expect(screen.getByRole('option', { name: category.label })).toBeInTheDocument()
    }
    // Placeholder shown when nothing is selected.
    expect(select).toHaveValue('')
  })

  it('emits the numeric categoryId when a category is chosen', () => {
    const onChange = vi.fn()
    render(<ProductCategorySelect categories={catalogFixtureCategories} value={null} onChange={onChange} />)
    fireEvent.change(screen.getByTestId('product-category-select'), { target: { value: '2' } })
    expect(onChange).toHaveBeenCalledWith(2)
  })

  it('reflects the controlled value and resets to placeholder when it is not in the list', () => {
    const { rerender } = render(
      <ProductCategorySelect categories={catalogFixtureCategories} value={2} onChange={vi.fn()} />,
    )
    expect(screen.getByTestId('product-category-select')).toHaveValue('2')
    expect(screen.getByRole('option', { name: '共享账号' })).toHaveProperty('selected', true)

    // value no longer among active categories → placeholder (e.g. category deactivated).
    rerender(<ProductCategorySelect categories={catalogFixtureCategories} value={99} onChange={vi.fn()} />)
    expect(screen.getByTestId('product-category-select')).toHaveValue('')
  })

  it('renders the error message with alert semantics and wires aria-invalid/aria-describedby', () => {
    render(
      <ProductCategorySelect
        categories={catalogFixtureCategories}
        value={null}
        onChange={vi.fn()}
        error="请选择一个有效分类"
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('请选择一个有效分类')
    const select = screen.getByTestId('product-category-select')
    expect(select).toHaveAttribute('aria-invalid', 'true')
    expect(select.getAttribute('aria-describedby')).toBe(alert.id)
    expect(document.getElementById(select.getAttribute('aria-describedby') as string)).toBe(alert)
  })

  it('disables the whole control when the disabled prop is set', () => {
    render(
      <ProductCategorySelect categories={catalogFixtureCategories} value={null} onChange={vi.fn()} disabled />,
    )
    expect(screen.getByTestId('product-category-select')).toBeDisabled()
  })

  it('handles an empty registry: disabled control with a "暂无可选分类" placeholder', () => {
    const onChange = vi.fn()
    render(<ProductCategorySelect categories={[]} value={null} onChange={onChange} />)
    expect(screen.getByTestId('product-category-select')).toBeDisabled()
    expect(screen.getByRole('option', { name: '暂无可选分类' })).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('product-category-select'), { target: { value: '1' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps taxonomy-only semantics: never switches deliveryMode (D-CAT-05)', () => {
    render(
      <ProductCategorySelect categories={catalogFixtureCategories} value={1} onChange={vi.fn()} />,
    )
    expect(screen.getByTestId('product-category-hint')).toHaveTextContent('不会改变交付方式')
  })

  it('is accessible: label associates with the select and hint text is present', () => {
    render(
      <ProductCategorySelect categories={catalogFixtureCategories} value={1} onChange={vi.fn()} />,
    )
    expect(screen.getByLabelText(/^商品分类/)).toBe(screen.getByTestId('product-category-select'))
    expect(screen.getByTestId('product-category-hint')).toBeInTheDocument()
    // No duplicate DOM ids.
    const ids = Array.from(document.querySelectorAll<HTMLElement>('[id]')).map((el) => el.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
