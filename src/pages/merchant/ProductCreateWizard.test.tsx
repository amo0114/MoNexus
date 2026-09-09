import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Dispatch, SetStateAction } from 'react'
import ProductCreateWizard from './ProductCreateWizard'

vi.mock('../../components/merchant/ProductImageUploader', () => ({
  default: function MockUploader({
    onChange,
    onImageKeysChange,
    disabled,
  }: {
    images: string[]
    onChange: Dispatch<SetStateAction<string[]>>
    onImageKeysChange?: Dispatch<SetStateAction<Record<string, string>>>
    disabled?: boolean
  }) {
    return (
      <div data-testid="product-images-uploader">
        <button
          type="button"
          data-testid="mock-add-upload-image"
          disabled={disabled}
          onClick={() => {
            const url = 'https://files.example/p.webp'
            onChange(prev => [...prev, url])
            onImageKeysChange?.(prev => ({ ...prev, [url]: 'objects/p.webp' }))
          }}
        >
          mock upload
        </button>
      </div>
    )
  },
}))

vi.mock('../../components/catalog/RichTextEditor', () => ({
  default: function MockEditor({
    value,
    onChange,
    onInsertImage,
    disabled,
  }: {
    value: string | null
    onChange: (html: string | null) => void
    onInsertImage?: () => Promise<{ src: string; objectKey: string } | null>
    disabled?: boolean
  }) {
    return (
      <div>
        <textarea
          data-testid="rich-text-editor"
          value={value ?? ''}
          disabled={disabled}
          onChange={event => onChange(event.target.value)}
        />
        {onInsertImage ? (
          <button
            type="button"
            data-testid="rich-text-insert-image"
            disabled={disabled}
            onClick={() => { void onInsertImage() }}
          >
            插入图片
          </button>
        ) : null}
      </div>
    )
  },
}))

vi.mock('../../api/uploads', () => ({
  uploadImage: vi.fn(),
  UploadError: class UploadError extends Error {
    constructor(message: string, public code: string) {
      super(message)
    }
  },
}))
import { createCatalogAdapter } from '../../api/catalog'
import {
  catalogFixtureCategories,
  catalogFixtureOffers,
  catalogFixtureVoidResponse,
  createCatalogFixtureTransport,
  type FixtureTransportRouteMap,
} from '../../api/catalog.fixtures'
import {
  PRODUCT_STATUS,
  TEMPLATE_KEYS,
  type FulfillmentConfiguration,
  type ProductTemplateDefinition,
  type ProductTemplateRegistryDto,
  type TemplateKey,
} from '../../types/catalog'
import { useAppStore } from '../../stores/appStore'
import { uploadImage } from '../../api/uploads'
import { serializePurchaseFormFields } from '../../components/merchant/PurchaseFormFieldsEditor'

const mockedUpload = vi.mocked(uploadImage)

/**
 * ProductCreateWizard draft-save wiring (editorVersion: 2).
 *
 * Uses the injectable CatalogAdapter over a fixture transport, so the
 * test asserts the EXACT v2 wire payload: editorVersion 2, registry
 * templateKey, no legacy type, no isHot, no stock, no secret inventory.
 * Also covers productId retention and duplicate-submit idempotency.
 */
const deliveryModes = [
  { value: 'instant_inventory', label: '交付库存' },
  { value: 'instant_fixed', label: '固定内容' },
  { value: 'manual_service', label: '人工服务' },
]

function stubTemplate(
  key: TemplateKey,
  label: string,
  configurations: FulfillmentConfiguration[],
  extra?: Partial<ProductTemplateDefinition>,
): ProductTemplateDefinition {
  return {
    key,
    version: 1,
    label,
    productSchema: { type: 'object', properties: {}, required: [] },
    offerSchema: { type: 'object', properties: {}, required: [] },
    ui: { productOrder: [], offerOrder: [], widgets: {} },
    fulfillmentRules: [{
      whenProductAttributes: {},
      configurations,
      requireStructuredDelivery: 'none',
      requireRequiredDateField: false,
    }],
    ...extra,
  }
}

const wizardTemplateRegistry: ProductTemplateRegistryDto = {
  registryVersion: 1,
  templates: [
    stubTemplate('redemption_code', '卡密与兑换码', ['inventory'], {
      productSchema: {
        type: 'object',
        properties: { serviceName: { type: 'string', title: '适用产品' } },
        required: ['serviceName'],
      },
      offerSchema: {
        type: 'object',
        properties: { unitLabel: { type: 'string', title: '销售单位' } },
        required: ['unitLabel'],
      },
      ui: {
        productOrder: ['serviceName'],
        offerOrder: ['unitLabel'],
        widgets: { serviceName: 'text', unitLabel: 'text' },
      },
    }),
    stubTemplate('account', '账号商品', ['inventory', 'fixed_text'], {
      productSchema: {
        type: 'object',
        properties: {
          accessModel: { type: 'string', title: '账号使用方式', enum: ['exclusive', 'shared'] },
        },
        required: ['accessModel'],
      },
      ui: {
        productOrder: ['accessModel'],
        offerOrder: [],
        widgets: { accessModel: 'select' },
        enumLabels: { accessModel: { exclusive: '独享账号', shared: '共享账号' } },
      },
      fulfillmentRules: [
        {
          whenProductAttributes: { accessModel: 'exclusive' },
          configurations: ['inventory'],
          requireStructuredDelivery: 'inventory_fields',
          requireRequiredDateField: false,
        },
        {
          whenProductAttributes: { accessModel: 'shared' },
          configurations: ['fixed_text'],
          requireStructuredDelivery: 'fixed_fields',
          requireRequiredDateField: false,
        },
      ],
    }),
    stubTemplate('digital_file', '数字文件', ['fixed_file']),
    stubTemplate('fixed_content', '固定数字内容', ['fixed_text', 'fixed_url']),
    stubTemplate('subscription', '订阅与开通', ['inventory', 'fixed_text', 'fixed_url', 'manual', 'merchant_webhook', 'faka_bridge']),
    stubTemplate('manual_service', '人工服务与代办', ['manual', 'merchant_webhook']),
    stubTemplate('appointment', '预约服务', ['manual']),
  ],
}

function seedRegistry() {
  useAppStore.setState({
    registry: {
      productTypes: [],
      deliveryModes,
      orderStatuses: [],
      settlementStatuses: [],
      pagination: { defaultPageSize: 20, maxPageSize: 100 },
      inventory: { lowStockThreshold: 5 },
    },
  })
}

function v2Created(body: unknown) {
  const b = body as { name?: string }
  return {
    id: 101,
    name: b.name ?? 'x',
    status: PRODUCT_STATUS.DRAFT,
    contentVersion: 1,
    offers: [{ id: 42, name: '默认规格', isDefault: true }],
    nextStep: 'availability' as const,
  }
}

async function renderWizard(routes: FixtureTransportRouteMap = {}) {
  const transport = createCatalogFixtureTransport({
    get: {
      '/product-templates': wizardTemplateRegistry,
      '/config/registry': { productCategories: catalogFixtureCategories },
      ...routes.get,
    },
    post: routes.post,
  })
  render(
    <MemoryRouter>
      <ProductCreateWizard adapter={createCatalogAdapter(transport)} />
    </MemoryRouter>,
  )
  await waitFor(() => expect(screen.getByTestId('template-redemption_code')).toBeInTheDocument())
  return transport
}

/** Walk the wizard to the 确认草稿 (step 4) with valid inputs. */
async function walkToConfirm(routes: FixtureTransportRouteMap = {}) {
  const transport = await renderWizard(routes)
  fireEvent.click(screen.getByTestId('template-redemption_code'))
  fireEvent.click(screen.getByTestId('wizard-next'))
  fireEvent.change(screen.getByTestId('wizard-name'), { target: { value: '节点套餐' } })
  const categorySelect = screen.getByTestId('product-category-select')
  await waitFor(() => expect(categorySelect).not.toBeDisabled())
  fireEvent.change(categorySelect, { target: { value: '3' } })
  fireEvent.click(screen.getByTestId('wizard-next'))
  fireEvent.change(screen.getByTestId('wizard-price'), { target: { value: '100' } })
  fireEvent.click(screen.getByTestId('wizard-next'))
  fireEvent.click(screen.getByTestId('wizard-next'))
  return transport
}

describe('ProductCreateWizard draft flow (editorVersion 2)', () => {
  beforeEach(() => {
    seedRegistry()
    mockedUpload.mockReset()
  })

  it('lists the seven registry templates and has no blank/legacy presets', async () => {
    await renderWizard()
    for (const key of TEMPLATE_KEYS) {
      expect(screen.getByTestId(`template-${key}`)).toBeInTheDocument()
    }
    expect(screen.queryByTestId('template-blank')).not.toBeInTheDocument()
    expect(screen.queryByTestId('template-card_key')).not.toBeInTheDocument()
  })

  it('saves a draft with an editorVersion 2 payload and retains productId', async () => {
    const transport = await walkToConfirm({
      get: {
        '/merchant/products/101/offers': catalogFixtureOffers,
      },
      post: {
        '/merchant/products': v2Created,
        '/merchant/products/101/inventory/void': catalogFixtureVoidResponse,
      },
    })

    fireEvent.click(screen.getByTestId('wizard-save-draft'))

    await waitFor(() => expect(screen.getByTestId('product-availability-step')).toBeInTheDocument())

    const createCall = transport.calls.find(c => c.method === 'post' && c.url === '/merchant/products')
    expect(createCall).toBeTruthy()
    const body = createCall!.body as Record<string, unknown>
    expect(body.editorVersion).toBe(2)
    expect(body.templateKey).toBe('redemption_code')
    expect(body.templateVersion).toBe(1)
    expect(body.name).toBe('节点套餐')
    expect(body.categoryId).toBe(3)
    expect(body.visibility).toBe('members_only')
    expect(body.descriptionImages).toEqual([])
    expect(body.purchaseForm).toEqual([])
    expect(Array.isArray(body.offers)).toBe(true)
    const offers = body.offers as Array<Record<string, unknown>>
    expect(offers.length).toBeGreaterThanOrEqual(1)
    expect(offers[0].price).toBe(100)
    expect(offers[0].deliveryMode).toBe('instant_inventory')
    expect(offers[0].stockMode).toBe('limited')
    expect('type' in body).toBe(false)
    expect('isHot' in body).toBe(false)
    expect('stock' in body).toBe(false)
    expect('inventoryItems' in body).toBe(false)
    expect('content' in body).toBe(false)
    expect('price' in body).toBe(false)
    expect('deliveryMode' in body).toBe(false)

    await waitFor(() => expect(screen.getByTestId('availability-offer-select')).toHaveValue('42'))
    fireEvent.change(screen.getByTestId('availability-void-count'), { target: { value: '1' } })
    fireEvent.change(screen.getByTestId('availability-void-reason'), { target: { value: '过期库存' } })
    fireEvent.click(screen.getByTestId('availability-void-submit'))
    await waitFor(() => {
      const voidCall = transport.calls.find(c => c.url === '/merchant/products/101/inventory/void')
      expect(voidCall?.body).toMatchObject({ offerId: 42, count: 1, reason: '过期库存' })
    })
  })

  it('sends serialized purchaseForm when the merchant added a field', async () => {
    const transport = await renderWizard({
      get: { '/merchant/products/101/offers': catalogFixtureOffers },
      post: { '/merchant/products': v2Created },
    })
    fireEvent.click(screen.getByTestId('template-redemption_code'))
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.change(screen.getByTestId('wizard-name'), { target: { value: '节点套餐' } })
    const categorySelect = screen.getByTestId('product-category-select')
    await waitFor(() => expect(categorySelect).not.toBeDisabled())
    fireEvent.change(categorySelect, { target: { value: '3' } })

    expect(screen.getByTestId('wizard-purchase-form')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('add-form-field'))
    fireEvent.change(screen.getByTestId('form-field-label-0'), { target: { value: '联系方式' } })
    const required = screen.getByTestId('form-field-list').querySelector('input[type="checkbox"]')
    expect(required).toBeTruthy()
    fireEvent.click(required!)

    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.change(screen.getByTestId('wizard-price'), { target: { value: '100' } })
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.click(screen.getByTestId('wizard-save-draft'))

    await waitFor(() => expect(screen.getByTestId('product-availability-step')).toBeInTheDocument())
    const createCall = transport.calls.find(c => c.method === 'post' && c.url === '/merchant/products')
    const body = createCall!.body as { purchaseForm: unknown }
    expect(body.purchaseForm).toEqual(serializePurchaseFormFields([{
      key: 'field_1',
      label: '联系方式',
      type: 'text',
      required: true,
    }]))
  })

  it('is idempotent: re-submitting an already-saved draft never creates a second one', async () => {
    const transport = await walkToConfirm({
      get: { '/merchant/products/101/offers': catalogFixtureOffers },
      post: { '/merchant/products': v2Created },
    })

    fireEvent.click(screen.getByTestId('wizard-save-draft'))
    await waitFor(() => expect(screen.getByTestId('product-availability-step')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /上一步/ }))
    expect(screen.getByTestId('wizard-step-confirm')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('wizard-save-draft'))
    await waitFor(() => expect(screen.getByTestId('product-availability-step')).toBeInTheDocument())

    const creates = transport.calls.filter(c => c.method === 'post' && c.url === '/merchant/products')
    expect(creates).toHaveLength(1)
  })

  it('keeps inputs when draft save fails', async () => {
    await walkToConfirm({
      post: {
        '/merchant/products': () => {
          throw Object.assign(new Error('fail'), {
            response: { data: { error: { message: '服务端拒绝' } } },
          })
        },
      },
    })

    fireEvent.click(screen.getByTestId('wizard-save-draft'))
    await waitFor(() => expect(screen.getByTestId('wizard-step-confirm')).toBeInTheDocument())
    expect(screen.getByTestId('wizard-confirm-name')).toHaveTextContent('节点套餐')
    expect(screen.getByTestId('wizard-confirm-price')).toHaveTextContent('100')
    expect(screen.queryByTestId('product-availability-step')).not.toBeInTheDocument()
  })

  it('includes upload refs in the v2 create payload when image keys are present', async () => {
    const transport = await renderWizard({
      get: { '/merchant/products/101/offers': catalogFixtureOffers },
      post: { '/merchant/products': v2Created },
    })
    fireEvent.click(screen.getByTestId('template-redemption_code'))
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.change(screen.getByTestId('wizard-name'), { target: { value: '节点套餐' } })
    const categorySelect = screen.getByTestId('product-category-select')
    await waitFor(() => expect(categorySelect).not.toBeDisabled())
    fireEvent.change(categorySelect, { target: { value: '3' } })
    fireEvent.click(screen.getByTestId('mock-add-upload-image'))
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.change(screen.getByTestId('wizard-price'), { target: { value: '100' } })
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.click(screen.getByTestId('wizard-save-draft'))

    await waitFor(() => expect(screen.getByTestId('product-availability-step')).toBeInTheDocument())
    const createCall = transport.calls.find(c => c.method === 'post' && c.url === '/merchant/products')
    const body = createCall!.body as { images: unknown; descriptionImages: unknown }
    expect(body.images).toEqual([{ kind: 'upload', objectKey: 'objects/p.webp' }])
    expect(body.descriptionImages).toEqual([])
  })

  it('passes descriptionImages when the editor inserts an uploaded image', async () => {
    mockedUpload.mockResolvedValue({
      key: 'objects/desc.webp',
      url: 'https://files.example/desc.webp',
    })
    const transport = await renderWizard({
      get: { '/merchant/products/101/offers': catalogFixtureOffers },
      post: { '/merchant/products': v2Created },
    })
    fireEvent.click(screen.getByTestId('template-redemption_code'))
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.change(screen.getByTestId('wizard-name'), { target: { value: '节点套餐' } })
    const categorySelect = screen.getByTestId('product-category-select')
    await waitFor(() => expect(categorySelect).not.toBeDisabled())
    fireEvent.change(categorySelect, { target: { value: '3' } })

    fireEvent.click(screen.getByTestId('rich-text-insert-image'))
    fireEvent.change(screen.getByTestId('wizard-description-image-input'), {
      target: { files: [new File(['x'], 'desc.webp', { type: 'image/webp' })] },
    })
    await waitFor(() => expect(mockedUpload).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.change(screen.getByTestId('wizard-price'), { target: { value: '100' } })
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.click(screen.getByTestId('wizard-save-draft'))

    await waitFor(() => expect(screen.getByTestId('product-availability-step')).toBeInTheDocument())
    const createCall = transport.calls.find(c => c.method === 'post' && c.url === '/merchant/products')
    const body = createCall!.body as { descriptionImages: unknown }
    expect(body.descriptionImages).toEqual([{
      src: 'https://files.example/desc.webp',
      ref: { kind: 'upload', objectKey: 'objects/desc.webp' },
    }])
  })

  it('selecting a category never switches the delivery mode (D-CAT-05 orthogonality)', async () => {
    await renderWizard({
      post: { '/merchant/products': v2Created },
    })
    fireEvent.click(screen.getByTestId('template-subscription'))
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.change(screen.getByTestId('wizard-name'), { target: { value: '自由配置' } })
    const categorySelect = screen.getByTestId('product-category-select')
    await waitFor(() => expect(categorySelect).not.toBeDisabled())

    fireEvent.change(categorySelect, { target: { value: '2' } })
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.change(screen.getByTestId('wizard-price'), { target: { value: '50' } })
    fireEvent.click(screen.getByTestId('wizard-next'))

    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="wizardDeliveryMode"]'))
    const checked = radios.find(r => r.checked)
    expect(checked?.value).toBe('instant_inventory')

    const manual = radios.find(r => r.value === 'manual_service')
    expect(manual).toBeTruthy()
    fireEvent.click(manual!)
    fireEvent.click(screen.getByTestId('wizard-next'))
    expect(screen.getByTestId('wizard-confirm-category')).toHaveTextContent('共享账号')
  })

  it('shared-account create body has non-null structured content when filled', async () => {
    const transport = await renderWizard({
      get: { '/merchant/products/101/offers': catalogFixtureOffers },
      post: { '/merchant/products': v2Created },
    })
    fireEvent.click(screen.getByTestId('template-account'))
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.change(screen.getByTestId('wizard-name'), { target: { value: '共享账号套餐' } })
    const categorySelect = screen.getByTestId('product-category-select')
    await waitFor(() => expect(categorySelect).not.toBeDisabled())
    fireEvent.change(categorySelect, { target: { value: '3' } })
    fireEvent.change(screen.getByTestId('template-attr-accessModel-control'), { target: { value: 'shared' } })
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.change(screen.getByTestId('wizard-price'), { target: { value: '80' } })
    fireEvent.click(screen.getByTestId('wizard-next'))

    expect(screen.getByTestId('wizard-structured-content')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('wizard-structured-field-add'))
    fireEvent.change(screen.getByTestId('wizard-structured-field-key-0'), { target: { value: 'user' } })
    fireEvent.change(screen.getByTestId('wizard-structured-field-label-0'), { target: { value: '账号' } })
    fireEvent.change(screen.getByTestId('wizard-structured-field-value-0'), { target: { value: 'demo' } })
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.click(screen.getByTestId('wizard-save-draft'))

    await waitFor(() => expect(screen.getByTestId('product-availability-step')).toBeInTheDocument())
    const createCall = transport.calls.find(c => c.method === 'post' && c.url === '/merchant/products')
    expect(createCall).toBeTruthy()
    const body = createCall!.body as { offers: Array<Record<string, unknown>> }
    expect(body.offers[0].fixedStructuredContent).toEqual({
      fields: [{ key: 'user', label: '账号', sensitive: false }],
      values: { user: 'demo' },
    })
    expect(body.offers[0].fixedContent).toBeNull()
    expect(body.offers[0].deliveryMode).toBe('instant_fixed')
  })

  it('exclusive-account create body has deliveryFields when filled', async () => {
    const transport = await renderWizard({
      get: { '/merchant/products/101/offers': catalogFixtureOffers },
      post: { '/merchant/products': v2Created },
    })
    fireEvent.click(screen.getByTestId('template-account'))
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.change(screen.getByTestId('wizard-name'), { target: { value: '独享账号套餐' } })
    const categorySelect = screen.getByTestId('product-category-select')
    await waitFor(() => expect(categorySelect).not.toBeDisabled())
    fireEvent.change(categorySelect, { target: { value: '3' } })
    fireEvent.change(screen.getByTestId('template-attr-accessModel-control'), { target: { value: 'exclusive' } })
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.change(screen.getByTestId('wizard-price'), { target: { value: '80' } })
    fireEvent.click(screen.getByTestId('wizard-next'))

    expect(screen.getByTestId('wizard-delivery-fields')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('wizard-delivery-field-add'))
    fireEvent.change(screen.getByTestId('wizard-delivery-field-key-0'), { target: { value: 'user' } })
    fireEvent.change(screen.getByTestId('wizard-delivery-field-label-0'), { target: { value: '账号' } })
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.click(screen.getByTestId('wizard-save-draft'))

    await waitFor(() => expect(screen.getByTestId('product-availability-step')).toBeInTheDocument())
    const createCall = transport.calls.find(c => c.method === 'post' && c.url === '/merchant/products')
    const body = createCall!.body as { offers: Array<Record<string, unknown>> }
    expect(body.offers[0].deliveryFields).toEqual([{ key: 'user', label: '账号', sensitive: false }])
    expect(body.offers[0].deliveryMode).toBe('instant_inventory')
    expect(body.offers[0].fixedStructuredContent).toBeNull()
  })
})
