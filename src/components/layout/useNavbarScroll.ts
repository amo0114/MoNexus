import { useEffect, useRef, useState } from 'react'

export function useNavbarScroll(isMobileViewport: boolean) {
  // 顶部滚动感知（全视口）：下滑 >36px 触发收敛态（Anthropic 风格收敛为 M · X），
  // 回顶 <16px 恢复展开态（滞回防抖）。
  const [isScrolled, setIsScrolled] = useState(false)
  const isScrolledRef = useRef(false)

  // 灵动岛药丸（V3-T3，仅移动视口）：离开顶部 >48px 收缩为居中悬浮
  // 胶囊，回顶 <32px 恢复全宽（滞回防抖）。桌面恒 false，零影响。
  const [navCompact, setNavCompact] = useState(false)
  const navCompactRef = useRef(false)
  useEffect(() => {
    let ticking = false
    const onScroll = () => {
      if (ticking) return
      ticking = true
      window.requestAnimationFrame(() => {
        const y = window.scrollY
        // 1. 全局品牌收敛感知 (y > 36 收敛为 M · X, y < 16 恢复)
        const nextScrolled = y > 36 ? true : y < 16 ? false : isScrolledRef.current
        if (nextScrolled !== isScrolledRef.current) {
          isScrolledRef.current = nextScrolled
          setIsScrolled(nextScrolled)
        }

        // 2. 移动端灵动岛胶囊感知
        if (isMobileViewport) {
          const nextCompact = y > 48 ? true : y < 32 ? false : navCompactRef.current
          if (nextCompact !== navCompactRef.current) {
            navCompactRef.current = nextCompact
            setNavCompact(nextCompact)
          }
        }
        ticking = false
      })
    }
    if (!isMobileViewport) {
      navCompactRef.current = false
      setNavCompact(false)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [isMobileViewport])

  return { isScrolled, navCompact }
}
