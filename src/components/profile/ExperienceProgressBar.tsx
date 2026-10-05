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

  const nextTierLabel =
    nextTierLabelOverride ||
    (nextTier === 'silver' ? '白银会员' : nextTier === 'gold' ? '黄金会员' : nextTier === 'platinum' ? '铂金会员' : nextTier || '')

  if (variant === 'detailed') {
    return (
      <div className={`w-full ${className}`}>
        {/* 顶部文字说明 */}
        <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)] mb-2 font-medium">
          <span>{isMaxTier ? '会员等级已达上限' : `升级至 ${nextTierLabel}`}</span>
          <span>
            {isMaxTier ? (
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold">尊贵满级会员</span>
            ) : (
              <>
                还差 <strong className="text-amber-600 dark:text-amber-400 font-semibold">{pointsToNextTier?.toLocaleString()}</strong> 积分
                <span className="text-[11px] font-bold text-[var(--color-primary)] ml-1">({roundedPct}%)</span>
              </>
            )}
          </span>
        </div>

        {/* 进度轨容器 - 遵循 skills-ref/migrate-radix-to-base 语义与无障碍规范 */}
        <div
          role="progressbar"
          aria-valuenow={lifetimeEarnedPoints}
          aria-valuemin={currentThresh}
          aria-valuemax={nextThresh ?? lifetimeEarnedPoints}
          aria-valuetext={`${roundedPct}% 成长进度`}
          className="relative w-full bg-slate-100 dark:bg-slate-800/80 rounded-full h-2.5 overflow-hidden border border-slate-200/60 dark:border-slate-700/60 shadow-inner"
        >
          <div
            className="relative h-full rounded-full bg-gradient-to-r from-[var(--color-primary)] via-indigo-500 to-amber-500 transition-all duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{ width: `${progress}%` }}
          >
            {/* 流光扫掠层 (skills-ref/transitions-dev/15-shimmer-text) */}
            <div
              className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/40 dark:via-white/20 to-transparent animate-progress-shimmer pointer-events-none"
              aria-hidden="true"
            />
            {/* 端点高光圆点 (Leading Edge Pip) */}
            {progress > 3 && progress < 99.5 && (
              <div
                className="absolute right-0.5 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-white shadow-[0_0_6px_rgba(245,158,11,0.95),0_0_2px_#fff] animate-pulse pointer-events-none"
                aria-hidden="true"
              />
            )}
          </div>
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
    <div className={`mt-2.5 max-w-xs w-full ${className}`}>
      {/* 顶部文字说明与比率 */}
      <div className="flex items-center justify-between text-[11px] text-[var(--color-text-muted)] mb-1.5 font-medium">
        <div className="flex items-center gap-1">
          <span>经验值:</span>
          <span className="font-semibold text-[var(--color-text)] tracking-tight">
            {lifetimeEarnedPoints.toLocaleString()}
            {nextThresh ? <span className="text-[var(--color-text-muted)] font-normal"> / {nextThresh.toLocaleString()}</span> : ''}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {isMaxTier ? (
            <span className="text-emerald-600 dark:text-emerald-400 font-semibold">已满级</span>
          ) : (
            <span>
              距下一级差 <strong className="text-amber-600 dark:text-amber-400 font-semibold">{pointsToNextTier?.toLocaleString()}</strong>
            </span>
          )}
          <span className="text-[10px] font-bold text-[var(--color-primary)]">({roundedPct}%)</span>
        </div>
      </div>

      {/* 进度轨容器 - 遵循 skills-ref/migrate-radix-to-base 语义与无障碍规范 */}
      <div
        role="progressbar"
        aria-valuenow={lifetimeEarnedPoints}
        aria-valuemin={currentThresh}
        aria-valuemax={nextThresh ?? lifetimeEarnedPoints}
        aria-valuetext={`${roundedPct}% 成长进度`}
        className="relative w-full bg-slate-100 dark:bg-slate-800/80 rounded-full h-2 overflow-hidden border border-slate-200/60 dark:border-slate-700/60 shadow-inner"
      >
        <div
          className="relative h-full rounded-full bg-gradient-to-r from-[var(--color-primary)] via-indigo-500 to-amber-500 transition-all duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{ width: `${progress}%` }}
        >
          {/* 流光扫掠层 (skills-ref/transitions-dev/15-shimmer-text) */}
          <div
            className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/40 dark:via-white/20 to-transparent animate-progress-shimmer pointer-events-none"
            aria-hidden="true"
          />
          {/* 端点高光圆点 (Leading Edge Pip) */}
          {progress > 3 && progress < 99.5 && (
            <div
              className="absolute right-0.5 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-white shadow-[0_0_6px_rgba(245,158,11,0.95),0_0_2px_#fff] animate-pulse pointer-events-none"
              aria-hidden="true"
            />
          )}
        </div>
      </div>
    </div>
  )
}
