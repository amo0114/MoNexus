import React, { useRef, useState, useLayoutEffect, useCallback, useEffect } from 'react'

export interface CategorySlidingNavProps {
  categories: string[]
  activeCategory: string
  onSelectCategory: (category: string) => void
  getCategoryLabel: (category: string) => string
}

export default function CategorySlidingNav({
  categories,
  activeCategory,
  onSelectCategory,
  getCategoryLabel,
}: CategorySlidingNavProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const tabsRef = useRef<Map<string, HTMLButtonElement>>(new Map())
  const [pillGeometry, setPillGeometry] = useState<{
    left: number
    width: number
    ready: boolean
  }>({ left: 0, width: 0, ready: false })

  const [hasRenderedOnce, setHasRenderedOnce] = useState(false)

  const updatePill = useCallback((smoothScroll = false) => {
    const activeElement = tabsRef.current.get(activeCategory)
    const container = containerRef.current
    if (!activeElement || !container) return

    const elLeft = activeElement.offsetLeft
    const elWidth = activeElement.offsetWidth

    setPillGeometry({
      left: elLeft,
      width: elWidth,
      ready: true,
    })

    // 关键：横向滚动居中仅作用于局部横向滚动容器，绝对不能调用 activeElement.scrollIntoView()，
    // 否则会向上穿透触发 window 纵向滚动，导致详情页返回商品列表时列表滚动条被瞬间拉回顶部
    const scrollContainer = scrollContainerRef.current
    if (smoothScroll && scrollContainer && typeof scrollContainer.scrollTo === 'function') {
      const containerRect = scrollContainer.getBoundingClientRect()
      const elRect = activeElement.getBoundingClientRect()
      const targetScrollLeft =
        scrollContainer.scrollLeft +
        (elRect.left - containerRect.left) -
        (containerRect.width / 2) +
        (elRect.width / 2)

      scrollContainer.scrollTo({
        left: targetScrollLeft,
        behavior: 'smooth',
      })
    }
  }, [activeCategory])

  useLayoutEffect(() => {
    updatePill(hasRenderedOnce)
    if (!hasRenderedOnce) {
      // 允许第一帧之后再开启滑动 transition，避免首次渲染时从 0px 飞入
      const timer = setTimeout(() => setHasRenderedOnce(true), 50)
      return () => clearTimeout(timer)
    }
  }, [activeCategory, updatePill, hasRenderedOnce])

  // 监听容器大小变更，重算胶囊尺寸
  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      updatePill(false)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [updatePill])

  function handleKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      const nextIndex = (index + 1) % categories.length
      onSelectCategory(categories[nextIndex])
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      const prevIndex = (index - 1 + categories.length) % categories.length
      onSelectCategory(categories[prevIndex])
    }
  }

  return (
    <div className="w-full flex justify-center py-1">
      {/* 外层横向滚动安全容器，保证小屏分类过多时可平滑横滑，不挤压子项 */}
      <div ref={scrollContainerRef} className="max-w-full overflow-x-auto hide-scrollbar px-1 py-0.5">
        {/* 统一的胶囊导轨跑道（Segmented Control Track），杜绝各自分离边框错位与失衡 */}
        <div
          ref={containerRef}
          aria-label="商品分类筛选"
          className="relative inline-flex items-center p-1 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] shadow-xs select-none"
        >
          {/* 动态平滑滑动的背景胶囊：显式 left-0，上下直接锚定 top-1 bottom-1，垂直水平严丝合缝 */}
          {pillGeometry.ready && (
            <span
              aria-hidden="true"
              className={`absolute top-1 bottom-1 left-0 rounded-full bg-[var(--color-primary)] pointer-events-none z-0 shadow-sm ${
                hasRenderedOnce
                  ? 'transition-[transform,width] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)]'
                  : 'transition-none'
              }`}
              style={{
                transform: `translate3d(${pillGeometry.left}px, 0, 0)`,
                width: `${pillGeometry.width}px`,
              }}
            />
          )}

          {categories.map((cat, index) => {
            const isSelected = activeCategory === cat
            return (
              <button
                key={cat}
                ref={(el) => {
                  if (el) tabsRef.current.set(cat, el)
                  else tabsRef.current.delete(cat)
                }}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelectCategory(cat)}
                onKeyDown={(e) => handleKeyDown(e, index)}
                className={`relative z-10 shrink-0 px-4 sm:px-5 py-1.5 md:py-2 rounded-full text-xs md:text-sm cursor-pointer whitespace-nowrap min-h-[32px] md:min-h-[36px] flex items-center justify-center transition-colors duration-200 focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] border-0 leading-none ${
                  isSelected
                    ? `text-[var(--color-on-primary)] font-semibold ${!pillGeometry.ready ? 'bg-[var(--color-primary)] shadow-sm' : ''}`
                    : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] font-medium'
                }`}
              >
                {getCategoryLabel(cat)}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
