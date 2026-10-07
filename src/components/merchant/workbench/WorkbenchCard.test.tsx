import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { draftIssue, draftItem } from '../../../test/workbenchFixtures'
import type { DraftIssue } from '../../../api/merchant/workbench'
import WorkbenchCard, { draftIssueLabel } from './WorkbenchCard'

const edit = (focus: 'offers' | 'publication', offerId: number | null) => ({ kind: 'edit_product' as const, productId: 30, focus, offerId })

describe('draftIssueLabel', () => {
  it.each([
    ['COVER_REQUIRED', {}, '缺少商品封面'],
    ['PURCHASE_NOTES_REQUIRED', {}, '缺少购买须知'],
    ['AFTER_SALES_REQUIRED', {}, '缺少售后说明'],
    ['TEMPLATE_FIELDS_REQUIRED', {}, '商品参数未补齐'],
    ['TEMPLATE_FIELDS_REQUIRED', { offerId: 12 }, '规格参数未补齐'],
    ['FULFILLMENT_CONFIG_INVALID', { offerId: 12 }, '规格交付配置需调整'],
    ['CATEGORY_INACTIVE', {}, '分类已停用：请更换分类或联系平台'],
    ['EXTERNAL_IDENTITY_INVALID', { offerId: 12 }, '外部开通配置需检查，必要时联系平台'],
    ['SOMETHING_NEW', {}, '发布条件尚未满足'],
  ] as const)('%s %j → %s', (code, overrides, label) => {
    expect(draftIssueLabel(draftIssue(code, overrides as Partial<DraftIssue>))).toBe(label)
  })
})

describe('OFFER_NOT_SELLABLE uses the server action as-is', () => {
  it.each([
    ['no active offer', { offerId: null, action: edit('offers', null) }, '没有启用的规格', '/merchant/products/30/edit?focus=offers'],
    ['invalid offer config', { offerId: 12, action: edit('offers', 12) }, '规格配置需检查', '/merchant/products/30/edit?focus=offers&offerId=12'],
    ['valid offer without stock', { offerId: 12, action: { kind: 'manage_availability' as const, productId: 30, offerId: 12 } }, '规格暂无可售量', '/merchant?availabilityProductId=30&offerId=12'],
  ])('%s', (_case, overrides, label, href) => {
    const item = draftItem(30, [draftIssue('OFFER_NOT_SELLABLE', overrides)])
    render(<MemoryRouter><ul><WorkbenchCard item={item} stale={false} /></ul></MemoryRouter>)
    expect(screen.getByTestId('workbench-draft-issues')).toHaveTextContent(label)
    expect(screen.getByTestId('workbench-card-action')).toHaveAttribute('href', href)
    // A single-issue draft has no extra per-issue links.
    expect(screen.queryByTestId('workbench-issue-link-0')).not.toBeInTheDocument()
  })
})
