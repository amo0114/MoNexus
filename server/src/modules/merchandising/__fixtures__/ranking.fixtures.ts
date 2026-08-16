// T-MERCH-BE-002 — Frozen cursor / projection fixtures (SPEC-MERCH-001 §6.3/§9,
// D-MERCH-07/08, AC-MERCH-007/008, CHK-HOT-009/010/011, CHK-SEC-001).
//
// 这些是 DTO-contract 冻结 fixture：CMI Integration Owner / FE lane / BE-005 增量
// 都按它们对接，改变必须回改 SPEC 的 D/REQ/AC 并重新 Owner 批准（PAR §6 rule 4）。
// 纯数据模块：不 import prisma，可在无 DB 环境单测。

import type { MerchandisingProjection } from '../contracts.js'
import type { OrganicCursorPayload } from '../publicProjection.js'

/** 钉住 run 的稳定 UUID（仅测试/文档；实际由 DB 生成）。 */
export const FROZEN_RUN_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

/** 冻结 filter 与其规范 SHA-256（computeFilterHash 的契约向量）。 */
export const FROZEN_FILTERS = {
  CATEGORY_ONLY: { filter: { categoryCode: 'network-node', query: null }, hash: 'b955b397c3a37d36c5ed7891424fb9f6116a4cec0252234ae223f1ab77f4ef04' },
  EMPTY: { filter: {}, hash: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a' },
  CATEGORY_AND_QUERY: { filter: { categoryCode: 'network-node', query: '节点' }, hash: 'b154606693def160a375861a073c8e5b4bd2ff74b4ee1debc7012cb3cf7b3329' },
} as const

/** 冻结 cursor：hot 商品页（isHot=true, count=18, id=42，钉住 FROZEN_RUN_ID）。 */
export const HOT_CURSOR_PAYLOAD: OrganicCursorPayload = {
  v: 1,
  runId: FROZEN_RUN_ID,
  isHot: true,
  effectiveOrderCount: 18,
  productId: 42,
  filterHash: FROZEN_FILTERS.CATEGORY_ONLY.hash,
}
export const HOT_CURSOR_ENCODED =
  'eyJ2IjoxLCJydW5JZCI6ImFhYWFhYWFhLWJiYmItNGNjYy04ZGRkLWVlZWVlZWVlZWVlZSIsImlzSG90Ijp0cnVlLCJlZmZlY3RpdmVPcmRlckNvdW50IjoxOCwicHJvZHVjdElkIjo0MiwiZmlsdGVySGFzaCI6ImI5NTViMzk3YzNhMzdkMzZjNWVkNzg5MTQyNGZiOWY2MTE2YTRjZWMwMjUyMjM0YWUyMjNmMWFiNzdmNGVmMDQifQ'

/** 冻结 cursor：no-run fallback 页（runId=null, hot=false, count=0, id=9）。 */
export const NO_RUN_CURSOR_PAYLOAD: OrganicCursorPayload = {
  v: 1,
  runId: null,
  isHot: false,
  effectiveOrderCount: 0,
  productId: 9,
  filterHash: FROZEN_FILTERS.EMPTY.hash,
}
export const NO_RUN_CURSOR_ENCODED =
  'eyJ2IjoxLCJydW5JZCI6bnVsbCwiaXNIb3QiOmZhbHNlLCJlZmZlY3RpdmVPcmRlckNvdW50IjowLCJwcm9kdWN0SWQiOjksImZpbHRlckhhc2giOiI0NDEzNmZhMzU1YjM2NzhhMTE0NmFkMTZmN2U4NjQ5ZTk0ZmI0ZmMyMWZlNzdlODMxMGMwNjBmNjFjYWFmZjhhIn0'

/** 冻结 projection DTO：hot 商品（Spec §9 示例：effectiveOrders=18, rank=2, windowDays=30）。 */
export const HOT_PROJECTION_FIXTURE: MerchandisingProjection = {
  rankingRunId: FROZEN_RUN_ID,
  hot: {
    effectiveOrders: 18,
    rank: 2,
    windowDays: 30,
    computedAt: '2026-08-09T00:00:00.000Z',
  },
  platformOwned: false,
  platformPick: null,
  merchantPartner: null,
}

/** 冻结 projection DTO：非 hot 商品（有 snapshot 但未达阈值；hot 块仍返回本商品指标）。 */
export const NON_HOT_PROJECTION_FIXTURE: MerchandisingProjection = {
  rankingRunId: FROZEN_RUN_ID,
  hot: {
    effectiveOrders: 1,
    rank: 7,
    windowDays: 30,
    computedAt: '2026-08-09T00:00:00.000Z',
  },
  platformOwned: false,
  platformPick: null,
  merchantPartner: null,
}

/** 冻结 projection DTO：平台自营（merchantId=null），hot 块正常。 */
export const PLATFORM_OWNED_PROJECTION_FIXTURE: MerchandisingProjection = {
  rankingRunId: FROZEN_RUN_ID,
  hot: {
    effectiveOrders: 3,
    rank: 1,
    windowDays: 30,
    computedAt: '2026-08-09T00:00:00.000Z',
  },
  platformOwned: true,
  platformPick: null,
  merchantPartner: null,
}

/** 冻结 projection DTO：无 completed run 的 no-run fallback（hot 块整体缺省，不读 legacy isHot）。 */
export const NO_RUN_PROJECTION_FIXTURE: MerchandisingProjection = {
  rankingRunId: null,
  hot: null,
  platformOwned: false,
  platformPick: null,
  merchantPartner: null,
}
