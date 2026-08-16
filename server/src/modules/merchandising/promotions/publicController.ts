// T-MERCH-BE-004 — Public sponsored controller (SPEC-MERCH-001 §7.5).
// Thin express handler: parse query → listSponsoredItems → minimal DTO.
// No auth required (public); no internal field ever leaves the DTO.

import { Request, Response, NextFunction } from 'express'
import type { SponsoredPlacement } from '../constants.js'
import { listSponsoredItems, normalizeSponsoredLimit, type SponsoredQueryInput } from './publicSponsored.js'

export async function listSponsored(req: Request, res: Response, next: NextFunction) {
  try {
    const query = req.query as { placement?: string; categoryCode?: string; limit?: string }
    const input: SponsoredQueryInput = {
      placement: (query.placement ?? undefined) as SponsoredPlacement | undefined,
      categoryCode: query.categoryCode ?? undefined,
      limit: normalizeSponsoredLimit(query.limit === undefined ? undefined : Number(query.limit)),
    }
    const items = await listSponsoredItems(input)
    // 响应只有 items（每项含 productId + 强制 disclosure）；无 chargedPoints/
    // reviewer/internalReason/余额（CHK-SEC-001 / CHK-PUBLIC-003）。
    res.json({ items })
  } catch (err) {
    next(err)
  }
}
