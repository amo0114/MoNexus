// settlementCopy.test.ts — frozen 资金/结算 copy projection tests
// (SPEC-CMI-UX-001 §6.1; D-UX-19; AC-UX-020; T-UX-007 DoD).

import { describe, expect, it } from 'vitest'
import {
  blockReasonToUserMessage,
  formatProcessingDeadline,
  PROCESSING_TIMEOUT_LABEL,
  SETTLEMENT_TERM,
} from './settlementCopy'

describe('frozen settlement terms (AC-UX-020/021)', () => {
  it('exposes the frozen business terms', () => {
    expect(SETTLEMENT_TERM.PLATFORM_FEE).toBe('平台服务费')
    expect(SETTLEMENT_TERM.ORDER_AMOUNT).toBe('订单金额')
    expect(SETTLEMENT_TERM.SETTLEMENT_AMOUNT).toBe('结算金额')
  })

  it('replaces the internal SLA phrase with the frozen user phrase', () => {
    expect(PROCESSING_TIMEOUT_LABEL).toBe('已超过处理时限')
    expect(PROCESSING_TIMEOUT_LABEL).not.toContain('SLA')
  })
})

describe('blockReasonToUserMessage (D-UX-19)', () => {
  it('passes through the known server reasons verbatim', () => {
    expect(blockReasonToUserMessage('订单待处理，暂不可结算')).toBe('订单待处理，暂不可结算')
    expect(blockReasonToUserMessage('订单履约中，暂不可结算')).toBe('订单履约中，暂不可结算')
    expect(blockReasonToUserMessage('订单争议中，暂不可结算')).toBe('订单争议中，暂不可结算')
    expect(blockReasonToUserMessage('订单已退款，不可结算')).toBe('订单已退款，不可结算')
  })

  it('maps the unknown internal fallback to the safe contact message', () => {
    expect(blockReasonToUserMessage('订单状态不可结算')).toBe('暂时无法结算，请联系平台处理')
  })

  it('unknown/raw reason → safe fallback, never leaks the raw string', () => {
    const raw = 'BLOCKED_REASON_REFUNDED_INTERNAL'
    expect(blockReasonToUserMessage(raw)).toBe('暂时无法结算，请联系平台处理')
  })

  it('null/empty → null', () => {
    expect(blockReasonToUserMessage(null)).toBeNull()
    expect(blockReasonToUserMessage(undefined)).toBeNull()
    expect(blockReasonToUserMessage('   ')).toBeNull()
  })
})

describe('formatProcessingDeadline', () => {
  it('formats a parseable ISO deadline', () => {
    const formatted = formatProcessingDeadline('2026-08-16T12:00:00.000Z')
    expect(formatted).not.toBeNull()
    expect(new Date(formatted!)).not.toBeNaN()
  })

  it('shows unparseable input verbatim instead of crashing', () => {
    expect(formatProcessingDeadline('not-a-date')).toBe('not-a-date')
  })

  it('null/empty → null', () => {
    expect(formatProcessingDeadline(null)).toBeNull()
    expect(formatProcessingDeadline('')).toBeNull()
  })
})
