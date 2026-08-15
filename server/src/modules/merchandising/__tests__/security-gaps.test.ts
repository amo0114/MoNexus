import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (relative: string) => readFileSync(resolve(import.meta.dirname, '../../../', relative), 'utf8')

describe('CMI merchandising security evidence', () => {
  it('mounts every admin merchandising/catalog route behind the MFA guard', () => {
    const routes = source('modules/admin/routes.ts')
    expect(routes).toMatch(/router\.use\(authenticate, requireActiveUser, requireAdmin, requireAdminMfa\)/)
    expect(routes).toMatch(/router\.(get|post|put|delete)\('\/products/)
    expect(routes).toMatch(/router\.(get|post|put|delete)\('\/logs'/)

    const promotions = source('modules/merchandising/promotions/routes.ts')
    expect(promotions).toContain(
      'adminPromotionRouter.use(authenticate, requireActiveUser, requireAdmin, requireAdminMfa)',
    )
    expect(promotions).toMatch(/adminPromotionRouter\.(get|post|patch)\('\/promotion-/)
  })

  it('requires a verified MFA claim and version before an admin session can be allowed', () => {
    const auth = source('middlewares/auth.ts')
    expect(auth).toMatch(/payload\.mfaVerified !== true/)
    expect(auth).toMatch(/typeof mfaVersion !== 'number'/)
    expect(auth).toMatch(/return 'mfa_required'/)
    expect(auth).toMatch(/next\(mfaRequired\(\)\)/)
  })

  it('records the PointLog boundary: no HTTP update/delete path exists', () => {
    const routes = source('modules/admin/routes.ts')
    expect(routes).not.toMatch(/router\.(put|patch|delete)\([^\n]*point.?logs?/i)
    expect(routes).not.toMatch(/router\.(put|patch|delete)\([^\n]*logs\/\:id/i)
    expect(routes).toMatch(/router\.get\('\/logs', controller\.logs\)/)
  })

  it('keeps sensitive token/email/balance material out of the documented audit projection', () => {
    const adminReadme = source('modules/admin/README.md')
    const authReadme = source('modules/auth/README.md')
    expect(adminReadme).toMatch(/every email is masked/i)
    expect(adminReadme).toMatch(/PointLog.*not.*AdminLog/i)
    expect(authReadme).toMatch(/Never expose raw IP/i)
    expect(authReadme).toMatch(/complete User-Agent, token, token hash, MFA seed, or recovery code/i)
  })

  it('has no CPM/CPC/bidding/fiat/earnings-promise promotion vocabulary in the current catalog surface', () => {
    const catalog = `${source('modules/merchant/schema.ts')}\n${source('modules/merchant/service.ts')}\n${source('modules/admin/schema.ts')}`
    expect(catalog).not.toMatch(/\b(?:CPM|CPC)\b|竞价|法币|收益承诺/i)
  })
})
