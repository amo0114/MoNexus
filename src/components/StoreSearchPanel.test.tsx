import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import StoreSearchPanel from './StoreSearchPanel'
import { useAppStore } from '../stores/appStore'

it('focuses without scrolling, preserves IME confirmation, and closes on committed Enter/Escape', () => {
  const focus = vi.spyOn(HTMLInputElement.prototype, 'focus')
  const close = vi.fn()
  render(<StoreSearchPanel onClose={close} />)
  const input = screen.getByRole('textbox', { name: '搜索商品' })
  expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  fireEvent.change(input, { target: { value: '三国' } })
  expect(useAppStore.getState().storeQuery).toBe('三国')
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
  expect(close).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(close).toHaveBeenCalledTimes(2)
  focus.mockRestore()
})
