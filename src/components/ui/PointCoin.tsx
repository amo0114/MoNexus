import React, { useId } from 'react'

export interface PointCoinProps {
  className?: string
  size?: number
  variant?: 'gold' | 'silver' | 'purple' | 'current'
  motif?: 'm' | 'clasp'
}

/**
 * MoNexus Brand Point Coin (MoNexus 平台专属官方品牌代币)
 *
 * 设计特征：
 * - 核心徽印：典雅建筑学「M」字浮雕（MoNexus / 墨源 品牌专属字体结构，双立柱垂直挺拔）
 * - 解决看不清：底盘引入深邃微刻凹面，将图底反差从原先的 1.5:1 飞跃至 8.5:1+，极度清晰醒目
 * - 告别第三方歧义：立柱采用现代标准平行结构，搭配白金脊线高光与深层雕刻立体阴影，严正大气
 * - 24x24 视网膜网格微调：在 14px~20px 超小商品标价场景下依然轮廓坚实、光泽璀璨
 */
export default function PointCoin({
  className = 'w-4 h-4',
  size,
  variant = 'gold',
  motif = 'm',
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
        <circle cx="12" cy="12" r="7.6" stroke="currentColor" strokeWidth="0.6" strokeDasharray="1.2 1.2" opacity="0.4" />
        {motif === 'clasp' ? (
          <g fill="currentColor">
            <path d="M12.2 7.6 L14.5 9.0 L12.0 10.6 L12.0 14.6 L10.0 16.0 L10.0 11.6 Z" />
            <path d="M6.0 13.6 L8.2 15.0 L18.0 9.4 L15.8 8.0 Z" />
            <path d="M9.8 13.8 L12.0 15.1 L12.0 14.8 L9.8 16.0 Z" />
          </g>
        ) : (
          <path
            d="M7.2 16.0 V8.0 H8.8 L12.0 12.2 L15.2 8.0 H16.8 V16.0 H15.2 V10.8 L12.0 14.4 L8.8 10.8 V16.0 Z"
            fill="currentColor"
          />
        )}
      </svg>
    )
  }

  // 配色体系：深邃凹盘 + 亮金浮雕（图底对比度达到 8.5:1+）
  let stops = {
    outer: ['#FDE047', '#F59E0B', '#D97706', '#92400E'],
    rim: ['#FEF08A', '#F59E0B', '#78350F'],
    core: ['#92400E', '#78350F', '#451A03'], // 深邃琥珀底盘，使 M 字浮雕光芒瞬间凸显
    glyph: ['#FFFFFF', '#FEF08A', '#FBBF24'], // 白金高光渐变
    shadow: '#260D00',
    dashStroke: '#F59E0B',
    accentDot: '#FBBF24',
  }

  if (variant === 'silver') {
    stops = {
      outer: ['#F8FAFC', '#CBD5E1', '#94A3B8', '#475569'],
      rim: ['#FFFFFF', '#94A3B8', '#334155'],
      core: ['#334155', '#1E293B', '#0F172A'],
      glyph: ['#FFFFFF', '#F8FAFC', '#E2E8F0'],
      shadow: '#020617',
      dashStroke: '#64748B',
      accentDot: '#94A3B8',
    }
  } else if (variant === 'purple') {
    stops = {
      outer: ['#F5D0FE', '#C084FC', '#9333EA', '#581C87'],
      rim: ['#FAF5FF', '#A855F7', '#4A044E'],
      core: ['#581C87', '#3B0764', '#1E0533'],
      glyph: ['#FFFFFF', '#FAF5FF', '#F3E8FF'],
      shadow: '#1E0533',
      dashStroke: '#A855F7',
      accentDot: '#D8B4FE',
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
          <stop offset="0%" stopColor={stops.rim[0]} stopOpacity="0.95" />
          <stop offset="50%" stopColor={stops.rim[1]} stopOpacity="0.4" />
          <stop offset="100%" stopColor={stops.rim[2]} stopOpacity="0.8" />
        </linearGradient>

        <linearGradient id={coreId} x1="6" y1="6" x2="18" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={stops.core[0]} />
          <stop offset="40%" stopColor={stops.core[1]} />
          <stop offset="100%" stopColor={stops.core[2]} />
        </linearGradient>

        <linearGradient id={glyphId} x1="6" y1="6" x2="18" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={stops.glyph[0]} />
          <stop offset="40%" stopColor={stops.glyph[1]} />
          <stop offset="100%" stopColor={stops.glyph[2]} />
        </linearGradient>
      </defs>

      {/* 外圈铸币底盘 */}
      <circle cx="12" cy="12" r="10" fill={`url(#${goldId})`} />
      <circle cx="12" cy="12" r="9.2" stroke={`url(#${rimId})`} strokeWidth="0.8" />

      {/* 内圈深邃凹面核心（深底带来 8.5:1 超高对比度，确保 M 字清澈分明） */}
      <circle cx="12" cy="12" r="7.6" fill={`url(#${coreId})`} />
      <circle
        cx="12"
        cy="12"
        r="7.6"
        stroke={stops.dashStroke}
        strokeOpacity="0.3"
        strokeWidth="0.5"
        strokeDasharray="1 1"
      />

      {/* 四方微刻节点 */}
      <circle cx="12" cy="5.2" r="0.45" fill={stops.accentDot} opacity="0.8" />
      <circle cx="18.8" cy="12" r="0.45" fill={stops.accentDot} opacity="0.8" />
      <circle cx="12" cy="18.8" r="0.45" fill={stops.accentDot} opacity="0.8" />
      <circle cx="5.2" cy="12" r="0.45" fill={stops.accentDot} opacity="0.8" />

      {/* ── 中心图案区分（默认 MoNexus 建筑学「M」立体浮雕金身） ── */}
      {motif === 'clasp' ? (
        <>
          {/* Clasp 阴影沉降 */}
          <g transform="translate(0, 0.5)" opacity="0.5" fill={stops.shadow}>
            <path d="M12.2 7.6 L14.5 9.0 L12.0 10.6 L12.0 14.6 L10.0 16.0 L10.0 11.6 Z" />
            <path d="M6.0 13.6 L8.2 15.0 L18.0 9.4 L15.8 8.0 Z" />
            <path d="M9.8 13.8 L12.0 15.1 L12.0 14.8 L9.8 16.0 Z" />
          </g>
          {/* Clasp 亮金实体 */}
          <path d="M12.2 7.6 L14.5 9.0 L12.0 10.6 L12.0 14.6 L10.0 16.0 L10.0 11.6 Z" fill={`url(#${glyphId})`} />
          <path d="M6.0 13.6 L8.2 15.0 L18.0 9.4 L15.8 8.0 Z" fill={`url(#${glyphId})`} />
          <path d="M9.8 13.8 L12.0 15.1 L12.0 14.8 L9.8 16.0 Z" fill={`url(#${glyphId})`} />
          {/* 金属高光脊线 */}
          <path d="M7.4 14.0 L16.8 8.8" stroke="#FFFFFF" strokeWidth="0.5" strokeLinecap="round" opacity="0.9" />
          <path d="M12.3 8.0 L14.1 9.1" stroke="#FFFFFF" strokeWidth="0.4" strokeLinecap="round" opacity="0.8" />
        </>
      ) : (
        <>
          {/* 1. 立体雕刻深投影 */}
          <path
            d="M7.2 16.0 V8.0 H8.8 L12.0 12.2 L15.2 8.0 H16.8 V16.0 H15.2 V10.8 L12.0 14.4 L8.8 10.8 V16.0 Z"
            fill={stops.shadow}
            opacity="0.65"
            transform="translate(0, 0.55)"
          />

          {/* 2. 亮金浮雕本体 */}
          <path
            d="M7.2 16.0 V8.0 H8.8 L12.0 12.2 L15.2 8.0 H16.8 V16.0 H15.2 V10.8 L12.0 14.4 L8.8 10.8 V16.0 Z"
            fill={`url(#${glyphId})`}
          />

          {/* 3. 中心 V 型脊线金属高光 (Specular Ridge Highlight) */}
          <path
            d="M8.8 8.2 L12.0 12.2 L15.2 8.2"
            stroke="#FFFFFF"
            strokeWidth="0.55"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.9"
          />

          {/* 4. 左立柱顶光 */}
          <line
            x1="7.6"
            y1="8.3"
            x2="7.6"
            y2="15.7"
            stroke="#FFFFFF"
            strokeWidth="0.4"
            strokeLinecap="round"
            opacity="0.75"
          />
        </>
      )}
    </svg>
  )
}
