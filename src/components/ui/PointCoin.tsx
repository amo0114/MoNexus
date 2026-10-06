import React, { useId } from 'react'

export interface PointCoinProps {
  className?: string
  size?: number
  variant?: 'gold' | 'silver' | 'purple' | 'current'
}

/**
 * MoNexus Brand Point Coin (MoNexus 平台专属官方品牌代币)
 *
 * 核心徽印升级：采用 MoNexus 官方「账本之结 (Ledger Knot / 枢纽互锁印记)」
 * - 彻底告别单字母 M 的第三方歧义（杜绝麻豆传媒等单一几何 M 联想）
 * - 深度融合 MoNexus 平台「双层交织、互锁合一」的交易账本与核心枢纽图腾
 * - 24x24 视网膜微型网格精修：在 12px ~ 32px 场景下均保证立体咬合关系纤毫毕现
 * - 边缘辅以精密铸币齿槽 (Coin Milling) 与四方防伪节点
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
  const gapId = `mnxCoinGap_${rawId}`

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
        <circle cx="12" cy="12" r="7.6" stroke="currentColor" strokeWidth="0.6" strokeDasharray="1.2 1.2" opacity="0.5" />
        {/* MoNexus 账本之结（单色微矢量） */}
        {/* 后置互锁折板 */}
        <path d="M12.4 7.9 L14.6 9.2 L12.2 10.7 L12.2 14.8 L10.2 16.1 L10.2 11.6 Z" fill="currentColor" />
        {/* 主对角承载梁 */}
        <path d="M6.3 13.7 L8.4 14.9 L17.7 9.7 L15.6 8.5 Z" fill="currentColor" />
        {/* 前置穿插咬合折角 */}
        <path d="M10.2 13.8 L12.2 14.9 L12.2 14.8 L10.2 16.1 Z" fill="currentColor" />
      </svg>
    )
  }

  // 配色方案映射
  let stops = {
    outer: ['#FDE047', '#F59E0B', '#D97706', '#92400E'],
    rim: ['#FEF08A', '#F59E0B', '#78350F'],
    core: ['#FEF3C7', '#FBBF24', '#D97706'],
    glyph: ['#FFFFFF', '#FEF3C7', '#FDE68A'],
    shadow: '#78350F',
    dashStroke: '#92400E',
    gapStroke: '#451A03',
  }

  if (variant === 'silver') {
    stops = {
      outer: ['#F8FAFC', '#E2E8F0', '#94A3B8', '#475569'],
      rim: ['#FFFFFF', '#94A3B8', '#334155'],
      core: ['#F8FAFC', '#CBD5E1', '#64748B'],
      glyph: ['#FFFFFF', '#F8FAFC', '#E2E8F0'],
      shadow: '#1E293B',
      dashStroke: '#475569',
      gapStroke: '#0F172A',
    }
  } else if (variant === 'purple') {
    stops = {
      outer: ['#F5D0FE', '#C084FC', '#9333EA', '#581C87'],
      rim: ['#FAF5FF', '#A855F7', '#4A044E'],
      core: ['#FAF5FF', '#D8B4FE', '#7E22CE'],
      glyph: ['#FFFFFF', '#FAF5FF', '#F3E8FF'],
      shadow: '#3B0764',
      dashStroke: '#581C87',
      gapStroke: '#2E1065',
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

        <linearGradient id={coreId} x1="5" y1="5" x2="19" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={stops.core[0]} />
          <stop offset="45%" stopColor={stops.core[1]} />
          <stop offset="100%" stopColor={stops.core[2]} />
        </linearGradient>

        <linearGradient id={glyphId} x1="6" y1="7" x2="18" y2="17" gradientUnits="userSpaceOnUse">
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
        strokeOpacity="0.35"
        strokeWidth="0.6"
        strokeDasharray="1 1"
      />

      {/* 四方防伪压印微节点 (Cardinal Security Rivets) */}
      <circle cx="12" cy="4.9" r="0.45" fill={stops.dashStroke} opacity="0.6" />
      <circle cx="19.1" cy="12" r="0.45" fill={stops.dashStroke} opacity="0.6" />
      <circle cx="12" cy="19.1" r="0.45" fill={stops.dashStroke} opacity="0.6" />
      <circle cx="4.9" cy="12" r="0.45" fill={stops.dashStroke} opacity="0.6" />

      {/* ── MoNexus 官方「账本之结 (Ledger Knot)」立体互锁图腾 ── */}
      {/* 图腾微投影 (立体浮雕沉降) */}
      <g transform="translate(0, 0.55)" opacity="0.35" fill={stops.shadow}>
        <path d="M12.4 7.9 L14.6 9.2 L12.2 10.7 L12.2 14.8 L10.2 16.1 L10.2 11.6 Z" />
        <path d="M6.3 13.7 L8.4 14.9 L17.7 9.7 L15.6 8.5 Z" />
        <path d="M10.2 13.8 L12.2 14.9 L12.2 14.8 L10.2 16.1 Z" />
      </g>

      {/* 1. 后置互锁折板 (Plane B Rear Hook) */}
      <path
        d="M12.4 7.9 L14.6 9.2 L12.2 10.7 L12.2 14.8 L10.2 16.1 L10.2 11.6 Z"
        fill={`url(#${glyphId})`}
      />

      {/* 2. 主对角承载梁 (Plane A Continuous Diagonal Carrier) */}
      <path
        d="M6.3 13.7 L8.4 14.9 L17.7 9.7 L15.6 8.5 Z"
        fill={`url(#${glyphId})`}
      />

      {/* 3. 前置穿插咬合折角 (Plane B Front Clasp) */}
      <path
        d="M10.2 13.8 L12.2 14.9 L12.2 14.8 L10.2 16.1 Z"
        fill={`url(#${glyphId})`}
      />

      {/* 4. 深度暗隙 (The depth seam cue) */}
      <path
        d="M10.2 12.8 L11.0 13.3 L10.3 13.8 L10.2 13.7 Z"
        fill={stops.gapStroke}
        opacity="0.85"
      />

      {/* 5. 主承载梁金属高光脊线 (Bevel Specular Highlight) */}
      <path
        d="M7.6 14.1 L16.5 9.1"
        stroke="#FFFFFF"
        strokeWidth="0.5"
        strokeLinecap="round"
        opacity="0.8"
      />
      {/* 6. 后置折板高光脊线 */}
      <path
        d="M12.4 8.2 L14.3 9.3"
        stroke="#FFFFFF"
        strokeWidth="0.4"
        strokeLinecap="round"
        opacity="0.7"
      />
    </svg>
  )
}
