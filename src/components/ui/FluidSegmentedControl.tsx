import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

export interface FluidSegmentOption<T extends string | number = string> {
  key: T
  label: React.ReactNode
  icon?: React.ComponentType<{ className?: string }>
  badge?: React.ReactNode
  badgeCount?: number
  badgeTestId?: string
  disabled?: boolean
  testId?: string
  ariaLabel?: string
}

export interface FluidSegmentedControlProps<T extends string | number = string> {
  options: FluidSegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  /** 尺寸预设：'sm' 紧凑型 | 'md' 标准型 | 'lg' 醒目型 | 'dock' 移动端底栏专属 */
  size?: 'sm' | 'md' | 'lg' | 'dock'
  /** 视觉风格：'glass' 晶莹毛玻璃水滴 | 'filled' 实色经典微阴影 | 'subtle' 极简通透 */
  variant?: 'glass' | 'filled' | 'subtle'
  /** 图标与文字布局：'horizontal' 水平并列(默认) | 'vertical' 垂直上下(适合底栏/大尺寸) */
  iconLayout?: 'horizontal' | 'vertical'
  /** 是否铺满容器宽度（等分每个分段项） */
  fullWidth?: boolean
  /** 选中时是否启用 iOS 17 SF Symbols 原生图标弹跳动效 */
  enableIconJump?: boolean
  /** 额外容器类名 */
  className?: string
  /** 额外选项类名 */
  itemClassName?: string
  /** 辅助功能标签 */
  ariaLabel?: string
  /** 测试标识符 */
  testId?: string
}

export function FluidSegmentedControl<T extends string | number = string>({
  options,
  value,
  onChange,
  size = 'md',
  variant = 'glass',
  iconLayout = 'horizontal',
  fullWidth = false,
  enableIconJump = true,
  className = '',
  itemClassName = '',
  ariaLabel = '分段选项切换',
  testId,
}: FluidSegmentedControlProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Map<T, HTMLButtonElement>>(new Map())

  // 滑块几何坐标（严格与对应项 offsetLeft, offsetTop, offsetWidth, offsetHeight 像素级对齐）
  const [pillGeometry, setPillGeometry] = useState<{
    left: number
    top: number
    width: number
    height: number
    ready: boolean
  }>({ left: 0, top: 0, width: 0, height: 0, ready: false })

  const [hasRenderedOnce, setHasRenderedOnce] = useState(false)

  // 按压下陷
  const [isPressed, setIsPressed] = useState(false)

  // 果冻拉伸与形变（Squash & Stretch 水滴拉伸算法）
  const [isFlowing, setIsFlowing] = useState(false)
  const [isLanding, setIsLanding] = useState(false)
  const [isPopping, setIsPopping] = useState(false)
  const [flowDistance, setFlowDistance] = useState<number>(1)
  const [slideDuration, setSlideDuration] = useState<number>(240)

  const currentIndex = options.findIndex((opt) => opt.key === value)
  const prevIndexRef = useRef<number>(-1)
  const landingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const popTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 测量并更新滑块目标尺寸与位移
  const updatePill = useCallback(() => {
    const activeEl = itemRefs.current.get(value)
    if (!activeEl) return

    setPillGeometry({
      left: activeEl.offsetLeft,
      top: activeEl.offsetTop,
      width: activeEl.offsetWidth,
      height: activeEl.offsetHeight,
      ready: true,
    })
  }, [value])

  // 处理项点击
  const handleItemClick = (option: FluidSegmentOption<T>) => {
    if (option.disabled) return

    if (option.key === value) {
      // 原地再次点击：触发果冻微弹（Droplet Pop）
      if (popTimerRef.current) clearTimeout(popTimerRef.current)
      setIsPopping(true)
      popTimerRef.current = setTimeout(() => setIsPopping(false), 400)
      return
    }

    onChange(option.key)
  }

  // 跨项切换触发拉伸形变与落地果冻回弹算法
  useLayoutEffect(() => {
    updatePill()

    if (!hasRenderedOnce) {
      prevIndexRef.current = currentIndex
      const timer = setTimeout(() => setHasRenderedOnce(true), 60)
      return () => clearTimeout(timer)
    }

    if (prevIndexRef.current !== -1 && prevIndexRef.current !== currentIndex && currentIndex !== -1) {
      const distance = Math.abs(currentIndex - prevIndexRef.current)
      // 优化为轻快敏捷的 200ms ~ 260ms，告别拖泥带水
      const travelTime = Math.min(260, 200 + distance * 25)

      setFlowDistance(distance)
      setSlideDuration(travelTime)
      setIsFlowing(true)
      setIsLanding(false)

      // 滑动到位瞬间触发落地微果冻回弹震颤
      if (landingTimerRef.current) clearTimeout(landingTimerRef.current)
      landingTimerRef.current = setTimeout(() => {
        setIsFlowing(false)
        setIsLanding(true)
        landingTimerRef.current = setTimeout(() => {
          setIsLanding(false)
        }, 220)
      }, travelTime - 15)

      prevIndexRef.current = currentIndex
    } else {
      prevIndexRef.current = currentIndex
    }
  }, [updatePill, hasRenderedOnce, currentIndex])

  // 监听容器尺寸变化（适配窗口缩放或动态内容）
  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => updatePill())
    observer.observe(container)
    return () => observer.disconnect()
  }, [updatePill])

  // 尺寸样式映射
  const sizeStyles = {
    sm: {
      container: 'p-0.5 text-xs',
      button: iconLayout === 'vertical' ? 'py-1 px-2' : 'py-1 px-2.5',
      icon: 'w-3.5 h-3.5',
      text: 'text-[11.5px]',
      gap: iconLayout === 'vertical' ? 'gap-0.5' : 'gap-1.5',
    },
    md: {
      container: 'p-1 text-sm',
      button: iconLayout === 'vertical' ? 'py-1.5 px-3' : 'py-1.5 px-3.5',
      icon: 'w-4 h-4',
      text: 'text-[13px]',
      gap: iconLayout === 'vertical' ? 'gap-1' : 'gap-2',
    },
    lg: {
      container: 'p-1 text-sm',
      button: iconLayout === 'vertical' ? 'py-2 px-4' : 'py-2 px-4',
      icon: 'w-5 h-5',
      text: 'text-[14px]',
      gap: iconLayout === 'vertical' ? 'gap-1' : 'gap-2.5',
    },
    dock: {
      container: 'p-1 shadow-lg',
      button: 'py-1.5 px-2.5 min-w-[64px]',
      icon: 'w-[22px] h-[22px]',
      text: 'text-[10.5px] mt-0.5',
      gap: 'gap-0',
    },
  }[size]

  // 风格样式映射
  const variantStyles = {
    glass: {
      container: 'floating-pill-dock',
      indicator: 'liquid-droplet-inner',
      textActive: 'text-[var(--color-primary)] font-bold',
      textInactive: 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
    },
    filled: {
      container:
        'bg-slate-100/90 dark:bg-slate-800/80 border border-slate-200/70 dark:border-slate-700/60 shadow-xs',
      indicator:
        'bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-700/80 shadow-xs',
      textActive: 'text-[var(--color-primary)] font-bold',
      textInactive: 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
    },
    subtle: {
      container: 'bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10',
      indicator: 'bg-white dark:bg-slate-800/90 shadow-xs border border-black/5 dark:border-white/10',
      textActive: 'text-[var(--color-primary)] font-bold',
      textInactive: 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
    },
  }[variant]

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label={ariaLabel}
      data-testid={testId}
      className={`relative select-none rounded-full flex items-center overflow-hidden transition-transform duration-200 will-change-transform ${
        fullWidth ? 'w-full flex' : 'inline-flex'
      } ${sizeStyles.container} ${variantStyles.container} ${
        isPressed ? 'is-dock-pressed' : ''
      } ${className}`}
    >
      {/* 物理流体水滴滑块：Snappy 弹性平移 + 微幅流体拉伸 + 严格轨道内无溢出回弹 */}
      {pillGeometry.ready && (
        <span
          aria-hidden="true"
          className={`absolute left-0 top-0 rounded-full pointer-events-none z-0 liquid-droplet-indicator ${
            hasRenderedOnce
              ? 'transition-[transform,width,height] ease-[cubic-bezier(0.25,1,0.5,1)]'
              : 'transition-none'
          }`}
          style={{
            transform: `translate3d(${pillGeometry.left}px, ${pillGeometry.top}px, 0)`,
            width: `${pillGeometry.width}px`,
            height: `${pillGeometry.height}px`,
            transitionDuration: hasRenderedOnce ? `${slideDuration}ms` : '0ms',
          }}
        >
          <span
            className={`absolute inset-0 rounded-full ${variantStyles.indicator} transition-transform ${
              isFlowing
                ? flowDistance >= 2
                  ? 'scale-x-[1.07] scale-y-[0.96] origin-center ease-out'
                  : 'scale-x-[1.04] scale-y-[0.98] origin-center ease-out'
                : isLanding
                ? 'animate-jelly-landing'
                : isPopping
                ? 'animate-droplet-pop'
                : 'scale-100 origin-center duration-200 ease-out'
            }`}
            style={{
              transitionDuration: isFlowing ? `${slideDuration}ms` : undefined,
              ...(isLanding
                ? {
                    ['--land-from-x' as string]: flowDistance >= 2 ? '1.07' : '1.04',
                    ['--land-from-y' as string]: flowDistance >= 2 ? '0.96' : '0.98',
                  }
                : {}),
            }}
          />
        </span>
      )}

      {/* 选项按钮列表 */}
      {options.map((opt) => {
        const active = opt.key === value
        const Icon = opt.icon

        return (
          <button
            key={String(opt.key)}
            ref={(el) => {
              if (el) itemRefs.current.set(opt.key, el)
              else itemRefs.current.delete(opt.key)
            }}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={opt.ariaLabel || (typeof opt.label === 'string' ? opt.label : undefined)}
            disabled={opt.disabled}
            data-testid={opt.testId}
            onPointerDown={() => !opt.disabled && setIsPressed(true)}
            onPointerUp={() => setIsPressed(false)}
            onPointerCancel={() => setIsPressed(false)}
            onClick={() => handleItemClick(opt)}
            className={`relative z-10 rounded-full cursor-pointer select-none active:scale-[0.90] active:translate-y-[1px] transition-transform duration-120 ease-out focus-visible:outline-none flex items-center justify-center text-center ${
              fullWidth ? 'flex-1' : 'shrink-0'
            } ${iconLayout === 'vertical' ? 'flex-col' : 'flex-row'} ${sizeStyles.button} ${
              sizeStyles.gap
            } ${active ? variantStyles.textActive : variantStyles.textInactive} ${
              opt.disabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : ''
            } ${itemClassName}`}
          >
            {Icon ? (
              <span className="relative flex items-center justify-center">
                <Icon
                  key={active ? `${String(opt.key)}-active` : `${String(opt.key)}-inactive`}
                  className={`${sizeStyles.icon} ${
                    active && enableIconJump ? 'animate-symbol-jump' : ''
                  }`}
                />
                {opt.badgeCount != null && opt.badgeCount > 0 && (
                  <span
                    aria-hidden="true"
                    data-testid={opt.badgeTestId}
                    className="absolute -top-1 -right-2 min-w-3.5 h-3.5 px-0.5 rounded-full bg-[var(--color-danger)] text-[9px] leading-3.5 font-bold text-white text-center ring-2 ring-white dark:ring-slate-900 shadow-xs"
                  >
                    {opt.badgeCount > 99 ? '99+' : opt.badgeCount}
                  </span>
                )}
              </span>
            ) : null}

            <span className="relative inline-flex items-center justify-center text-center">
              <span className={`tracking-tight leading-tight text-center ${sizeStyles.text}`}>
                {opt.label}
              </span>
              {!Icon && opt.badgeCount != null && opt.badgeCount > 0 && (
                <span
                  aria-hidden="true"
                  data-testid={opt.badgeTestId}
                  className="ml-1.5 min-w-3.5 h-3.5 px-1 rounded-full bg-[var(--color-danger)] text-[9.5px] leading-3.5 font-bold text-white text-center shadow-xs"
                >
                  {opt.badgeCount > 99 ? '99+' : opt.badgeCount}
                </span>
              )}
            </span>

            {opt.badge && <span className="ml-1">{opt.badge}</span>}
          </button>
        )
      })}
    </div>
  )
}
