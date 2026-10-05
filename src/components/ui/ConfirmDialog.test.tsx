import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ConfirmDialog from './ConfirmDialog'

describe('ConfirmDialog pending feedback', () => {
  it('keeps a named action while pending and allows dismissal again after failure', async () => {
    const clicker = userEvent.setup()
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    const view = (loading: boolean) => <ConfirmDialog open title="删除规格" description="删除后无法恢复" confirmLabel="确认删除" loadingLabel="删除中…" loading={loading} onConfirm={onConfirm} onOpenChange={onOpenChange} />
    const { rerender } = render(view(false))
    await clicker.click(screen.getByRole('button', { name: '确认删除' }))
    expect(onConfirm).toHaveBeenCalledOnce()
    rerender(view(true))
    const action = screen.getByRole('button', { name: '删除中…' })
    expect(action).toHaveAttribute('aria-busy', 'true')
    expect(action).toBeDisabled()
    await clicker.click(action)
    await clicker.click(screen.getByRole('button', { name: '取消' }))
    await clicker.keyboard('{Escape}')
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull()
    rerender(view(false))
    expect(screen.getByRole('button', { name: '确认删除' })).toBeEnabled()
    await clicker.click(screen.getByRole('button', { name: '关闭' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('uses a meaningful default pending label for existing callers', () => {
    render(<ConfirmDialog open loading title="确认操作" description="请稍候" onConfirm={vi.fn()} onOpenChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled()
  })
})
