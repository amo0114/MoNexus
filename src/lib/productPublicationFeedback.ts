import type { PublishActionResult } from '../types/catalog'
import { useAppStore } from '../stores/appStore'
import { showCompletionActivity } from './completionFeedback'

/** Publishing is immediate in this catalog; there is no pending-review state. */
export function showProductPublished(
  product: { id: number; name: string },
  result: PublishActionResult,
  navigate: (path: string) => void,
  desktopMessage = '商品发布成功',
): boolean {
  if (result.id !== product.id || result.status !== 'active') {
    useAppStore.getState().showToast('未确认商品已发布，请刷新商品状态后重试', 'warning')
    return false
  }
  showCompletionActivity({
    title: '商品发布成功', message: desktopMessage,
    subtitle: product.name,
    groupKey: `merchant:product:${product.id}`,
    actionLabel: '查看商品',
    onAction: () => navigate(`/product/${product.id}`),
  })
  return true
}

export function showProductUnpublished(
  product: { id: number; name: string },
  result: PublishActionResult,
  navigate: (path: string) => void,
): boolean {
  if (result.id !== product.id || result.status !== 'inactive') {
    useAppStore.getState().showToast('未确认商品已下架，请刷新商品状态后重试', 'warning')
    return false
  }
  showCompletionActivity({
    title: '商品已下架',
    subtitle: product.name,
    groupKey: `merchant:product:${product.id}`,
    actionLabel: '管理商品',
    onAction: () => navigate(`/merchant/products/${product.id}/edit`),
  })
  return true
}
