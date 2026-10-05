import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AsyncButton from './AsyncButton'

describe('AsyncButton', () => {
  it('keeps the external form contract and blocks repeat clicks while pending', () => {
    const submit = vi.fn((event) => event.preventDefault())
    const view = (loading: boolean, disabled = false) => <>
      <form id="inventory" onSubmit={submit} />
      <AsyncButton form="inventory" type="submit" loading={loading} loadingLabel="导入中…" disabled={disabled}>确认导入 2 个</AsyncButton>
    </>
    const { rerender } = render(view(false))
    fireEvent.click(screen.getByRole('button', { name: '确认导入 2 个' }))
    expect(submit).toHaveBeenCalledTimes(1)
    rerender(view(true))
    const pending = screen.getByRole('button', { name: '导入中…' })
    expect(pending).toHaveAttribute('aria-busy', 'true')
    expect(pending).toBeDisabled()
    fireEvent.click(pending)
    expect(submit).toHaveBeenCalledTimes(1)
    rerender(view(false, true))
    expect(screen.getByRole('button', { name: '确认导入 2 个' })).toBeDisabled()
    rerender(view(false))
    expect(screen.getByRole('button', { name: '确认导入 2 个' })).toBeEnabled()
  })
})
