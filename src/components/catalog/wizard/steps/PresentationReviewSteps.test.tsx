import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ProductDetails, ProductTemplateDefinition } from '../../../../types/catalog'
import { EMPTY_PRODUCT_DETAILS, PRODUCT_VISIBILITY } from '../../../../types/catalog'
import PresentationStep from './PresentationStep'
import DraftReviewStep from './DraftReviewStep'

/**
 * R02-2 step contract: 展示信息 and 确认草稿 are controlled projections of
 * parent state. They mirror values in, emit callbacks out, and never save,
 * validate, sanitize or fetch — those all stay in the wizard.
 */

type PresentationProps = Parameters<typeof PresentationStep>[0]
type ReviewProps = Parameters<typeof DraftReviewStep>[0]

const stubTemplate: ProductTemplateDefinition = {
  key: 'fixed_content',
  version: 1,
  label: '固定数字内容',
  productSchema: {
    type: 'object',
    properties: { serviceName: { type: 'string', title: '适用产品' } },
    required: [],
  },
  offerSchema: { type: 'object', properties: {}, required: [] },
  ui: { productOrder: ['serviceName'], offerOrder: [], widgets: { serviceName: 'text' } },
  fulfillmentRules: [{
    whenProductAttributes: {},
    configurations: ['fixed_text'],
    requireStructuredDelivery: 'none',
    requireRequiredDateField: false,
  }],
}

function presentationProps(overrides: Partial<PresentationProps> = {}): PresentationProps {
  return {
    name: '',
    onNameChange: vi.fn(),
    categories: [],
    categoryId: null,
    onCategoryIdChange: vi.fn(),
    images: [],
    imageKeys: {},
    onImagesChange: vi.fn(),
    onImageKeysChange: vi.fn(),
    description: '',
    onDescriptionChange: vi.fn(),
    visibility: PRODUCT_VISIBILITY.MEMBERS_ONLY,
    onVisibilityChange: vi.fn(),
    richDescription: null,
    onRichDescriptionChange: vi.fn(),
    onInsertDescriptionImage: vi.fn().mockResolvedValue(null),
    template: null,
    productAttributes: {},
    onProductAttributesChange: vi.fn(),
    productDetails: EMPTY_PRODUCT_DETAILS,
    onProductDetailsChange: vi.fn(),
    purchaseForm: [],
    onPurchaseFormChange: vi.fn(),
    ...overrides,
  }
}

function renderPresentation(overrides: Partial<PresentationProps> = {}) {
  const props = presentationProps(overrides)
  render(<PresentationStep {...props} />)
  return props
}

function reviewProps(overrides: Partial<ReviewProps> = {}): ReviewProps {
  return {
    name: '节点套餐',
    categoryLabel: '共享账号',
    templateName: '固定数字内容',
    visibility: PRODUCT_VISIBILITY.MEMBERS_ONLY,
    price: '100',
    deliveryMode: 'instant_fixed',
    primaryOfferName: '默认规格',
    extraOfferCount: 0,
    safePreviewHtml: '',
    ...overrides,
  }
}

describe('PresentationStep', () => {
  it('mirrors the incoming name and emits edits as a controlled input', () => {
    const props = renderPresentation({ name: '节点套餐' })
    const input = screen.getByTestId('wizard-name')
    expect(input).toHaveValue('节点套餐')

    fireEvent.change(input, { target: { value: '新的名称' } })
    expect(props.onNameChange).toHaveBeenCalledWith('新的名称')
    // Controlled: the DOM keeps the prop until the parent re-renders.
    expect(input).toHaveValue('节点套餐')
  })

  it('reports visibility through the radio group without owning it', () => {
    const props = renderPresentation({ visibility: PRODUCT_VISIBILITY.MEMBERS_ONLY })
    expect(screen.getByTestId('wizard-visibility-members_only')).toBeChecked()

    fireEvent.click(screen.getByTestId('wizard-visibility-public'))
    expect(props.onVisibilityChange).toHaveBeenCalledWith(PRODUCT_VISIBILITY.PUBLIC)
    expect(screen.getByTestId('wizard-visibility-members_only')).toBeChecked()
  })

  it('keeps the category select controlled by the parent value', () => {
    const props = renderPresentation({
      categories: [{ id: 3, label: '共享账号', slug: 'shared', isActive: true, sortOrder: 1 }],
      categoryId: null,
    })
    const select = screen.getByTestId('product-category-select') as HTMLSelectElement
    expect(select).toHaveValue('')

    fireEvent.change(select, { target: { value: '3' } })
    expect(props.onCategoryIdChange).toHaveBeenCalledWith(3)
  })

  it('delegates 图文详情 image insertion upward instead of uploading here', () => {
    const onInsertDescriptionImage = vi.fn().mockResolvedValue(null)
    const props = renderPresentation({ onInsertDescriptionImage })

    // The editor is lazily loaded behind Suspense; the step itself must not
    // touch uploads — it only hands the callback down.
    expect(props.onInsertDescriptionImage).not.toHaveBeenCalled()
    expect(screen.getByText('图文详情')).toBeInTheDocument()
  })

  it('renders the product attribute block only once a template exists', () => {
    const { unmount } = render(<PresentationStep {...presentationProps()} />)
    expect(screen.queryByTestId('wizard-product-attributes')).not.toBeInTheDocument()
    unmount()

    render(<PresentationStep {...presentationProps({ template: stubTemplate })} />)
    expect(screen.getByTestId('wizard-product-attributes')).toBeInTheDocument()
  })

  it('passes product details and purchase form callbacks through untouched', () => {
    const onProductDetailsChange = vi.fn()
    const props = renderPresentation({
      productDetails: { ...EMPTY_PRODUCT_DETAILS } as ProductDetails,
      onProductDetailsChange,
    })

    expect(screen.getByTestId('wizard-purchase-form')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('add-form-field'))
    expect(props.onPurchaseFormChange).toHaveBeenCalledTimes(1)
    expect(onProductDetailsChange).not.toHaveBeenCalled()
  })
})

describe('DraftReviewStep', () => {
  it('projects the draft summary from props', () => {
    render(<DraftReviewStep {...reviewProps()} />)

    expect(screen.getByTestId('wizard-confirm-name')).toHaveTextContent('节点套餐')
    expect(screen.getByTestId('wizard-confirm-category')).toHaveTextContent('共享账号')
    expect(screen.getByTestId('wizard-confirm-price')).toHaveTextContent('100')
  })

  it('falls back to the shared placeholders when values are missing', () => {
    render(<DraftReviewStep {...reviewProps({
      name: '',
      categoryLabel: null,
      templateName: null,
      price: '',
      primaryOfferName: '   ',
    })} />)

    expect(screen.getByTestId('wizard-confirm-name')).toHaveTextContent('（未填写）')
    expect(screen.getByTestId('wizard-confirm-category')).toHaveTextContent('（未选择）')
    expect(screen.getByTestId('wizard-confirm-price')).toHaveTextContent('0')
    // 主规格 falls back to the shared default; the buyer card shows the product name.
    expect(screen.getByTestId('wizard-step-confirm')).toHaveTextContent('默认规格')
    expect(screen.getByTestId('buyer-preview')).toHaveTextContent('（商品名称）')
  })

  it('counts the primary offer plus extras using extraOfferCount', () => {
    render(<DraftReviewStep {...reviewProps({ extraOfferCount: 2 })} />)
    expect(screen.getByTestId('wizard-step-confirm')).toHaveTextContent('3 个')
  })

  it('switches the buyer preview label only for manual_service', () => {
    const { unmount } = render(<DraftReviewStep {...reviewProps({ deliveryMode: 'manual_service' })} />)
    expect(screen.getByTestId('buyer-preview')).toHaveTextContent('本次冻结积分')
    unmount()

    render(<DraftReviewStep {...reviewProps({ deliveryMode: 'instant_fixed' })} />)
    expect(screen.getByTestId('buyer-preview')).toHaveTextContent('本次支付积分')
  })

  it('renders the parent-sanitized html verbatim and nothing when it is empty', () => {
    const { unmount } = render(<DraftReviewStep {...reviewProps({ safePreviewHtml: '' })} />)
    expect(screen.queryByText('图文详情预览')).not.toBeInTheDocument()
    unmount()

    render(<DraftReviewStep {...reviewProps({ safePreviewHtml: '<p>详情正文</p>' })} />)
    expect(screen.getByText('详情正文')).toBeInTheDocument()
  })

  it('exposes no save or publish affordance of its own', () => {
    render(<DraftReviewStep {...reviewProps()} />)
    expect(screen.queryByTestId('wizard-save-draft')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wizard-next')).not.toBeInTheDocument()
  })
})
