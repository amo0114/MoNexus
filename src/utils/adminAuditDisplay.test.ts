import { describe, expect, it } from 'vitest'
import {
  ADMIN_AUDIT_ACTION_REGISTRY,
  ADMIN_AUDIT_TARGET_REGISTRY,
  ADMIN_AUDIT_ACTION_GROUPS,
  ADMIN_AUDIT_TARGET_OPTIONS,
  adminAuditActionVisual,
  adminAuditTargetLabel,
  type AuditTone,
} from './adminAuditDisplay'

const ALLOWED_TONES: Set<AuditTone> = new Set(['success', 'info', 'warning', 'danger', 'neutral'])

describe('adminAuditDisplay registry', () => {
  it('has unique action keys and values', () => {
    const values = Object.values(ADMIN_AUDIT_ACTION_REGISTRY).map((item) => item.value)
    const uniqueValues = new Set(values)
    expect(uniqueValues.size).toBe(values.length)
  })

  it('has unique target keys and values', () => {
    const values = Object.values(ADMIN_AUDIT_TARGET_REGISTRY).map((item) => item.value)
    const uniqueValues = new Set(values)
    expect(uniqueValues.size).toBe(values.length)
  })

  describe('action registry entries', () => {
    const actionEntries = Object.entries(ADMIN_AUDIT_ACTION_REGISTRY)

    it.each(actionEntries)(
      'action %s has non-empty Chinese label, valid tone and non-empty group',
      (key, item) => {
        expect(item.value).toBe(key)
        expect(item.label.trim().length).toBeGreaterThan(0)
        expect(ALLOWED_TONES.has(item.tone)).toBe(true)
        expect(item.group.trim().length).toBeGreaterThan(0)
        // No raw internal dot-syntax code in label
        expect(item.label).not.toMatch(/^[a-z_]+\.[a-z_.]+$/)
        expect(item.label).not.toContain('.')
      }
    )

    it('maps all stable code-type actions to pure Chinese labels', () => {
      const codeActions = [
        'value_policy.create',
        'value_policy.approve',
        'value_policy.schedule',
        'value_policy.activate',
        'value_policy.retire',
        'payment.event.retry',
        'payment.order.reconcile',
        'payment.order.refund',
        'payment.admin_sandbox.confirm',
        'payment.recon.create',
        'payment.recon.rerun',
        'payment.dispute.resolve',
        'payment.recovery_case.close',
        'recharge.price_policy.create',
        'recharge.price_policy.patch',
        'recharge.price_policy.activate',
      ]

      for (const codeAction of codeActions) {
        const visual = adminAuditActionVisual(codeAction)
        expect(visual.label).not.toBe('其他操作')
        expect(visual.label).not.toContain(codeAction)
        expect(visual.label).not.toContain('.')
        expect(/[\u4e00-\u9fa5]/.test(visual.label)).toBe(true)
      }
    })

    it('maps external branded actions to pure Chinese labels', () => {
      expect(adminAuditActionVisual('同步Xboard商品').label).toBe('同步外部平台商品')
      expect(adminAuditActionVisual('重试Faka开通').label).toBe('重试外部平台开通')
      expect(adminAuditActionVisual('强制撤销Xboard订阅').label).toBe('强制撤销外部平台订阅')
      expect(adminAuditActionVisual('同步Faka订阅到期').label).toBe('同步外部平台订阅到期')
    })
  })

  describe('target registry entries', () => {
    const targetEntries = Object.entries(ADMIN_AUDIT_TARGET_REGISTRY)

    it.each(targetEntries)('targetType %s has non-empty Chinese label', (key, item) => {
      expect(item.value).toBe(key)
      expect(item.label.trim().length).toBeGreaterThan(0)
      expect(/[\u4e00-\u9fa5]/.test(item.label)).toBe(true)
    })
  })

  describe('fallback and unknown value handling', () => {
    it('returns 其他操作 with neutral tone for unknown or empty actions', () => {
      expect(adminAuditActionVisual('completely_unknown_action')).toEqual({
        label: '其他操作',
        tone: 'neutral',
      })
      expect(adminAuditActionVisual('')).toEqual({
        label: '其他操作',
        tone: 'neutral',
      })
      expect(adminAuditActionVisual(undefined)).toEqual({
        label: '其他操作',
        tone: 'neutral',
      })
      expect(adminAuditActionVisual(null)).toEqual({
        label: '其他操作',
        tone: 'neutral',
      })
    })

    it('returns 无特定对象 for null or empty targetType', () => {
      expect(adminAuditTargetLabel(null)).toBe('无特定对象')
      expect(adminAuditTargetLabel(undefined)).toBe('无特定对象')
      expect(adminAuditTargetLabel('')).toBe('无特定对象')
    })

    it('returns 其他对象 for unknown non-empty targetType', () => {
      expect(adminAuditTargetLabel('unknown_custom_target')).toBe('其他对象')
    })
  })

  describe('dropdown options structures', () => {
    it('groups all actions into non-empty groups without dot notation in labels', () => {
      expect(ADMIN_AUDIT_ACTION_GROUPS.length).toBeGreaterThan(0)
      for (const group of ADMIN_AUDIT_ACTION_GROUPS) {
        expect(group.group.trim().length).toBeGreaterThan(0)
        expect(group.options.length).toBeGreaterThan(0)
        for (const opt of group.options) {
          expect(opt.label).not.toContain('.')
          expect(opt.value.length).toBeGreaterThan(0)
        }
      }
    })

    it('exports target options with Chinese labels', () => {
      expect(ADMIN_AUDIT_TARGET_OPTIONS.length).toBe(Object.keys(ADMIN_AUDIT_TARGET_REGISTRY).length)
      for (const opt of ADMIN_AUDIT_TARGET_OPTIONS) {
        expect(opt.label.length).toBeGreaterThan(0)
        expect(/[\u4e00-\u9fa5]/.test(opt.label)).toBe(true)
      }
    })
  })
})
