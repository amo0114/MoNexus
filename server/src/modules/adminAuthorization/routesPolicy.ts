import type { Request } from 'express'
import { HttpError } from '../../lib/httpError.js'
import { assertPermission, type AdminPermission } from './service.js'

/** Every independently mounted MFA admin surface delegates here. Unknown routes deny. */
export function permissionForAdminRoute(
  method: string,
  originalUrl: string,
): AdminPermission | 'admin' | null {
  const path = originalUrl.split('?')[0].replace(/\/$/, '')
  const read = method === 'GET' || method === 'HEAD'
  if (path === '/api/admin/capabilities') return 'admin'
  if (/^\/api\/(orders\/\d+\/(files?|delivery)|delivery-files\/)/.test(path))
    return 'orders.delivery.read'
  if (/^\/api\/uploads\/(delivery-file|image)$/.test(path)) return 'files.manage'
  if (path === '/api/uploads/product-video') return 'videos.manage'
  if (!path.startsWith('/api/admin/')) return null
  const p = path.slice('/api/admin/'.length)
  if (/^authorizations(\/|$)/.test(p)) return 'admin.permissions.manage'
  if (/^users\/\d+\/(ban|unban|bans)(\/|$)/.test(p)) return 'users.ban'
  if (/^users\/\d+\/adjust$/.test(p)) return 'points.adjust'
  if (/^(point-logs|logs)(\/|$)/.test(p) || /^users\/\d+\/(point-sources|point-logs)(\/|$)/.test(p))
    return 'points.read'
  if (/^users\/\d+\/orders$/.test(p)) return 'orders.read'
  if (/^users\/\d+\/security-events$/.test(p)) return 'audit.details.read'
  if (/^users\/\d+\/audit$/.test(p)) return 'audit.read'
  if (/^users(\/|$)/.test(p)) return 'users.read'
  if (/^audit\/\d+$/.test(p)) return 'audit.details.read'
  if (p === 'audit') return 'audit.read'
  if (/^merchants\/\d+\/(approve|reject)$/.test(p)) return 'merchants.review'
  if (/^merchants\/\d+\/(suspend|restore)$/.test(p)) return 'merchants.suspend'
  if (/^merchants(\/|$)/.test(p)) return read ? 'merchants.read' : 'settings.manage'
  if (/^recharge\/refunds\/[^/]+\/review$/.test(p)) return 'payments.refunds.review'
  if (/^recharge\/orders\/[^/]+\/refunds$/.test(p)) return 'payments.refunds.review'
  if (/^payments\/(disputes|recovery-cases)\//.test(p) && !read) return 'payments.disputes.resolve'
  if (/^(recharge|recharge-refunds|payments)(\/|$)/.test(p))
    return read ? 'payments.read' : 'settings.manage'
  if (/^products\/\d+\/(offers\/\d+\/)?(inventory|capacity|faka-capacity)(\/|$)/.test(p))
    return 'inventory.manage'
  if (/^products\/(draft-assistant|draft-suggestions)$/.test(p)) return 'ai.manage'
  if (/^products\/\d+\/content-suggestions(\/|$)/.test(p)) return 'ai.manage'
  if (
    /^(products|product-categories|category-applications|assurances|assurance-applications|assurance-grants|source-descriptions|source-description|faka\/catalog|faka\/import)(\/|$)/.test(
      p,
    )
  )
    return read ? 'catalog.read' : 'catalog.write'
  if (/^product-videos(\/|$)/.test(p)) return read ? 'videos.read' : 'videos.manage'
  if (/^orders\/\d+$/.test(p)) return 'orders.delivery.read' // existing detail includes delivery secrets
  if (/^(orders|after-sales)(\/|$)/.test(p))
    return read
      ? 'orders.read'
      : /^after-sales\/\d+\/execute$/.test(p)
        ? 'orders.after_sales.execute'
        : 'orders.resolve'
  if (/^(faka\/tasks|fulfillment)(\/|$)/.test(p)) return read ? 'orders.read' : 'orders.resolve'
  if (/^delivery-files(\/|$)/.test(p)) return read ? 'orders.delivery.read' : 'files.manage'
  if (/^(settlements|settlement-batches|merchant-recovery-cases)(\/|$)/.test(p))
    return read ? 'settlements.read' : 'settlements.execute'
  if (/^announcements(\/|$)/.test(p)) return read ? 'announcements.read' : 'announcements.write'
  if (
    /^(promotions|campaigns|editorial|editorial-features|entitlements|merchant-entitlements|merchandising|placements|featured|promotion-campaigns|promotion-packages)(\/|$)/.test(
      p,
    )
  )
    return read ? 'marketing.read' : 'marketing.write'
  if (/^reviews(\/|$)/.test(p)) return read ? 'catalog.read' : 'catalog.write'
  if (/^exports(\/|$)/.test(p)) return 'exports.create'
  if (/^wallet-integrity(\/|$)/.test(p)) return 'wallet.integrity.read'
  if (/^portable-backups(\/|$)/.test(p)) return 'backups.manage'
  if (/^ai(\/|-|$)/.test(p)) return 'ai.manage'
  if (/^(config|system|storage|mail|integrations|value-policies|abuse)(\/|$)/.test(p)) return 'settings.manage'
  if (p === 'stats' || /^reports\//.test(p)) return 'catalog.read'
  return null
}
export async function authorizeAdminRoute(req: Request) {
  const permission = permissionForAdminRoute(req.method, req.originalUrl)
  if (!permission) throw new HttpError(403, 'PERMISSION_DENIED', '该管理入口尚未配置权限')
  if (permission !== 'admin') await assertPermission(req.user!.userId, permission)
  else {
    // Capabilities may be read by a legitimate operator without any grants.
    const { authorization } = await import('./service.js')
    if (!(await authorization(req.user!.userId)))
      throw new HttpError(403, 'PERMISSION_DENIED', '尚未配置管理员授权')
  }
}
