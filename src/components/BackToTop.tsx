import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp } from 'lucide-react'
import { useAppStore } from '../stores/appStore'

interface BackToTopProps {
  /** 滚动距离超过该阈值时显示，默认 250px */
  threshold?: number
  /** 自定义底部安全边距偏移 */
  bottomOffset?: string
}

export default function BackToTop({ threshold = 250, bottomOffset }: BackToTopProps) {
  const [visible, setVisible] = useState(false)
  const tabbarHidden = useAppStore((s) => s.tabbarHidden)

  const handleScroll = useCallback(() => {
    const scrollY =
      (typeof window !== 'undefined' ? (window.scrollY || window.pageYOffset) : 0) ||
      document.documentElement?.scrollTop ||
      document.body?.scrollTop ||
      0
    setVisible(scrollY > threshold)
  }, [threshold])

  useEffect(() => {
    handleScroll()
    window.addEventListener('scroll', handleScroll, { passive: true })
    document.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', handleScroll)
      document.removeEventListener('scroll', handleScroll)
    }
  }, [handleScroll])

  const scrollToTop = () => {
    window.scrollTo({
      top: 0,
      behavior: 'smooth',
    })
  }

  // 移动端避让底栏及 iPhone 安全区，同时保证桌面端正常间距
  const bottomStyle = bottomOffset
    ? bottomOffset
    : tabbarHidden
      ? 'calc(var(--safe-bottom, 0px) + 1.25rem)'
      : 'calc(var(--tabbar-h, 56px) + var(--safe-bottom, 0px) + 1.25rem)'

  if (typeof document === 'undefined') return null

  // 关键：使用 React Portal 挂载到 document.body，彻底避免父容器带有 CSS 动画（如 fade-in 的 transform: translateY）
  // 导致 position: fixed 退化为其局部的包含块（containing block）而沉底至千像素之外的问题
  return createPortal(
    <button
      type="button"
      onClick={scrollToTop}
      aria-label="回到顶部"
      title="回到顶部"
      data-testid="back-to-top-button"
      style={{
        bottom: bottomStyle,
      }}
      className={`fixed z-50 flex items-center justify-center rounded-full cursor-pointer
        w-11 h-11 md:w-12 md:h-12 right-4 md:right-8
        bg-[var(--color-surface)] border-2 border-[var(--color-border)]
        shadow-xl hover:border-[var(--color-primary)] hover:shadow-2xl
        text-[var(--color-text)] hover:text-[var(--color-primary)]
        active:scale-95 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]
        ${
          visible
            ? 'opacity-100 translate-y-0 pointer-events-auto scale-100 visible'
            : 'opacity-0 translate-y-6 pointer-events-none scale-75 invisible'
        }
      `}
    >
      <ArrowUp className="w-5 h-5 stroke-[2.5]" />
    </button>,
    document.body
  )
}
