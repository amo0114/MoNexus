import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, renderHook, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import RelatedProductsSection from '../components/catalog/productDetail/RelatedProductsSection'
import { useRecommendationTracking } from './useRecommendationTracking'
import type { RecommendedProduct } from '../api/productRecommendations'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const product = (id: number): RecommendedProduct => ({
  id, name: `商品${id}`, description: '', type: '卡密', icon: '', imageUrl: '',
  price: 10, stock: 1, sales: 0, recommendation: { sameSeller: true },
})

describe('recommendation tracking wiring', () => {
  it('stays off outside production or without a server credential', () => {
    vi.stubEnv('PROD', false)
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const dev = renderHook(() => useRecommendationTracking('signed-list'))
    expect(dev.result.current).toBeUndefined(); dev.unmount()
    vi.stubEnv('PROD', true)
    const disabled = renderHook(() => useRecommendationTracking())
    expect(disabled.result.current).toBeUndefined(); disabled.unmount()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reports actual link activation including keyboard-generated clicks and middle clicks, not surrounding controls', () => {
    vi.stubEnv('PROD', true)
    const fetcher = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetcher)
    function Section() {
      const tracker = useRecommendationTracking('signed-list')
      return <RelatedProductsSection tracker={tracker} state={{ status: 'ready', items: [product(5), product(6)] }} />
    }
    const view = render(<MemoryRouter><Section /></MemoryRouter>)
    fireEvent.click(screen.getByTestId('store-product-card-5'))
    expect(fetcher).not.toHaveBeenCalled()
    const first = screen.getByRole('link', { name: '商品5' })
    first.addEventListener('click', event => event.preventDefault())
    // Enter activates a native anchor by dispatching a click with detail=0.
    fireEvent.click(first, { detail: 0 })
    fireEvent.click(first, { ctrlKey: true })
    const second = screen.getByRole('link', { name: '商品6' })
    fireEvent(second, new MouseEvent('auxclick', { bubbles: true, button: 2 }))
    expect(fetcher).toHaveBeenCalledTimes(1)
    fireEvent(second, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.map(call => JSON.parse(call[1].body).events)).toEqual([
      [{ type: 'click', productId: 5 }], [{ type: 'click', productId: 6 }],
    ])
    view.unmount()
  })
})
