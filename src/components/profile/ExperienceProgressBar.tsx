import React from 'react'
import type { TierResponse } from '../../api/points'

export interface ExperienceProgressBarProps {
  tierData: TierResponse | null
  variant?: 'compact' | 'detailed'
  className?: string
  nextTierLabelOverride?: string | null
}

export function ExperienceProgressBar({
  tierData,
  variant = 'compact',
  className = '',
  nextTierLabelOverride,
}: ExperienceProgressBarProps) {
  if (!tierData) return null

  const { tier, lifetimeEarnedPoints, thresholds, nextTier, pointsToNextTier } = tierData

  // 计算当前段起点阈值
  let currentThresh = 0
  if (tier === 'silver') currentThresh = thresholds.silver
  else if (tier === 'gold') currentThresh = thresholds.gold
  else if (tier === 'platinum') currentThresh = thresholds.platinum

  // 计算下一段目标阈值
  let nextThresh: number | null = null
  if (nextTier === 'silver') nextThresh = thresholds.silver
  else if (nextTier === 'gold') nextThresh = thresholds.gold
  else if (nextTier === 'platinum') nextThresh = thresholds.platinum

  // 计算百分比 (0 - 100)
  let progress = 100
  if (nextTier && nextThresh !== null) {
    const span = nextThresh - currentThresh
    if (span > 0) {
      progress = Math.max(0, Math.min(100, ((lifetimeEarnedPoints - currentThresh) / span) * 100))
    } else {
      progress = 0
    }
  }

  const roundedPct = Math.round(progress)
  const isMaxTier = !nextTier || nextThresh === null

  let progressGradient = 'bg-gradient-to-r from-stone-500 to-stone-400 dark:from-stone-400 dark:to-stone-300'
  let accentText = 'text-[var(--color-primary)]'
  let highlightNumber = 'text-[var(--color-text)]'
  let trackClasses = 'bg-[var(--tc-track-bg,rgba(120,120,120,0.16))] border-[var(--tc-inset-border,var(--color-border))]'

  if (tier === 'platinum') {
    progressGradient = 'bg-gradient-to-r from-[#1f6456] via-[#378875] to-[#6eb2a0]'
    accentText = 'text-[#206354] dark:text-[#8dd0be]'
    highlightNumber = 'text-[#1c5c4e] dark:text-[#8dd0be]'
  } else if (tier === 'gold') {
    progressGradient = 'bg-gradient-to-r from-[#8e6c2e] via-[#b8934a] to-[#cfa962]'
    accentText = 'text-[#8c6a2b] dark:text-[#d4b26f]'
    highlightNumber = 'text-[#846123] dark:text-[#dfc083]'
  } else if (tier === 'silver') {
    progressGradient = 'bg-gradient-to-r from-[#5c819b] via-[#769cb6] to-[#98bad0]'
    accentText = 'text-[#3e637d] dark:text-[#96bdd9]'
    highlightNumber = 'text-[#3a5d75] dark:text-[#9fc3db]'
  }

  const nextTierLabel = nextTierLabelOverride || tierData.nextTierLabel || ''

  if (variant === 'detailed') {
    return (
      <div className={`w-full ${className}`}>
        {/* 顶部文字说明 */}
        <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)] mb-2 font-medium">
          <span>{isMaxTier ? '会员等级已达上限' : `升级至 ${nextTierLabel}`}</span>
          <span>
            {isMaxTier ? (
              <span className={`${accentText} font-semibold`}>已达最高阶</span>
            ) : (
              <>
                还差 <strong className={`${highlightNumber} font-semibold`}>{pointsToNextTier?.toLocaleString()}</strong> 积分
                <span className={`text-[11px] font-bold ${accentText} ml-1`}>({roundedPct}%)</span>
              </>
            )}
          </span>
        </div>

        {/* 进度轨容器 */}
        <div
          role="progressbar"
          aria-valuenow={lifetimeEarnedPoints}
          aria-valuemin={currentThresh}
          aria-valuemax={nextThresh ?? lifetimeEarnedPoints}
          aria-valuetext={`${roundedPct}% 成长进度`}
          className={`relative w-full rounded-full h-2 overflow-hidden border ${trackClasses}`}
        >
          <div
            className={`relative h-full rounded-full transition-[width] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] ${progressGradient}`}
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* 阶梯数值刻度 */}
        {!isMaxTier && (
          <div className="flex items-center justify-between text-[10px] text-[var(--color-text-muted)] mt-1.5 px-0.5 opacity-80">
            <span>当前起点: {currentThresh.toLocaleString()}</span>
            <span>下一目标: {nextThresh?.toLocaleString()}</span>
          </div>
        )}
      </div>
    )
  }

  // 默认 compact 模式 (适用于顶部用户卡片)
  return (
    <div className={`w-full ${className}`}>
      {/* 顶部文字说明与比率 */}
      <div className="flex items-center justify-between text-[11px] text-[var(--tc-muted,var(--color-text-muted))] mb-1.5 font-medium">
        <div className="flex items-center gap-1">
          <span>经验值:</span>
          <span className="font-semibold text-[var(--tc-text,var(--color-text))] tracking-tight tabular-nums">
            {lifetimeEarnedPoints.toLocaleString()}
            {nextThresh ? <span className="text-[var(--tc-muted,var(--color-text-muted))] font-normal"> / {nextThresh.toLocaleString()}</span> : ''}
          </span>
        </div>
        <div className="flex items-center gap-1 tabular-nums">
          {isMaxTier ? (
            <span className={`${accentText} font-semibold`}>已满级</span>
          ) : (
            <span>
              距下一级差 <strong className={`${highlightNumber} font-semibold`}>{pointsToNextTier?.toLocaleString()}</strong>
            </span>
          )}
          <span className={`text-[10px] font-bold ${accentText}`}>({roundedPct}%)</span>
        </div>
      </div>

      {/* 进度轨容器 */}
      <div
        role="progressbar"
        aria-valuenow={lifetimeEarnedPoints}
        aria-valuemin={currentThresh}
        aria-valuemax={nextThresh ?? lifetimeEarnedPoints}
        aria-valuetext={`${roundedPct}% 成长进度`}
        className={`relative w-full rounded-full h-1.5 overflow-hidden border ${trackClasses}`}
      >
        <div
          className={`relative h-full rounded-full transition-[width] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] ${progressGradient}`}
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  )
}
