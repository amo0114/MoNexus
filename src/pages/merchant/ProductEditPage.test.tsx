import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { Dispatch, SetStateAction } from 'react'
import ProductEditPage from './ProductEditPage'

const merchantMocks = vi.hoisted(() => ({
  uploadDeliveryFile: vi.fn(),
  updateMerchantOffer: vi.fn(),
}))

vi.mock('../../api/merchant', () => ({
  uploadDeliveryFile: merchantMocks.uploadDeliveryFile,
  updateMerchantOffer: merchantMocks.updateMerchantOffer,
}))

vi.mock('../../components/merchant/ProductImageUploader', () => ({
  default: function MockUploader({
    images,
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
        <span data-testid="mock-image-count">{images.length}</span>
        <button
          type="button"
          data-testid="mock-add-upload-image"
          disabled={disabled}
          onClick={() => {
            const url = 'https://files.example/new.webp'
            onChange(prev => [...prev, url])
            onImageKeysChange?.(prev => ({ ...prev, [url]: 'objects/new.webp' }))
          }}
        >
          mock upload
        </button>
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
import {
  createCatalogAdapter,
  type CatalogTransport,
  type PatchProductContentRequest,
  type ProductEditorDto,
} from '../../api/catalog'
import { catalogFixtureCategories } from '../../api/catalog.fixtures'
import {
  CATALOG_ERROR_CODES,
  EMPTY_PRODUCT_DETAILS,
  PRODUCT_STATUS,
  type ProductTemplateDefinition,
  type ProductTemplateRegistryDto,
} from '../../types/catalog'
import { useAppStore } from '../../stores/appStore'
import { uploadImage } from '../../api/uploads'

const mockedUpload = vi.mocked(uploadImage)

vi.mock('../../components/catalog/RichTextEditor', () => ({
  default: ({
    value,
    onChange,
    onInsertImage,
    disabled,
  }: {
    value: string | null
    onChange: (html: string | null) => void
    onInsertImage?: () => Promise<{ src: string; objectKey: string } | null>
    disabled?: boolean
  }) => (
    <div>
      <textarea
        data-testid="rich-text-editor"
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
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
  ),
}))

const template: ProductTemplateDefinition = {
  key: 'redemption_code',
  version: 1,
  label: '卡密与兑换码',
  productSchema: {
    type: 'object',
    properties: { serviceName: { type: 'string', title: '适用产品' } },
    required: ['serviceName'],
  },
  offerSchema: { type: 'object', properties: {}, required: [] },
  ui: { productOrder: ['serviceName'], offerOrder: [], widgets: { serviceName: 'text' } },
  fulfillmentRules: [{
    whenProductAttributes: {},
    configurations: ['inventory'],
    requireStructuredDelivery: 'none',
    requireRequiredDateField: false,
  }],
}

const templateRegistry: ProductTemplateRegistryDto = {
  registryVersion: 1,
  templates: [template],
}

function editorDto(overrides: Partial<ProductEditorDto['product']> = {}): ProductEditorDto {
  return {
    product: {
      id: 42,
      status: PRODUCT_STATUS.DRAFT,
      merchantId: 7,
      contentVersion: 3,
      templateKey: 'redemption_code',
      templateVersion: 1,
      name: '原名称',
      categoryId: 3,
      description: '简介',
      richDescription: '<p>详情</p>',
      descriptionImages: [],
      images: [{ url: '/assets/cover.webp', ref: { kind: 'static', path: '/assets/cover.webp' } }],
      visibility: 'members_only',
      attributes: { serviceName: '节点' },
      details: { ...EMPTY_PRODUCT_DETAILS, purchaseNotes: '须知', afterSalesInstructions: '售后' },
      purchaseForm: [],
      ...overrides,
    },
    offers: [{
      id: 9,
      name: '默认规格',
      price: 100,
      originalPrice: null,
      status: 'active',
      sortOrder: 0,
      isDefault: true,
      deliveryMode: 'instant_inventory',
      stockMode: 'limited',
      stock: 0,
      validityDays: null,
      fixedContentType: 'text',
      fixedFileId: null,
      deliveryFields: null,
      autoProvision: false,
      attributes: {},
    }],
    capabilities: {
      editContent: true,
      manageOffers: true,
      manageAvailability: true,
      manageAssurance: true,
      applyAssurance: true,
      adoptSourceDescription: false,
    },
    sourceDescription: null,
    publicationIssues: [],
  }
}

function createEditTransport(options: {
  editor?: ProductEditorDto | (() => ProductEditorDto)
  patch?: (body: unknown) => unknown
  editorError?: unknown
}) {
  const calls: Array<{ method: 'get' | 'post' | 'patch'; url: string; body?: unknown }> = []
  const transport: CatalogTransport & { calls: typeof calls } = {
    calls,
    async get(url) {
      calls.push({ method: 'get', url })
      if (url === '/product-templates') return templateRegistry
      if (url === '/config/registry') return { productCategories: catalogFixtureCategories }
      if (url === '/merchant/products/42/editor' || url === '/admin/products/42/editor') {
        if (options.editorError) throw options.editorError
        const dto = typeof options.editor === 'function' ? options.editor() : (options.editor ?? editorDto())
        return dto
      }
      throw new Error(`catalog fixture: no route for GET ${url}`)
    },
    async post() {
      throw new Error('catalog fixture: unexpected POST')
    },
    async patch(url, body) {
      calls.push({ method: 'patch', url, body })
      if (!options.patch) throw new Error(`catalog fixture: no route for PATCH ${url}`)
      return options.patch(body)
    },
  }
  return transport
}

async function renderEditPage(
  transport: CatalogTransport & { calls: Array<{ method: 'get' | 'post' | 'patch'; url: string; body?: unknown }> },
  actor: 'merchant' | 'admin' = 'merchant',
) {
  useAppStore.setState({ toasts: [] })
  const prefix = actor === 'admin' ? '/admin' : '/merchant'
  render(
    <MemoryRouter initialEntries={[`${prefix}/products/42/edit`]}>
      <Routes>
        <Route
          path={`${prefix}/products/:id/edit`}
          element={<ProductEditPage actor={actor} adapter={createCatalogAdapter(transport)} />}
        />
      </Routes>
    </MemoryRouter>,
  )
  await waitFor(() => expect(screen.getByTestId('product-edit-name')).toBeInTheDocument())
}

describe('ProductEditPage (spec §9.2 / §10.3)', () => {
  beforeEach(() => {
    merchantMocks.uploadDeliveryFile.mockReset()
    merchantMocks.updateMerchantOffer.mockReset()
  })

  it('loads the editor DTO and PATCHes name with expectedContentVersion', async () => {
    const transport = createEditTransport({
      patch: (body) => ({
        id: 42,
        contentVersion: 4,
        updatedFields: ['name'],
        echoed: body,
      }),
    })
    await renderEditPage(transport)

    expect(screen.getByTestId('product-edit-name')).toHaveValue('原名称')
    expect(screen.getByTestId('product-edit-content-version')).toHaveTextContent('v3')
    expect(screen.getByTestId('product-edit-status')).toHaveTextContent('草稿')

    fireEvent.change(screen.getByTestId('product-edit-name'), { target: { value: '新名称' } })
    fireEvent.click(screen.getByTestId('product-edit-save'))

    await waitFor(() => {
      const patchCall = transport.calls.find(call => call.method === 'patch')
      expect(patchCall).toBeTruthy()
    })
    const patchCall = transport.calls.find(call => call.method === 'patch')
    expect(patchCall?.url).toBe('/merchant/products/42/content')
    const body = patchCall?.body as PatchProductContentRequest
    expect(body.expectedContentVersion).toBe(3)
    expect(body.name).toBe('新名称')
    expect('offers' in body).toBe(false)
    expect('templateKey' in body).toBe(false)
    expect(screen.getByTestId('product-edit-template-locked')).toBeInTheDocument()
    expect(screen.queryByTestId('product-edit-template-select')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('product-edit-content-version')).toHaveTextContent('v4'))
  })

  it('keeps the typed name when content CAS returns 409', async () => {
    let editorVersion = 3
    const transport = createEditTransport({
      editor: () => editorDto({ contentVersion: editorVersion }),
      patch: () => {
        editorVersion = 4
        throw Object.assign(new Error('conflict'), {
          response: {
            status: 409,
            data: {
              error: {
                code: CATALOG_ERROR_CODES.PRODUCT_CONTENT_CHANGED,
                message: '商品内容已更新，请刷新后重试',
              },
            },
          },
        })
      },
    })
    await renderEditPage(transport)

    fireEvent.change(screen.getByTestId('product-edit-name'), { target: { value: '冲突后仍保留' } })
    fireEvent.click(screen.getByTestId('product-edit-save'))

    await waitFor(() => {
      expect(transport.calls.some(call => call.method === 'patch')).toBe(true)
    })
    expect(screen.getByTestId('product-edit-name')).toHaveValue('冲突后仍保留')
    await waitFor(() => expect(screen.getByTestId('product-edit-content-version')).toHaveTextContent('v4'))
    expect(useAppStore.getState().toasts.some(toast => toast.message.includes('刷新版本号'))).toBe(true)
  })

  it('shows 404 when the merchant editor GET is not found', async () => {
    const transport = createEditTransport({
      editorError: Object.assign(new Error('missing'), {
        response: { status: 404, data: { error: { message: '商品不存在' } } },
      }),
    })
    useAppStore.setState({ toasts: [] })
    render(
      <MemoryRouter initialEntries={['/merchant/products/42/edit']}>
        <Routes>
          <Route
            path="/merchant/products/:id/edit"
            element={<ProductEditPage actor="merchant" adapter={createCatalogAdapter(transport)} />}
          />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText('商品不存在')).toBeInTheDocument()
    expect(screen.queryByTestId('product-edit-name')).not.toBeInTheDocument()
  })

  it('PATCHes a complete images array when a new upload key is present', async () => {
    const transport = createEditTransport({
      patch: (body) => ({
        id: 42,
        contentVersion: 4,
        updatedFields: ['images'],
        echoed: body,
      }),
    })
    await renderEditPage(transport)

    fireEvent.click(screen.getByTestId('mock-add-upload-image'))
    fireEvent.click(screen.getByTestId('product-edit-save'))

    await waitFor(() => {
      expect(transport.calls.some(call => call.method === 'patch')).toBe(true)
    })
    const body = transport.calls.find(call => call.method === 'patch')?.body as PatchProductContentRequest
    expect(body.images).toEqual([
      { kind: 'static', path: '/assets/cover.webp' },
      { kind: 'upload', objectKey: 'objects/new.webp' },
    ])
    expect('descriptionImages' in body).toBe(false)
  })

  it('sends descriptionImages only after an editor insert', async () => {
    mockedUpload.mockResolvedValue({
      key: 'objects/desc.webp',
      url: 'https://files.example/desc.webp',
    })
    const transport = createEditTransport({
      editor: editorDto({
        descriptionImages: [{
          src: 'https://files.example/old.webp',
          ref: { kind: 'upload', objectKey: 'objects/old.webp' },
        }],
      }),
      patch: (body) => ({
        id: 42,
        contentVersion: 4,
        updatedFields: ['descriptionImages'],
        echoed: body,
      }),
    })
    await renderEditPage(transport)

    fireEvent.click(screen.getByTestId('rich-text-insert-image'))
    fireEvent.change(screen.getByTestId('product-edit-description-image-input'), {
      target: { files: [new File(['x'], 'desc.webp', { type: 'image/webp' })] },
    })
    await waitFor(() => expect(mockedUpload).toHaveBeenCalled())

    fireEvent.change(screen.getByTestId('product-edit-name'), { target: { value: '新名称' } })
    fireEvent.click(screen.getByTestId('product-edit-save'))

    await waitFor(() => {
      expect(transport.calls.some(call => call.method === 'patch')).toBe(true)
    })
    const body = transport.calls.find(call => call.method === 'patch')?.body as PatchProductContentRequest
    expect(body.descriptionImages).toEqual([
      { src: 'https://files.example/old.webp', ref: { kind: 'upload', objectKey: 'objects/old.webp' } },
      { src: 'https://files.example/desc.webp', ref: { kind: 'upload', objectKey: 'objects/desc.webp' } },
    ])
  })

  it('merchant actor uploads a file-form offer file and updates the offer URL with fixedFileId', async () => {
    merchantMocks.uploadDeliveryFile.mockResolvedValue({
      id: 88,
      fileName: 'guide.pdf',
      size: 12,
    })
    let boundFileId: number | null = null
    merchantMocks.updateMerchantOffer.mockImplementation(async (_productId, _offerId, payload: { fixedFileId?: number | null }) => {
      boundFileId = payload.fixedFileId ?? null
      return { id: 11, fixedFileId: boundFileId }
    })

    const base = editorDto()
    const fileOffers = () => ([
      { ...base.offers[0], id: 9, name: '文本规格', fixedContentType: 'text' as const, fixedFileId: null },
      {
        ...base.offers[0],
        id: 11,
        name: '文件规格',
        deliveryMode: 'instant_fixed' as const,
        stockMode: 'unlimited' as const,
        fixedContentType: 'file' as const,
        fixedFileId: boundFileId,
      },
    ])
    const transport = createEditTransport({
      editor: () => ({ ...base, offers: fileOffers() }),
    })
    await renderEditPage(transport)

    expect(screen.getByTestId('product-edit-offer-file-11')).toBeInTheDocument()
    expect(screen.queryByTestId('product-edit-offer-file-9')).not.toBeInTheDocument()
    expect(screen.getByTestId('product-edit-content-version')).toHaveTextContent('v3')

    fireEvent.change(screen.getByTestId('product-edit-offer-file-11'), {
      target: { files: [new File(['paid'], 'guide.pdf', { type: 'application/pdf' })] },
    })
    fireEvent.click(screen.getByTestId('product-edit-offer-file-bind-11'))

    await waitFor(() => expect(merchantMocks.uploadDeliveryFile).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(merchantMocks.updateMerchantOffer).toHaveBeenCalledTimes(1))
    expect(merchantMocks.updateMerchantOffer).toHaveBeenCalledWith(42, 11, { fixedFileId: 88 })
    expect(merchantMocks.uploadDeliveryFile.mock.calls[0]?.[0]).toBeInstanceOf(File)
    expect(transport.calls.some(call => call.method === 'patch')).toBe(false)
    expect(screen.getByTestId('product-edit-content-version')).toHaveTextContent('v3')
    expect(useAppStore.getState().toasts.some(toast => toast.message.includes('已挂载'))).toBe(true)
  })

  it('does not show a file input on non-file offers', async () => {
    const transport = createEditTransport({ editor: editorDto() })
    await renderEditPage(transport)

    expect(screen.getByTestId('product-edit-offer-9')).toBeInTheDocument()
    expect(screen.queryByTestId('product-edit-offer-file-9')).not.toBeInTheDocument()
    expect(merchantMocks.updateMerchantOffer).not.toHaveBeenCalled()
  })

  it('saves shared-offer structured content via updateMerchantOffer', async () => {
    merchantMocks.updateMerchantOffer.mockResolvedValue({ id: 9 })
    const base = editorDto()
    const transport = createEditTransport({
      editor: {
        ...base,
        offers: [{
          ...base.offers[0],
          deliveryMode: 'instant_fixed',
          stockMode: 'unlimited',
          fixedStructuredContent: {
            fields: [{ key: 'user', label: '账号', sensitive: false }],
            values: { user: 'demo' },
          },
        }],
      },
    })
    await renderEditPage(transport)

    expect(screen.getByTestId('product-edit-offer-9-structured-content')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('product-edit-offer-9-structured-field-value-0'), {
      target: { value: 'shared-user' },
    })
    fireEvent.click(screen.getByTestId('product-edit-save'))

    await waitFor(() => expect(merchantMocks.updateMerchantOffer).toHaveBeenCalledTimes(1))
    expect(merchantMocks.updateMerchantOffer).toHaveBeenCalledWith(42, 9, {
      fixedStructuredContent: {
        fields: [{ key: 'user', label: '账号', sensitive: false }],
        values: { user: 'shared-user' },
      },
    })
    expect(transport.calls.some(call => call.method === 'patch')).toBe(false)
  })

  it('PATCHes templateKey and templateVersion:1 on a legacy editor DTO', async () => {
    const transport = createEditTransport({
      editor: editorDto({ templateKey: null, templateVersion: null }),
      patch: (body) => ({
        id: 42,
        contentVersion: 4,
        updatedFields: ['templateKey'],
        echoed: body,
      }),
    })
    await renderEditPage(transport)

    expect(screen.getByTestId('product-edit-template-select')).toBeInTheDocument()
    expect(screen.queryByTestId('product-edit-template-locked')).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId('product-edit-template-select'), {
      target: { value: 'redemption_code' },
    })
    fireEvent.click(screen.getByTestId('product-edit-save'))

    await waitFor(() => {
      expect(transport.calls.some(call => call.method === 'patch')).toBe(true)
    })
    const body = transport.calls.find(call => call.method === 'patch')?.body as PatchProductContentRequest
    expect(body.templateKey).toBe('redemption_code')
    expect(body.templateVersion).toBe(1)
    expect(body.expectedContentVersion).toBe(3)
    await waitFor(() => expect(screen.getByTestId('product-edit-template-locked')).toBeInTheDocument())
    expect(screen.queryByTestId('product-edit-template-select')).not.toBeInTheDocument()
  })
})
