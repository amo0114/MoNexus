import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ProductAvailabilityStep from './ProductAvailabilityStep'
import { catalogFixtureOffers } from '../../api/catalog.fixtures'

/**
 * ProductAvailabilityStep contract/a11y tests (T-CAT-FE-001A, spec §8.1-§8.3,
 * D-CAT-12/13/14).
 *
 * Every availability mutation is Offer-scoped and mutually exclusive:
 * instant_inventory → import/void, limited non-instant → capacity, unlimited →
 * no restock. The step never treats Product.stock as an operation target.
 */
describe('ProductAvailabilityStep (spec §8.1, D-CAT-12/13)', () => {
  it('renders an empty state when the product has no Offers', () => {
    render(<ProductAvailabilityStep offers={[]} />)
    expect(screen.getByTestId('availability-empty')).toHaveTextContent('请先添加规格。')
    expect(screen.queryByTestId('availability-offer-select')).not.toBeInTheDocument()
  })

  it('defaults to the first Offer and shows the inventory panel for instant_inventory', () => {
    const onOpenImport = vi.fn()
    const onVoidInventory = vi.fn()
    render(
      <ProductAvailabilityStep
        offers={catalogFixtureOffers}
        onOpenImport={onOpenImport}
        onVoidInventory={onVoidInventory}
      />,
    )
    expect(screen.getByTestId('availability-offer-select')).toHaveValue('42')
    expect(screen.getByTestId('availability-inventory')).toBeInTheDocument()
    expect(screen.queryByTestId('availability-capacity-form')).not.toBeInTheDocument()

    // Import opens the delivery-inventory flow for the target Offer.
    fireEvent.click(screen.getByTestId('availability-open-import'))
    expect(onOpenImport).toHaveBeenCalledWith(42)
  })

  it('exposes Offer-first selection with the mutual-exclusion action word on each option', () => {
    render(<ProductAvailabilityStep offers={catalogFixtureOffers} />)
    expect(screen.getByRole('option', { name: '月卡（导入 / 作废交付库存）' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '季卡（调整可售名额）' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '终身卡（无需补库存）' })).toBeInTheDocument()
  })

  it('switches to a capacity form for a limited non-instant Offer', () => {
    render(<ProductAvailabilityStep offers={catalogFixtureOffers} />)
    fireEvent.change(screen.getByTestId('availability-offer-select'), { target: { value: '43' } })
    expect(screen.getByTestId('availability-capacity-form')).toBeInTheDocument()
    // Offer-scoped current stock (never Product.stock).
    expect(screen.getByTestId('availability-current-stock')).toHaveTextContent('5')
    expect(screen.getByRole('button', { name: '调整可售名额' })).toBeInTheDocument()
  })

  it('shows the no-restock state for unlimited Offers (spec §8.1)', () => {
    render(<ProductAvailabilityStep offers={catalogFixtureOffers} />)
    fireEvent.change(screen.getByTestId('availability-offer-select'), { target: { value: '44' } })
    expect(screen.getByTestId('availability-none')).toHaveTextContent('该规格不限量，无需补充库存。')
  })

  it('submits an Offer-scoped capacity adjustment (D-CAT-12/13)', async () => {
    const onAdjustCapacity = vi.fn()
    render(<ProductAvailabilityStep offers={catalogFixtureOffers} onAdjustCapacity={onAdjustCapacity} />)
    fireEvent.change(screen.getByTestId('availability-offer-select'), { target: { value: '43' } })

    fireEvent.change(screen.getByTestId('availability-capacity-delta'), { target: { value: '5' } })
    fireEvent.change(screen.getByTestId('availability-capacity-reason'), { target: { value: '补货' } })
    fireEvent.click(screen.getByTestId('availability-capacity-submit'))

    expect(onAdjustCapacity).toHaveBeenCalledWith({ offerId: 43, delta: 5, reason: '补货' })
    await waitFor(() => expect(screen.getByTestId('availability-capacity-delta')).toHaveValue(null))
    await waitFor(() => expect(screen.getByTestId('availability-capacity-reason')).toHaveValue(''))
  })

  it('blocks invalid capacity submits (empty / zero / would-go-negative / no reason)', () => {
    const onAdjustCapacity = vi.fn()
    render(<ProductAvailabilityStep offers={catalogFixtureOffers} onAdjustCapacity={onAdjustCapacity} />)
    fireEvent.change(screen.getByTestId('availability-offer-select'), { target: { value: '43' } })

    const submit = screen.getByTestId('availability-capacity-submit')
    const delta = screen.getByTestId('availability-capacity-delta')
    const reason = screen.getByTestId('availability-capacity-reason')

    expect(submit).toBeDisabled()
    fireEvent.change(delta, { target: { value: '0' } })
    expect(submit).toBeDisabled()
    // current 5, delta -6 would underflow → blocked.
    fireEvent.change(delta, { target: { value: '-6' } })
    expect(submit).toBeDisabled()
    // Valid delta but still no reason.
    fireEvent.change(delta, { target: { value: '5' } })
    expect(submit).toBeDisabled()
    fireEvent.click(submit)
    expect(onAdjustCapacity).not.toHaveBeenCalled()
  })

  it('submits an Offer-scoped inventory void and clears the form (spec §8.3)', async () => {
    const onVoidInventory = vi.fn()
    render(<ProductAvailabilityStep offers={catalogFixtureOffers} onVoidInventory={onVoidInventory} />)

    fireEvent.change(screen.getByTestId('availability-void-count'), { target: { value: '3' } })
    fireEvent.change(screen.getByTestId('availability-void-reason'), { target: { value: '失效' } })
    fireEvent.click(screen.getByTestId('availability-void-submit'))

    expect(onVoidInventory).toHaveBeenCalledWith({ offerId: 42, count: 3, reason: '失效' })
    await waitFor(() => expect(screen.getByTestId('availability-void-count')).toHaveValue(null))
    await waitFor(() => expect(screen.getByTestId('availability-void-reason')).toHaveValue(''))
  })

  it('blocks invalid void submits (zero / non-integer / no reason)', () => {
    const onVoidInventory = vi.fn()
    render(<ProductAvailabilityStep offers={catalogFixtureOffers} onVoidInventory={onVoidInventory} />)

    const submit = screen.getByTestId('availability-void-submit')
    const count = screen.getByTestId('availability-void-count')
    expect(submit).toBeDisabled()
    fireEvent.change(count, { target: { value: '0' } })
    expect(submit).toBeDisabled()
    fireEvent.change(count, { target: { value: '1.5' } })
    expect(submit).toBeDisabled()
    fireEvent.change(count, { target: { value: '3' } })
    expect(submit).toBeDisabled() // reason empty
    fireEvent.click(submit)
    expect(onVoidInventory).not.toHaveBeenCalled()
  })

  it('guards duplicate submits while a void is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const onVoidInventory = vi.fn(() => gate)
    render(<ProductAvailabilityStep offers={catalogFixtureOffers} onVoidInventory={onVoidInventory} />)

    fireEvent.change(screen.getByTestId('availability-void-count'), { target: { value: '1' } })
    fireEvent.change(screen.getByTestId('availability-void-reason'), { target: { value: '失效' } })
    fireEvent.click(screen.getByTestId('availability-void-submit'))

    expect(onVoidInventory).toHaveBeenCalledTimes(1)
    // In-flight lock: submit is disabled and a second click cannot fire again.
    expect(screen.getByTestId('availability-void-submit')).toBeDisabled()
    fireEvent.click(screen.getByTestId('availability-void-submit'))
    expect(onVoidInventory).toHaveBeenCalledTimes(1)

    await act(async () => {
      release()
      await gate
    })
    // Successful void clears the form (so the button is disabled for empty inputs).
    await waitFor(() => expect(screen.getByTestId('availability-void-count')).toHaveValue(null))
    expect(screen.getByTestId('availability-void-submit')).toBeDisabled()

    // The in-flight lock is released: refilling the form re-enables the CTA.
    fireEvent.change(screen.getByTestId('availability-void-count'), { target: { value: '2' } })
    fireEvent.change(screen.getByTestId('availability-void-reason'), { target: { value: '补货' } })
    await waitFor(() => expect(screen.getByTestId('availability-void-submit')).toBeEnabled())
  })

  it('is accessible: labelled controls, Offer-first region, no duplicate ids', () => {
    render(
      <ProductAvailabilityStep
        offers={catalogFixtureOffers}
        onOpenImport={vi.fn()}
        onVoidInventory={vi.fn()}
        onAdjustCapacity={vi.fn()}
      />,
    )
    expect(screen.getByRole('region', { name: '可售量配置' })).toBeInTheDocument()
    // Target-offer select is labelled.
    expect(screen.getByLabelText('目标规格')).toBe(screen.getByTestId('availability-offer-select'))
    // Void controls are labelled.
    expect(screen.getByLabelText(/^作废数量/)).toBe(screen.getByTestId('availability-void-count'))
    expect(screen.getByLabelText(/^作废原因/)).toBe(screen.getByTestId('availability-void-reason'))

    // Capacity controls get their own labels after switching to a capacity Offer
    // (regression: the delta input used to share the offer-select id).
    fireEvent.change(screen.getByTestId('availability-offer-select'), { target: { value: '43' } })
    expect(screen.getByLabelText(/^调整数量/)).toBe(screen.getByTestId('availability-capacity-delta'))
    expect(screen.getByLabelText(/^调整原因/)).toBe(screen.getByTestId('availability-capacity-reason'))

    const ids = Array.from(document.querySelectorAll<HTMLElement>('[id]')).map((el) => el.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
