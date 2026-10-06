import React, { useId } from 'react'

export interface PointCoinProps {
  className?: string
  size?: number
  variant?: 'gold' | 'silver' | 'purple' | 'current'
}

/**
 * MoNexus Brand Point Coin (方案一：平台专属品牌代币)
 *
 * 专为小尺寸 (12px ~ 24px) 视网膜渲染微调：
 * - 正圆双环铸币边缘（告别双圈层叠手铐/无限符号视觉困扰）
 * - 中心内嵌 MoNexus 建筑学「M」图腾徽印
 * - 支持 金色 (默认) / 银色 / 紫金 / currentColor 单色模式
 */
export default function PointCoin({
  className = 'w-4 h-4',
  size,
  variant = 'gold',
}: PointCoinProps) {
  const rawId = useId().replace(/:/g, '')
  const goldId = `mnxCoinGold_${rawId}`
  const rimId = `mnxCoinRim_${rawId}`
  const coreId = `mnxCoinCore_${rawId}`
  const glyphId = `mnxCoinGlyph_${rawId}`

  const sizeStyle = size ? { width: size, height: size } : undefined

  if (variant === 'current') {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={`inline-block shrink-0 align-middle ${className}`}
        style={sizeStyle}
        aria-hidden="true"
        data-testid="point-coin-current"
      >
        <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="0.75" strokeDasharray="1.2 1.2" opacity="0.6" />
        <path
          d="M7 15.5 L7.8 8.5 L9.6 8.5 L12 11.8 L14.4 8.5 L16.2 8.5 L17 15.5 L15.2 15.5 L14.6 10.8 L12 14.2 L9.4 10.8 L8.8 15.5 Z"
          fill="currentColor"
        />
      </svg>
    )
  }

  // 配色方案映射
  let stops = {
    outer: ['#FDE047', '#F59E0B', '#D97706', '#B45309'],
    rim: ['#FEF08A', '#F59E0B', '#78350F'],
    core: ['#FEF3C7', '#FBBF24', '#D97706'],
    glyph: ['#FFFFFF', '#FFFBEB', '#FDE68A'],
    shadow: '#78350F',
    dashStroke: '#92400E',
  }

  if (variant === 'silver') {
    stops = {
      outer: ['#F1F5F9', '#CBD5E1', '#94A3B8', '#64748B'],
      rim: ['#FFFFFF', '#94A3B8', '#334155'],
      core: ['#F8FAFC', '#E2E8F0', '#94A3B8'],
      glyph: ['#FFFFFF', '#F8FAFC', '#E2E8F0'],
      shadow: '#334155',
      dashStroke: '#475569',
    }
  } else if (variant === 'purple') {
    stops = {
      outer: ['#E879F9', '#C084FC', '#9333EA', '#6B21A8'],
      rim: ['#F5D0FE', '#A855F7', '#581C87'],
      core: ['#FAF5FF', '#D8B4FE', '#9333EA'],
      glyph: ['#FFFFFF', '#FAF5FF', '#F3E8FF'],
      shadow: '#4A044E',
      dashStroke: '#581C87',
    }
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`inline-block shrink-0 align-middle ${className}`}
      style={sizeStyle}
      aria-hidden="true"
      data-testid={`point-coin-${variant}`}
    >
      <defs>
        <linearGradient id={goldId} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={stops.outer[0]} />
          <stop offset="35%" stopColor={stops.outer[1]} />
          <stop offset="70%" stopColor={stops.outer[2]} />
          <stop offset="100%" stopColor={stops.outer[3]} />
        </linearGradient>

        <linearGradient id={rimId} x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={stops.rim[0]} stopOpacity="0.9" />
          <stop offset="50%" stopColor={stops.rim[1]} stopOpacity="0.4" />
          <stop offset="100%" stopColor={stops.rim[2]} stopOpacity="0.7" />
        </linearGradient>

        <linearGradient id={coreId} x1="5" y1="5" x2="19" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={stops.core[0]} />
          <stop offset="50%" stopColor={stops.core[1]} />
          <stop offset="100%" stopColor={stops.core[2]} />
        </linearGradient>

        <linearGradient id={glyphId} x1="7" y1="7" x2="17" y2="17" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={stops.glyph[0]} />
          <stop offset="40%" stopColor={stops.glyph[1]} />
          <stop offset="100%" stopColor={stops.glyph[2]} />
        </linearGradient>
      </defs>

      {/* 外圈铸币底盘 */}
      <circle cx="12" cy="12" r="10" fill={`url(#${goldId})`} />
      <circle cx="12" cy="12" r="9.2" stroke={`url(#${rimId})`} strokeWidth="0.8" />

      {/* 内圈压印核心区 */}
      <circle cx="12" cy="12" r="7.8" fill={`url(#${coreId})`} />
      <circle
        cx="12"
        cy="12"
        r="7.8"
        stroke={stops.dashStroke}
        strokeOpacity="0.3"
        strokeWidth="0.6"
        strokeDasharray="1 1"
      />

      {/* MoNexus M 图腾微阴影 */}
      <path
        d="M7 15.5 L7.8 8.5 L9.6 8.5 L12 11.8 L14.4 8.5 L16.2 8.5 L17 15.5 L15.2 15.5 L14.6 10.8 L12 14.2 L9.4 10.8 L8.8 15.5 Z"
        fill={stops.shadow}
        opacity="0.35"
        transform="translate(0, 0.6)"
      />

      {/* MoNexus M 图腾金身 */}
      <path
        d="M7 15.5 L7.8 8.5 L9.6 8.5 L12 11.8 L14.4 8.5 L16.2 8.5 L17 15.5 L15.2 15.5 L14.6 10.8 L12 14.2 L9.4 10.8 L8.8 15.5 Z"
        fill={`url(#${glyphId})`}
      />
      <path
        d="M9.6 8.5 L12 11.8 L14.4 8.5"
        stroke="#FFFFFF"
        strokeWidth="0.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.75"
      />
    </svg>
  )
}
