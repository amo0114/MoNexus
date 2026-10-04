import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ProductTemplateDefinition } from '../../../../types/catalog'
import PricingStep from './PricingStep'
import DeliveryStep from './DeliveryStep'
import { DEFAULT_OFFER_NAME, type ExtraOffer, type FixedContentType } from './wizardStepTypes'

/**
 * R02 step contract: the extracted pricing/delivery steps are controlled —
 * values come in as props, edits leave as callbacks, and nothing is saved here.
 * Fulfillment coercion and validation stay in the parent (wizard suite covers that).
 */

type PricingProps = Parameters<typeof PricingStep>[0]
type DeliveryProps = Parameters<typeof DeliveryStep>[0]

const NAME_PLACEHOLDER = '如：季卡 / 256G / 美区'
const AVAILABILITY = { mode: '可售名额模式', unlimited: '不限可售名额', limited: '限量可售名额' }

function makeOffer(overrides: Partial<ExtraOffer> = {}): ExtraOffer {
  return {
    name: '',
    price: '',
    originalPrice: '',
    deliveryMode: 'instant_fixed',
    stockMode: 'unlimited',
    fixedContent: '',
    fixedContentType: 'text',
    validityDays: '',
    attributes: {},
    deliveryFields: [],
    structuredFields: [],
    structuredValues: {},
    ...overrides,
  }
}

const stubTemplate: ProductTemplateDefinition = {
  key: 'fixed_content',
  version: 1,
  label: '固定数字内容',
  productSchema: { type: 'object', properties: {}, required: [] },
  offerSchema: {
    type: 'object',
    properties: { unitLabel: { type: 'string', title: '销售单位' } },
    required: [],
  },
  ui: { productOrder: [], offerOrder: ['unitLabel'], widgets: { unitLabel: 'text' } },
  fulfillmentRules: [{
    whenProductAttributes: {},
    configurations: ['fixed_text'],
    requireStructuredDelivery: 'none',
    requireRequiredDateField: false,
  }],
}

function pricingProps(overrides: Partial<PricingProps> = {}): PricingProps {
  return {
    primaryOfferName: DEFAULT_OFFER_NAME,
    onPrimaryOfferNameChange: vi.fn(),
    price: '',
    onPriceChange: vi.fn(),
    originalPrice: '',
    onOriginalPriceChange: vi.fn(),
    validityDays: '',
    onValidityDaysChange: vi.fn(),
    template: null,
    primaryOfferAttributes: {},
    onPrimaryOfferAttributesChange: vi.fn(),
    extraOffers: [],
    onExtraOfferChange: vi.fn(),
    onExtraOfferDeliveryModeChange: vi.fn(),
    onExtraOfferRemove: vi.fn(),
    onAddExtraOffer: vi.fn(),
    requirementFor: () => 'none',
    allowedFixedTypes: ['text'] as FixedContentType[],
    deliveryModeOptions: [{ value: 'instant_fixed', label: '固定内容' }],
    ...overrides,
  }
}

function renderPricing(overrides: Partial<PricingProps> = {}) {
  const props = pricingProps(overrides)
  render(<PricingStep {...props} />)
  return props
}

function deliveryProps(overrides: Partial<DeliveryProps> = {}): DeliveryProps {
  return {
    deliveryMode: 'instant_fixed',
    onDeliveryModeChange: vi.fn(),
    requirement: 'none',
    allowedFixedTypes: ['text', 'url'] as FixedContentType[],
    deliveryModeOptions: [
      { value: 'instant_fixed', label: '固定内容' },
      { value: 'instant_inventory', label: '交付库存' },
    ],
    deliveryFields: [],
    onDeliveryFieldsChange: vi.fn(),
    structuredFields: [],
    structuredValues: {},
    onStructuredFieldsChange: vi.fn(),
    onStructuredValuesChange: vi.fn(),
    fixedContentType: 'text',
    onFixedContentTypeChange: vi.fn(),
    fixedContent: '',
    onFixedContentChange: vi.fn(),
    stockMode: 'unlimited',
    onStockModeChange: vi.fn(),
    availabilityLabels: AVAILABILITY,
    ...overrides,
  }
}

function renderDelivery(overrides: Partial<DeliveryProps> = {}) {
  const props = deliveryProps(overrides)
  render(<DeliveryStep {...props} />)
  return props
}

describe('PricingStep', () => {
  it('mirrors the primary offer values and emits edits without owning state', () => {
    const props = renderPricing({ price: '100', originalPrice: '200', validityDays: '30' })

    const price = screen.getByTestId('wizard-price')
    expect(price).toHaveValue(100)
    expect(screen.getByTestId('wizard-validity-days')).toHaveValue(30)

    fireEvent.change(price, { target: { value: '150' } })
    expect(props.onPriceChange).toHaveBeenCalledWith('150')
    // Controlled input: the DOM keeps the incoming prop until the parent re-renders.
    expect(price).toHaveValue(100)
  })

  it('defaults the primary offer name placeholder to the shared constant', () => {
    renderPricing()
    expect(screen.getByTestId('wizard-primary-offer-name')).toHaveAttribute('placeholder', DEFAULT_OFFER_NAME)
  })

  it('renders the primary offer attribute block only when the template defines offerOrder', () => {
    const { unmount } = render(<PricingStep {...pricingProps()} />)
    expect(screen.queryByTestId('wizard-primary-offer-attributes')).not.toBeInTheDocument()
    unmount()

    render(<PricingStep {...pricingProps({ template: stubTemplate })} />)
    expect(screen.getByTestId('wizard-primary-offer-attributes')).toBeInTheDocument()
  })
})

describe('PricingStep / ExtraOfferEditor', () => {
  it('adds an extra offer by callback only', () => {
    const props = renderPricing()
    fireEvent.click(screen.getByTestId('wizard-extra-offer-add'))
    expect(props.onAddExtraOffer).toHaveBeenCalledTimes(1)
  })

  it('edits an extra offer field through a positional patch', () => {
    const props = renderPricing({ extraOffers: [makeOffer({ name: '季卡', price: '80' })] })
    const row = screen.getByTestId('wizard-extra-offer-0')

    expect(row.querySelector<HTMLInputElement>(`input[placeholder="${NAME_PLACEHOLDER}"]`)!).toHaveValue('季卡')

    fireEvent.change(row.querySelector(`input[placeholder="${NAME_PLACEHOLDER}"]`)!, {
      target: { value: '月卡' },
    })
    expect(props.onExtraOfferChange).toHaveBeenCalledWith(0, { name: '月卡' })
  })

  it('removes the addressed extra offer', () => {
    const props = renderPricing({ extraOffers: [makeOffer(), makeOffer()] })
    fireEvent.click(screen.getByTestId('wizard-extra-offer-remove-1'))
    expect(props.onExtraOfferRemove).toHaveBeenCalledWith(1)
  })

  it('reports a delivery-mode change instead of coercing it in the step', () => {
    const props = renderPricing({ extraOffers: [makeOffer()] })
    const select = screen.getByTestId('wizard-extra-offer-0').querySelector('select')!
    fireEvent.change(select, { target: { value: 'instant_fixed' } })
    expect(props.onExtraOfferDeliveryModeChange).toHaveBeenCalledWith(0, 'instant_fixed')
  })

  it('shows the row requirement editors from the parent-resolved requirement', () => {
    const { unmount } = render(
      <PricingStep {...pricingProps({
        extraOffers: [makeOffer()],
        requirementFor: () => 'inventory_fields',
      })} />,
    )
    expect(screen.getByTestId('wizard-extra-offer-0-delivery-fields')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-extra-offer-0-structured-content')).not.toBeInTheDocument()
    unmount()

    render(
      <PricingStep {...pricingProps({
        extraOffers: [makeOffer()],
        requirementFor: () => 'fixed_fields',
      })} />,
    )
    expect(screen.getByTestId('wizard-extra-offer-0-structured-content')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-extra-offer-0-delivery-fields')).not.toBeInTheDocument()
  })
})

describe('DeliveryStep', () => {
  it('shows the fixed-content editor and reports edits', () => {
    const props = renderDelivery({ fixedContent: 'ticket-1' })
    const input = screen.getByTestId('fixed-content-input')
    expect(input).toHaveValue('ticket-1')
    fireEvent.change(input, { target: { value: 'ticket-2' } })
    expect(props.onFixedContentChange).toHaveBeenCalledWith('ticket-2')
  })

  it('swaps to a url input without changing the test id when the type is url', () => {
    renderDelivery({ fixedContentType: 'url' })
    expect(screen.getByTestId('fixed-content-input').tagName).toBe('INPUT')
  })

  it('renders the delivery fields editor only for the inventory_fields requirement', () => {
    const { unmount } = render(
      <DeliveryStep {...deliveryProps({ requirement: 'inventory_fields', deliveryMode: 'instant_inventory' })} />,
    )
    expect(screen.getByTestId('wizard-delivery-fields')).toBeInTheDocument()
    unmount()

    render(<DeliveryStep {...deliveryProps({ requirement: 'none', deliveryMode: 'instant_inventory' })} />)
    expect(screen.queryByTestId('wizard-delivery-fields')).not.toBeInTheDocument()
  })

  it('hides the stock-mode block for instant_inventory only', () => {
    const { unmount } = render(<DeliveryStep {...deliveryProps({ deliveryMode: 'instant_inventory' })} />)
    expect(screen.queryByTestId('stock-mode-select')).not.toBeInTheDocument()
    unmount()

    render(<DeliveryStep {...deliveryProps({ deliveryMode: 'manual_service' })} />)
    expect(screen.getByTestId('stock-mode-select')).toBeInTheDocument()
  })

  it('uses the parent-supplied availability labels', () => {
    renderDelivery({
      deliveryMode: 'manual_service',
      availabilityLabels: { mode: '服务名额模式', unlimited: '不限服务名额', limited: '限量服务名额' },
    })
    expect(screen.getByTestId('stock-mode-select')).toHaveTextContent('不限服务名额')
  })

  it('prefers the file hint over the structured editor when the type is file', () => {
    renderDelivery({ requirement: 'fixed_fields', fixedContentType: 'file' })
    expect(screen.queryByTestId('wizard-structured-content')).not.toBeInTheDocument()
    expect(screen.queryByTestId('fixed-content-input')).not.toBeInTheDocument()
  })

  it('reports the chosen delivery mode without preserving stock coercion', () => {
    const props = renderDelivery({ deliveryMode: 'instant_fixed' })
    const inventory = screen.getByRole('radio', { name: '交付库存' })
    fireEvent.click(inventory)
    expect(props.onDeliveryModeChange).toHaveBeenCalledWith('instant_inventory')
  })
})
