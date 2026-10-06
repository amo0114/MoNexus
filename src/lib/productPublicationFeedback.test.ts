import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { showProductPublished, showProductUnpublished } from './productPublicationFeedback'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
beforeEach(() => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({matches:true} as MediaQueryList)
  useAppStore.setState({islandNoticeAvailable:true,islandNotice:null,islandQueue:[],modalDepth:0,toasts:[]})
})
afterEach(() => vi.restoreAllMocks())
it('offers the published product, without inventing a review state', () => {
  const navigate=vi.fn()
  expect(showProductPublished({id:7,name:'节点套餐'},{id:7,status:'active',publishedAt:null},navigate)).toBe(true)
  const notice=useAppStore.getState().islandNotice!
  expect(notice.title).toBe('商品发布成功')
  expect(notice.subtitle).toBe('节点套餐')
  notice.onAction?.()
  expect(navigate).toHaveBeenCalledWith('/product/7')
  useAuthStore.setState({authEpoch:useAuthStore.getState().authEpoch+1})
  notice.onAction?.()
  expect(navigate).toHaveBeenCalledTimes(1)
})
it.each([{id:7,status:'draft' as const},{id:8,status:'active' as const}])('does not report success for an unconfirmed response %j', result => {
  expect(showProductPublished({id:7,name:'商品'},{...result,publishedAt:null},vi.fn())).toBe(false)
  expect(useAppStore.getState().islandNotice).toBeNull()
  expect(useAppStore.getState().toasts[0].type).toBe('warning')
})
it('preserves the desktop message', () => {
  vi.spyOn(window,'matchMedia').mockReturnValue({matches:false} as MediaQueryList)
  showProductPublished({id:7,name:'商品'},{id:7,status:'active',publishedAt:null},vi.fn(),'商品已上架')
  expect(useAppStore.getState().islandNotice).toBeNull()
  expect(useAppStore.getState().toasts[0].message).toBe('商品已上架')
})

it('replaces the same product publication notice and opens its merchant editor after unpublishing', () => {
  const navigate = vi.fn()
  showProductPublished({ id: 7, name: '商品' }, { id: 7, status: 'active', publishedAt: null }, navigate)
  expect(showProductUnpublished({ id: 7, name: '商品' }, { id: 7, status: 'inactive', publishedAt: null }, navigate)).toBe(true)
  const notice = useAppStore.getState().islandNotice!
  expect(notice.title).toBe('商品已下架')
  expect(useAppStore.getState().islandQueue).toHaveLength(0)
  notice.onAction?.()
  expect(navigate).toHaveBeenCalledWith('/merchant/products/7/edit')
  useAuthStore.setState({ authEpoch: useAuthStore.getState().authEpoch + 1 })
  notice.onAction?.()
  expect(navigate).toHaveBeenCalledOnce()
})

it.each([{ id: 7, status: 'active' as const }, { id: 8, status: 'inactive' as const }])('rejects an unconfirmed unpublish response %j', result => {
  expect(showProductUnpublished({ id: 7, name: '商品' }, { ...result, publishedAt: null }, vi.fn())).toBe(false)
  expect(useAppStore.getState().islandNotice).toBeNull()
  expect(useAppStore.getState().toasts[0].type).toBe('warning')
})
