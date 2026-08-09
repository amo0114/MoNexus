import { describe, expect, it, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ProductCreateWizard from './ProductCreateWizard'
import { createCatalogAdapter } from '../../api/catalog'
import {
  catalogFixtureCategories,
  catalogFixtureOffers,
  catalogFixtureVoidResponse,
  createCatalogFixtureTransport,
  type FixtureTransportRouteMap,
} from '../../api/catalog.fixtures'
import { PRODUCT_STATUS } from '../../types/catalog'
import { useAppStore } from '../../stores/appStore'

/**
 * ProductCreateWizard draft-save wiring (T-CAT-FE-001B).
 *
 * Uses the injectable 001A CatalogAdapter over a fixture transport, so the
 * test asserts the EXACT wire payload the merchant drafts the server with:
 * categoryId-based (no legacy type), no isHot, no stock, no secret inventory,
 * no purchaseForm. Also covers productId retention (availability step is only
 * reachable after the draft is saved) and duplicate-submit idempotency.
 */
const deliveryModes = [
  { value: 'instant_inventory', label: '交付库存' },
  { value: 'instant_fixed', label: '固定内容' },
  { value: 'manual_service', label: '人工服务' },
]

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

function renderWizard(routes: FixtureTransportRouteMap) {
  const transport = createCatalogFixtureTransport(routes)
  render(
    <MemoryRouter>
      <ProductCreateWizard adapter={createCatalogAdapter(transport)} />
    </MemoryRouter>,
  )
  return transport
}

/** Walk the wizard to the 确认草稿 (step 4) with valid inputs. */
async function walkToConfirm(routes: FixtureTransportRouteMap) {
  const transport = renderWizard(routes)
  // Step 0 — 充值卡密 template (instant_inventory + category preset).
  fireEvent.click(screen.getByTestId('template-card_key'))
  fireEvent.click(screen.getByTestId('wizard-next'))
  // Step 1 — name + category (wait for the async category registry).
  fireEvent.change(screen.getByTestId('wizard-name'), { target: { value: '节点套餐' } })
  const categorySelect = screen.getByTestId('product-category-select')
  await waitFor(() => expect(categorySelect).not.toBeDisabled())
  fireEvent.change(categorySelect, { target: { value: '3' } })
  fireEvent.click(screen.getByTestId('wizard-next'))
  // Step 2 — price (主规格 default, validity left empty = permanent).
  fireEvent.change(screen.getByTestId('wizard-price'), { target: { value: '100' } })
  fireEvent.click(screen.getByTestId('wizard-next'))
  // Step 3 — delivery mode already instant_inventory (template preset).
  fireEvent.click(screen.getByTestId('wizard-next'))
  return transport
}

describe('ProductCreateWizard draft flow (T-CAT-FE-001B)', () => {
  beforeEach(() => {
    seedRegistry()
  })

  it('saves a draft with a categoryId-based whitelist payload and retains productId', async () => {
    const transport = await walkToConfirm({
      get: {
        '/config/registry': { productCategories: catalogFixtureCategories },
        '/merchant/products/101/offers': catalogFixtureOffers,
      },
      post: {
        '/merchant/products': (body) => {
          const b = body as { name: string; categoryId: number }
          return {
            id: 101,
            name: b.name,
            categoryId: b.categoryId,
            type: '充值卡密',
            status: PRODUCT_STATUS.DRAFT,
            publishedAt: null,
          }
        },
        '/merchant/products/101/inventory/void': catalogFixtureVoidResponse,
      },
    })

    fireEvent.click(screen.getByTestId('wizard-save-draft'))

    // Draft saved → productId retained → the availability step becomes usable.
    await waitFor(() => expect(screen.getByTestId('product-availability-step')).toBeInTheDocument())

    const createCall = transport.calls.find(c => c.method === 'post' && c.url === '/merchant/products')
    expect(createCall).toBeTruthy()
    const body = createCall!.body as Record<string, unknown>
    expect(body.name).toBe('节点套餐')
    expect(body.categoryId).toBe(3)
    expect(body.price).toBe(100)
    expect(body.deliveryMode).toBe('instant_inventory')
    // Frozen create contract: no legacy type, no isHot, no stock, no secrets.
    expect('type' in body).toBe(false)
    expect('isHot' in body).toBe(false)
    expect('stock' in body).toBe(false)
    expect('inventoryItems' in body).toBe(false)
    expect('content' in body).toBe(false)
    expect('purchaseForm' in body).toBe(false)

    // Availability mutations use the server-assigned Offer id, never 1/2/3
    // synthesized from the form order.
    await waitFor(() => expect(screen.getByTestId('availability-offer-select')).toHaveValue('42'))
    fireEvent.change(screen.getByTestId('availability-void-count'), { target: { value: '1' } })
    fireEvent.change(screen.getByTestId('availability-void-reason'), { target: { value: '过期库存' } })
    fireEvent.click(screen.getByTestId('availability-void-submit'))
    await waitFor(() => {
      const voidCall = transport.calls.find(c => c.url === '/merchant/products/101/inventory/void')
      expect(voidCall?.body).toMatchObject({ offerId: 42, count: 1, reason: '过期库存' })
    })
  })

  it('is idempotent: re-submitting an already-saved draft never creates a second one', async () => {
    const transport = await walkToConfirm({
      get: {
        '/config/registry': { productCategories: catalogFixtureCategories },
        '/merchant/products/101/offers': catalogFixtureOffers,
      },
      post: { '/merchant/products': () => ({ id: 101, name: 'x', categoryId: 3, type: '充值卡密', status: PRODUCT_STATUS.DRAFT, publishedAt: null }) },
    })

    fireEvent.click(screen.getByTestId('wizard-save-draft'))
    await waitFor(() => expect(screen.getByTestId('product-availability-step')).toBeInTheDocument())

    // Go back to 确认草稿 and press 保存草稿并继续 again — idempotent pass-through.
    fireEvent.click(screen.getByRole('button', { name: /上一步/ }))
    expect(screen.getByTestId('wizard-step-confirm')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('wizard-save-draft'))
    await waitFor(() => expect(screen.getByTestId('product-availability-step')).toBeInTheDocument())

    const creates = transport.calls.filter(c => c.method === 'post' && c.url === '/merchant/products')
    expect(creates).toHaveLength(1)
  })

  it('selecting a category never switches the delivery mode (D-CAT-05 orthogonality)', async () => {
    const transport = renderWizard({
      get: { '/config/registry': { productCategories: catalogFixtureCategories } },
      post: { '/merchant/products': () => ({ id: 101, name: 'x', categoryId: 3, type: '充值卡密', status: PRODUCT_STATUS.DRAFT, publishedAt: null }) },
    })
    fireEvent.click(screen.getByTestId('template-blank'))
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.change(screen.getByTestId('wizard-name'), { target: { value: '自由配置' } })
    const categorySelect = screen.getByTestId('product-category-select')
    await waitFor(() => expect(categorySelect).not.toBeDisabled())

    // 空白模板 keeps instant_inventory; picking 人工服务 category must not change it.
    fireEvent.change(categorySelect, { target: { value: '2' } }) // 共享账号
    fireEvent.click(screen.getByTestId('wizard-next'))
    fireEvent.change(screen.getByTestId('wizard-price'), { target: { value: '50' } })
    fireEvent.click(screen.getByTestId('wizard-next'))

    // Delivery step still shows instant_inventory as the checked mode.
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="wizardDeliveryMode"]'))
    const checked = radios.find(r => r.checked)
    expect(checked?.value).toBe('instant_inventory')

    // And switching the delivery mode afterwards does not reset the category.
    fireEvent.change(checked!, { target: { value: 'manual_service' } })
    fireEvent.click(screen.getByTestId('wizard-next'))
    expect(screen.getByTestId('wizard-confirm-category')).toHaveTextContent('共享账号')
  })
})
