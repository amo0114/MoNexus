// T-MERCH-BE-003 — Frozen campaign transition assertions (SPEC-MERCH-001 §7.1,
// D-MERCH-11/12/13, CHK-PROMO-003). Pure module: no DB, no express — keeps the
// state-machine contract unit-testable in no-DB contexts and shared by both
// the service (this card) and T-MERCH-BE-004 billing/lifecycle.

import type { CampaignStatus } from '../constants.js'
import { HttpError } from '../../../lib/httpError.js'
import { CAMPAIGN_TRANSITIONS, PROMOTION_ERROR_CODES } from './constants.js'

/**
 * 断言 `from → to` 是冻结转换表中的合法转换；否则抛 409
 * CAMPAIGN_TRANSITION_INVALID。所有转换（含 BE-004 的 billing/lifecycle）
 * 必须通过同一张表，防止两卡状态机漂移。
 */
export function assertAllowedTransition(from: CampaignStatus, to: CampaignStatus): void {
  const allowed = CAMPAIGN_TRANSITIONS[from]
  if (!allowed.includes(to)) {
    throw new HttpError(409, PROMOTION_ERROR_CODES.CAMPAIGN_TRANSITION_INVALID as never, '不允许的状态转换')
  }
}
