// R09b — the extracted package dialogs own their own form state, so the two
// reset surfaces that used to be handled by the parent's openEditDialog are
// re-verified here through the real manager: switching the edit target and
// reopening after a failed save must both start from the new target's pristine
// DTO values with no stale field or server error left behind.
//
// Reopen-after-cancel / reopen-after-error reset for the create dialog and
// reopen-on-the-same-row reset for the edit dialog stay covered by
// AdminPromotionPackageManager.test.tsx; this file adds only the cross-target
// switch that no existing case exercises.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AdminPromotionPackageManager, {
  type AdminPromotionPackageAdapter,
} from '../AdminPromotionPackageManager'
import type {
  AdminPromotionPackageCreatePayload,
  AdminPromotionPackageDTO,
  AdminPromotionPackageUpdatePayload,
} from '../../../types/merchandising'

const homePackage: AdminPromotionPackageDTO = {
  id: 11,
  code: 'PKG-STORE-HOME-30',
  label: '首页顶部推广位 30 天',
  placement: 'store_home_sponsored',
  durationDays: 30,
  pricePoints: 1200,
  description: '首页推广位月度套餐',
  sortOrder: 100,
  status: 'active',
  createdAt: '2026-01-05T02:00:00.000Z',
  updatedAt: '2026-01-06T08:30:00.000Z',
}

const categoryPackage: AdminPromotionPackageDTO = {
  id: 22,
  code: 'PKG-CATEGORY-7D',
  label: '分类推广位 7 天',
  placement: 'category_sponsored',
  durationDays: 7,
  pricePoints: 300,
  description: '',
  sortOrder: -5,
  status: 'inactive',
  createdAt: '2025-12-01T09:00:00.000Z',
  updatedAt: '2026-01-02T11:15:00.000Z',
}

function renderManager() {
  const listPackages = vi.fn(async (_includeInactive: boolean) => [
    homePackage,
    categoryPackage,
  ])
  const createPackage = vi.fn<
    (payload: AdminPromotionPackageCreatePayload) => Promise<AdminPromotionPackageDTO>
  >()
  createPackage.mockResolvedValue(homePackage)
  const updatePackage = vi.fn<
    (id: number, payload: AdminPromotionPackageUpdatePayload) => Promise<AdminPromotionPackageDTO>
  >()
  updatePackage.mockResolvedValue(categoryPackage)

  const adapter: AdminPromotionPackageAdapter = { listPackages, createPackage, updatePackage }
  render(<AdminPromotionPackageManager adapter={adapter} />)
  return { listPackages, createPackage, updatePackage }
}

const HOME_EDIT_BUTTON = '编辑套餐 PKG-STORE-HOME-30（套餐 ID 11）'
const CATEGORY_EDIT_BUTTON = '编辑套餐 PKG-CATEGORY-7D（套餐 ID 22）'

describe('package dialogs — edit target switch', () => {
  it('switching rows reseeds every field from the new DTO and clears the previous field error', async () => {
    const { listPackages, createPackage, updatePackage } = renderManager()
    await screen.findByRole('table', { name: '推广套餐列表' })

    // Open on the active store-home row and dirty every editable field, then
    // make duration invalid so a field error is on screen when we switch.
    fireEvent.click(screen.getByRole('button', { name: HOME_EDIT_BUTTON }))
    const homeDialog = await screen.findByRole('dialog', { name: '编辑推广套餐' })
    fireEvent.change(within(homeDialog).getByLabelText('套餐名称'), {
      target: { value: '首页顶部推广位 60 天' },
    })
    fireEvent.change(within(homeDialog).getByLabelText('展位'), {
      target: { value: 'category_sponsored' },
    })
    fireEvent.change(within(homeDialog).getByLabelText('状态'), {
      target: { value: 'inactive' },
    })
    fireEvent.change(within(homeDialog).getByLabelText('时长（天）'), { target: { value: '91' } })
    fireEvent.change(within(homeDialog).getByLabelText('排序'), { target: { value: '200' } })
    fireEvent.click(within(homeDialog).getByRole('button', { name: '确认保存' }))
    expect(within(homeDialog).getByRole('alert')).toHaveTextContent('时长必须为 1 到 90 的整数')
    expect(updatePackage).not.toHaveBeenCalled()

    // Cancel, then open the OTHER row — every field must come from that DTO.
    fireEvent.click(within(homeDialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: CATEGORY_EDIT_BUTTON }))
    const categoryDialog = await screen.findByRole('dialog', { name: '编辑推广套餐' })

    expect(within(categoryDialog).getByLabelText('套餐名称')).toHaveValue('分类推广位 7 天')
    expect(within(categoryDialog).getByLabelText('展位')).toHaveValue('category_sponsored')
    expect(within(categoryDialog).getByLabelText('状态')).toHaveValue('inactive')
    expect(within(categoryDialog).getByLabelText('时长（天）')).toHaveValue('7')
    expect(within(categoryDialog).getByLabelText('价格（积分）')).toHaveValue('300')
    expect(within(categoryDialog).getByLabelText('排序')).toHaveValue('-5')
    // empty description on this DTO must not inherit the previous row's text
    expect(within(categoryDialog).getByLabelText('说明')).toHaveValue('')

    // immutable code display follows the new target, still a read-only div
    const codeDisplay = within(categoryDialog).getByText('PKG-CATEGORY-7D')
    expect(codeDisplay).toHaveAttribute('id', 'package-edit-code')
    expect(codeDisplay.tagName).toBe('DIV')

    // the previous row's validation error did not leak into the new target
    expect(within(categoryDialog).queryByRole('alert')).not.toBeInTheDocument()

    // cancels never mutate and never re-issue the list query
    expect(createPackage).not.toHaveBeenCalled()
    expect(updatePackage).not.toHaveBeenCalled()
    expect(listPackages).toHaveBeenCalledTimes(1)
  })

  it('switching back reseeds non-empty text fields, not just clears them', async () => {
    // The category DTO has an empty description, so the switch above cannot
    // tell "reseeded to empty" apart from "never reseeded". Going back to the
    // store-home row — whose description is non-empty — pins that direction.
    const { updatePackage } = renderManager()
    await screen.findByRole('table', { name: '推广套餐列表' })

    fireEvent.click(screen.getByRole('button', { name: CATEGORY_EDIT_BUTTON }))
    const categoryDialog = await screen.findByRole('dialog', { name: '编辑推广套餐' })
    // dirty the shared text fields so a skipped reseed would be visible
    fireEvent.change(within(categoryDialog).getByLabelText('套餐名称'), {
      target: { value: '被污染的套餐名' },
    })
    fireEvent.change(within(categoryDialog).getByLabelText('说明'), {
      target: { value: '被污染的说明' },
    })
    fireEvent.click(within(categoryDialog).getByRole('button', { name: '取消' }))

    fireEvent.click(screen.getByRole('button', { name: HOME_EDIT_BUTTON }))
    const homeDialog = await screen.findByRole('dialog', { name: '编辑推广套餐' })

    // non-empty DTO text must be restored verbatim, never left dirty or blank
    expect(within(homeDialog).getByLabelText('说明')).toHaveValue('首页推广位月度套餐')
    expect(within(homeDialog).getByLabelText('套餐名称')).toHaveValue('首页顶部推广位 30 天')
    expect(within(homeDialog).getByLabelText('展位')).toHaveValue('store_home_sponsored')
    expect(within(homeDialog).getByLabelText('状态')).toHaveValue('active')
    expect(within(homeDialog).getByLabelText('时长（天）')).toHaveValue('30')
    expect(within(homeDialog).getByLabelText('价格（积分）')).toHaveValue('1200')
    expect(within(homeDialog).getByLabelText('排序')).toHaveValue('100')
    expect(updatePackage).not.toHaveBeenCalled()
  })

  it('switching rows after a failed save drops the previous server error', async () => {
    const { createPackage, updatePackage } = renderManager()
    await screen.findByRole('table', { name: '推广套餐列表' })

    // Fail the save on the store-home row with a server error.
    updatePackage.mockRejectedValueOnce({
      response: { data: { error: { message: '套餐服务暂时不可用' } } },
    })
    fireEvent.click(screen.getByRole('button', { name: HOME_EDIT_BUTTON }))
    const homeDialog = await screen.findByRole('dialog', { name: '编辑推广套餐' })
    fireEvent.click(within(homeDialog).getByRole('button', { name: '确认保存' }))
    await waitFor(() => expect(updatePackage).toHaveBeenCalledTimes(1))
    expect(await within(homeDialog).findByRole('alert')).toHaveTextContent('套餐服务暂时不可用')
    // failure keeps the dialog open for retry
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    // Switch to the other row — the stale server error must be gone.
    fireEvent.click(within(homeDialog).getByRole('button', { name: '取消' }))
    fireEvent.click(screen.getByRole('button', { name: CATEGORY_EDIT_BUTTON }))
    const categoryDialog = await screen.findByRole('dialog', { name: '编辑推广套餐' })

    expect(within(categoryDialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('套餐服务暂时不可用')).not.toBeInTheDocument()
    expect(within(categoryDialog).getByLabelText('套餐名称')).toHaveValue('分类推广位 7 天')
    // the failed save produced no success feedback
    expect(screen.queryByText('套餐更新成功。')).not.toBeInTheDocument()
    expect(createPackage).not.toHaveBeenCalled()
  })

  it('reopening the create dialog after a target switch still starts pristine', async () => {
    const { createPackage, updatePackage } = renderManager()
    await screen.findByRole('table', { name: '推广套餐列表' })

    // Dirty the create form, cancel it, then switch the edit target, then come
    // back to create — the two dialogs never share form state.
    fireEvent.click(screen.getByRole('button', { name: '新建套餐' }))
    const createDialog = await screen.findByRole('dialog', { name: '新建推广套餐' })
    fireEvent.change(within(createDialog).getByLabelText('套餐编码'), {
      target: { value: 'PKG-DIRTY' },
    })
    fireEvent.click(within(createDialog).getByRole('button', { name: '取消' }))

    fireEvent.click(screen.getByRole('button', { name: CATEGORY_EDIT_BUTTON }))
    const editDialog = await screen.findByRole('dialog', { name: '编辑推广套餐' })
    expect(within(editDialog).getByLabelText('套餐名称')).toHaveValue('分类推广位 7 天')
    fireEvent.click(within(editDialog).getByRole('button', { name: '取消' }))

    fireEvent.click(screen.getByRole('button', { name: '新建套餐' }))
    const reopened = await screen.findByRole('dialog', { name: '新建推广套餐' })
    expect(within(reopened).getByLabelText('套餐编码')).toHaveValue('')
    expect(within(reopened).getByLabelText('展位')).toHaveValue('store_home_sponsored')
    expect(within(reopened).queryByRole('alert')).not.toBeInTheDocument()

    expect(createPackage).not.toHaveBeenCalled()
    expect(updatePackage).not.toHaveBeenCalled()
  })
})
