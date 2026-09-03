import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AdminActionMenu, { AdminActionMenuItem } from './AdminActionMenu'

describe('AdminActionMenu Component', () => {
  const items: AdminActionMenuItem[] = [
    { id: 'edit', label: '编辑商品', onClick: vi.fn(), testId: 'action-edit' },
    { id: 'archive', label: '归档商品', onClick: vi.fn(), tone: 'danger', testId: 'action-archive' },
    { id: 'disabled-op', label: '不可用操作', onClick: vi.fn(), disabled: true, testId: 'action-disabled' },
  ]

  it('renders trigger button with correct ARIA attributes and mounts menu in portal on document.body', () => {
    render(<AdminActionMenu items={items} triggerLabel="商品操作" />)

    const trigger = screen.getByRole('button', { name: '商品操作' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    const menu = screen.getByRole('menu', { name: '商品操作' })
    expect(menu).toBeInTheDocument()
    // Portal check: menu parent is document.body
    expect(menu.parentElement).toBe(document.body)

    const menuItems = screen.getAllByRole('menuitem')
    expect(menuItems).toHaveLength(3)
    expect(menuItems[0]).toHaveTextContent('编辑商品')
    expect(menuItems[1]).toHaveTextContent('归档商品')
    expect(menuItems[2]).toBeDisabled()
  })

  it('skips disabled items during ArrowDown/ArrowUp and handles leading/trailing disabled items', async () => {
    const clickFirst = vi.fn()
    const clickLast = vi.fn()

    const complexItems: AdminActionMenuItem[] = [
      { id: 'd0', label: '首项禁用', onClick: vi.fn(), disabled: true, testId: 'item-d0' },
      { id: 'e1', label: '可用项一', onClick: clickFirst, testId: 'item-e1' },
      { id: 'd2', label: '中项禁用A', onClick: vi.fn(), disabled: true, testId: 'item-d2' },
      { id: 'd3', label: '中项禁用B', onClick: vi.fn(), disabled: true, testId: 'item-d3' },
      { id: 'e4', label: '可用项二', onClick: clickLast, testId: 'item-e4' },
      { id: 'd5', label: '末项禁用', onClick: vi.fn(), disabled: true, testId: 'item-d5' },
    ]

    render(<AdminActionMenu items={complexItems} triggerLabel="高级操作" />)
    const trigger = screen.getByRole('button', { name: '高级操作' })
    trigger.focus()

    // 1. Open with ArrowDown -> should focus first ENABLED item (e1), skipping d0
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const itemE1 = screen.getByTestId('item-e1')
    await waitFor(() => {
      expect(document.activeElement).toBe(itemE1)
    })

    // 2. ArrowDown -> should jump over d2 and d3, directly focusing e4
    const itemE4 = screen.getByTestId('item-e4')
    fireEvent.keyDown(itemE1, { key: 'ArrowDown' })
    await waitFor(() => {
      expect(document.activeElement).toBe(itemE4)
    })

    // 3. ArrowDown from e4 -> wraps around, skipping d5 and d0, landing on e1
    fireEvent.keyDown(itemE4, { key: 'ArrowDown' })
    await waitFor(() => {
      expect(document.activeElement).toBe(itemE1)
    })

    // 4. ArrowUp from e1 -> wraps backward, skipping d0 and d5, landing on e4
    fireEvent.keyDown(itemE1, { key: 'ArrowUp' })
    await waitFor(() => {
      expect(document.activeElement).toBe(itemE4)
    })

    // 5. Home key -> focuses first enabled item (e1)
    fireEvent.keyDown(itemE4, { key: 'Home' })
    await waitFor(() => {
      expect(document.activeElement).toBe(itemE1)
    })

    // 6. End key -> focuses last enabled item (e4), skipping trailing d5
    fireEvent.keyDown(itemE1, { key: 'End' })
    await waitFor(() => {
      expect(document.activeElement).toBe(itemE4)
    })

    // 7. Click e4 -> triggers action, closes menu, returns focus to trigger
    fireEvent.click(itemE4)
    expect(clickLast).toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger)
  })

  it('handles menus where all items are disabled gracefully without errors', () => {
    const allDisabled: AdminActionMenuItem[] = [
      { id: 'd1', label: '只读1', onClick: vi.fn(), disabled: true, testId: 'item-all-d1' },
      { id: 'd2', label: '只读2', onClick: vi.fn(), disabled: true, testId: 'item-all-d2' },
    ]

    render(<AdminActionMenu items={allDisabled} triggerLabel="全禁用" />)
    const trigger = screen.getByRole('button', { name: '全禁用' })
    fireEvent.click(trigger)

    expect(screen.getByRole('menu')).toBeInTheDocument()
    // Arrow keys do not throw
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' })
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Home' })
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' })

    // Escape closes cleanly
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes menu and returns focus on Escape key', () => {
    render(<AdminActionMenu items={items} triggerLabel="商品操作" />)
    const trigger = screen.getByRole('button', { name: '商品操作' })

    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByTestId('action-edit'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes menu when clicking outside', () => {
    render(
      <div>
        <div data-testid="outside">外部区域</div>
        <AdminActionMenu items={items} />
      </div>,
    )

    const trigger = screen.getByRole('button', { name: '更多操作' })
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
