import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import CategorySlidingNav from './CategorySlidingNav'

describe('CategorySlidingNav', () => {
  const categories = ['全部', 'accounts', 'cards', 'tutorials']
  const getLabel = (cat: string) => {
    switch (cat) {
      case '全部': return '全部'
      case 'accounts': return '账号'
      case 'cards': return '卡密'
      case 'tutorials': return '教程'
      default: return cat
    }
  }

  it('renders all categories with proper accessible button roles and states', () => {
    const onSelect = vi.fn()
    render(
      <CategorySlidingNav
        categories={categories}
        activeCategory="全部"
        onSelectCategory={onSelect}
        getCategoryLabel={getLabel}
      />
    )

    const activeBtn = screen.getByRole('button', { name: '全部' })
    expect(activeBtn).toHaveAttribute('aria-pressed', 'true')

    const inactiveBtn = screen.getByRole('button', { name: '卡密' })
    expect(inactiveBtn).toHaveAttribute('aria-pressed', 'false')
  })

  it('triggers onSelectCategory when a category button is clicked', () => {
    const onSelect = vi.fn()
    render(
      <CategorySlidingNav
        categories={categories}
        activeCategory="全部"
        onSelectCategory={onSelect}
        getCategoryLabel={getLabel}
      />
    )

    const cardsBtn = screen.getByRole('button', { name: '卡密' })
    fireEvent.click(cardsBtn)
    expect(onSelect).toHaveBeenCalledWith('cards')
  })

  it('supports keyboard ArrowRight / ArrowLeft navigation', () => {
    const onSelect = vi.fn()
    render(
      <CategorySlidingNav
        categories={categories}
        activeCategory="accounts"
        onSelectCategory={onSelect}
        getCategoryLabel={getLabel}
      />
    )

    const accountsBtn = screen.getByRole('button', { name: '账号' })
    fireEvent.keyDown(accountsBtn, { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenCalledWith('cards')

    fireEvent.keyDown(accountsBtn, { key: 'ArrowLeft' })
    expect(onSelect).toHaveBeenCalledWith('全部')
  })
})
