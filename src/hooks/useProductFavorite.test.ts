import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PRODUCT_FAVORITES_KEY, useProductFavorite } from './useProductFavorite'

describe('product favorites', () => {
  beforeEach(() => localStorage.clear())
  afterEach(cleanup)
  it('synchronizes consumers and survives remount without losing other favorites', () => {
    localStorage.setItem(PRODUCT_FAVORITES_KEY, '[7]')
    const a = renderHook(() => useProductFavorite(42))
    const b = renderHook(() => useProductFavorite(42))
    act(() => a.result.current.toggle())
    expect(b.result.current.favorite).toBe(true)
    expect(JSON.parse(localStorage.getItem(PRODUCT_FAVORITES_KEY)!)).toEqual([7, 42])
    a.unmount()
    const c = renderHook(() => useProductFavorite(42))
    expect(c.result.current.favorite).toBe(true)
    act(() => c.result.current.toggle())
    expect(b.result.current.favorite).toBe(false)
    expect(JSON.parse(localStorage.getItem(PRODUCT_FAVORITES_KEY)!)).toEqual([7])
  })
  it('recovers malformed data and listens to another tab', () => {
    localStorage.setItem(PRODUCT_FAVORITES_KEY, '{broken')
    const { result } = renderHook(() => useProductFavorite(42))
    expect(result.current.favorite).toBe(false)
    act(() => {
      localStorage.setItem(PRODUCT_FAVORITES_KEY, '[42]')
      window.dispatchEvent(new StorageEvent('storage', {key: PRODUCT_FAVORITES_KEY}))
    })
    expect(result.current.favorite).toBe(true)
  })
  it('keeps preview favorites out of real storage', () => {
    const {result} = renderHook(() => useProductFavorite(-1, false))
    act(() => result.current.toggle())
    expect(result.current.favorite).toBe(true)
    expect(localStorage.getItem(PRODUCT_FAVORITES_KEY)).toBeNull()
  })
})
