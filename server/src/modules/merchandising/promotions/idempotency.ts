// T-MERCH-BE-003 — Spec §11 shared idempotency validator + canonicalizer
// (SPEC-MERCH-001 §11, D-MERCH-10/13, AC-MERCH-009/015, CHK-PROMO-013).
//
// Pure module (node:crypto only, no DB, no express) so the frozen SHA-256
// vectors run in any no-DB unit context. Shared by the Campaign create path
// (this card) and the refund-adjustment path (T-MERCH-BE-004 reuses it).
//
// Frozen semantics (§11):
//   - `Idempotency-Key` 在 HTTP OWS trim 后必须匹配 `[A-Za-z0-9._:-]{1,128}`，
//     按原值保存且大小写敏感；缺失 → 400 IDEMPOTENCY_KEY_REQUIRED，
//     格式错误 → 400 IDEMPOTENCY_KEY_INVALID；
//   - hash 输入先经过 strict schema 校验；未知字段拒绝。字符串先 trim，
//     再做 Unicode NFC；整数保持十进制整数；时间解析后统一为 UTC 毫秒
//     ISO-8601（YYYY-MM-DDTHH:mm:ss.sssZ），省略的 requestedStartAt 与 null
//     都规范为 null；
//   - create canonical bytes = UTF-8 JSON array
//     `["campaign-create-v1",productId,packageId,requestedStartAtUtcOrNull]`；
//     adjustment canonical bytes =
//     `["campaign-adjustment-v1",campaignId,points,normalizedReason]`；
//   - 对 bytes 取 SHA-256 lowercase hex。禁止依赖普通 object key 枚举顺序。
//
// SECURITY (CHK-PROMO-013 / CHK-SEC-004): the returned hash/validator output
// is only ever persisted on the campaign row; no response/log/metric may echo
// it. Callers of this module must not log its output.

import { createHash } from 'node:crypto'
import {
  CAMPAIGN_ADJUSTMENT_CANONICAL_VERSION,
  CAMPAIGN_CREATE_CANONICAL_VERSION,
} from '../constants.js'
import { HttpError } from '../../../lib/httpError.js'
import { PROMOTION_ERROR_CODES } from './constants.js'

/** Idempotency-Key after OWS trim must match this (case-sensitive, 1..128). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/


function missingKey(): HttpError {
  return new HttpError(400, PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED as never, '缺少 Idempotency-Key 请求头')
}

function invalidKey(): HttpError {
  return new HttpError(400, PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_INVALID as never, 'Idempotency-Key 格式无效')
}

/** RFC 7230 OWS：仅 SP / HTAB 出现在两侧才允许被 trim。 */
function stripOws(value: string): string {
  return value.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')
}

/**
 * Validate + normalize an `Idempotency-Key` header per §11.
 *
 * - raw 缺失 / 空 / 全 OWS → 400 IDEMPOTENCY_KEY_REQUIRED；
 * - OWS trim 后不匹配 `[A-Za-z0-9._:-]{1,128}` → 400 IDEMPOTENCY_KEY_INVALID；
 * - 返回 OWS trim 后的原值（大小写敏感，按原值保存）。
 *
 * 纯函数、无副作用；错误用 HttpError 表达以便 controller 直接 next(err)。
 */
export function validateIdempotencyKey(raw: string | undefined | null): string {
  if (typeof raw !== 'string' || raw.length === 0 || stripOws(raw).length === 0) {
    throw missingKey()
  }
  const key = stripOws(raw)
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw invalidKey()
  }
  return key
}

/** 字符串先 trim，再做 Unicode NFC（§11 hash 输入归一化）。 */
export function normalizeCanonicalString(value: string): string {
  return value.trim().normalize('NFC')
}

/**
 * 时间解析后统一为 UTC 毫秒 ISO-8601（`YYYY-MM-DDTHH:mm:ss.sssZ`）。
 * 非法时间 → 400 IDEMPOTENCY_KEY_INVALID（属于 key/payload 契约，而非业务 422）。
 * 省略的 requestedStartAt 与 null 都规范为 null（由调用方决定，此处不处理 null）。
 */
export function normalizeCanonicalDateTime(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw invalidKey()
  }
  return parsed.toISOString()
}

function sha256LowerHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Campaign create canonical payload (SPEC-MERCH-001 §11).
 *
 * 输入必须是已通过 strict schema 校验的值（未知字段已在 schema 层拒绝）：
 *   - productId/packageId 为十进制正整数；
 *   - requestedStartAtUtcOrNull：null 或规范化后的 `YYYY-MM-DDTHH:mm:ss.sssZ`。
 *
 * canonical bytes = UTF-8 JSON array `["campaign-create-v1",productId,packageId,
 * requestedStartAtUtcOrNull]`（placement 由 packageId 服务端快照决定，不进 canonical）；
 * 返回 SHA-256 lowercase hex。
 */
export function canonicalizeCampaignCreate(input: {
  productId: number
  packageId: number
  requestedStartAtUtcOrNull: string | null
}): string {
  if (!Number.isInteger(input.productId) || input.productId <= 0) {
    throw invalidKey()
  }
  if (!Number.isInteger(input.packageId) || input.packageId <= 0) {
    throw invalidKey()
  }
  const requestedStartAtUtcOrNull =
    input.requestedStartAtUtcOrNull === null ? null : normalizeCanonicalDateTime(input.requestedStartAtUtcOrNull)
  const canonical = [
    CAMPAIGN_CREATE_CANONICAL_VERSION,
    input.productId,
    input.packageId,
    requestedStartAtUtcOrNull,
  ]
  return sha256LowerHex(Buffer.from(JSON.stringify(canonical), 'utf8'))
}

/**
 * Campaign adjustment canonical payload (SPEC-MERCH-001 §11). Shared with the
 * refund-adjustment path (T-MERCH-BE-004); defined here so the two cards share
 * one validator/canonicalizer and the frozen vectors are tested once.
 *
 * canonical bytes = `["campaign-adjustment-v1",campaignId,points,normalizedReason]`。
 */
export function canonicalizeCampaignAdjustment(input: {
  campaignId: number
  points: number
  reason: string
}): string {
  if (!Number.isInteger(input.campaignId) || input.campaignId <= 0) {
    throw invalidKey()
  }
  if (!Number.isInteger(input.points) || input.points < 0) {
    throw invalidKey()
  }
  const canonical = [
    CAMPAIGN_ADJUSTMENT_CANONICAL_VERSION,
    input.campaignId,
    input.points,
    normalizeCanonicalString(input.reason),
  ]
  return sha256LowerHex(Buffer.from(JSON.stringify(canonical), 'utf8'))
}

/** 64 位 lowercase hex：requestPayloadHash / adjustmentPayloadHash 的 DB CHECK 形态。 */
export const CANONICAL_HASH_PATTERN = /^[0-9a-f]{64}$/
