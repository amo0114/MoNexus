import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ExperienceProgressBar } from './ExperienceProgressBar'
import type { TierResponse } from '../../api/points'

describe('ExperienceProgressBar', () => {
  const mockBronzeTier: TierResponse = {
    tier: 'bronze',
    label: '普通会员',
    tone: 'neutral',
    lifetimeEarnedPoints: 150,
    bonusBps: 0,
    thresholds: { silver: 500, gold: 2000, platinum: 10000 },
    nextTier: 'silver',
    pointsToNextTier: 350,
  }

  const mockMaxTier: TierResponse = {
    tier: 'platinum',
    label: '铂金会员',
    tone: 'warning',
    lifetimeEarnedPoints: 15000,
    bonusBps: 1500,
    thresholds: { silver: 500, gold: 2000, platinum: 10000 },
    nextTier: null,
    pointsToNextTier: 0,
  }

  it('renders compact mode with correct ratios and accessibility attributes', () => {
    render(<ExperienceProgressBar tierData={mockBronzeTier} variant="compact" />)

    expect(screen.getByText('经验值:')).toBeInTheDocument()
    expect(screen.getByText('150')).toBeInTheDocument()
    expect(screen.getByText('/ 500')).toBeInTheDocument()
    expect(screen.getByText('350')).toBeInTheDocument()
    expect(screen.getByText('(30%)')).toBeInTheDocument()

    const progressBar = screen.getByRole('progressbar')
    expect(progressBar).toHaveAttribute('aria-valuenow', '150')
    expect(progressBar).toHaveAttribute('aria-valuemin', '0')
    expect(progressBar).toHaveAttribute('aria-valuemax', '500')
    expect(progressBar).toHaveAttribute('aria-valuetext', '30% 成长进度')
  })

  it('renders max tier correctly in compact mode', () => {
    render(<ExperienceProgressBar tierData={mockMaxTier} variant="compact" />)

    expect(screen.getByText('已满级')).toBeInTheDocument()
    expect(screen.getByText('(100%)')).toBeInTheDocument()

    const progressBar = screen.getByRole('progressbar')
    expect(progressBar).toHaveAttribute('aria-valuenow', '15000')
    expect(progressBar).toHaveAttribute('aria-valuetext', '100% 成长进度')
  })

  it('renders detailed mode with scale thresholds and labels', () => {
    render(
      <ExperienceProgressBar
        tierData={mockBronzeTier}
        variant="detailed"
        nextTierLabelOverride="白银会员"
      />
    )

    expect(screen.getByText('升级至 白银会员')).toBeInTheDocument()
    expect(screen.getByText('当前起点: 0')).toBeInTheDocument()
    expect(screen.getByText('下一目标: 500')).toBeInTheDocument()
    expect(screen.getByText('(30%)')).toBeInTheDocument()
  })

  it('renders null safely when tierData is missing', () => {
    const { container } = render(<ExperienceProgressBar tierData={null} />)
    expect(container.firstChild).toBeNull()
  })
})
