import { Loader2, Trophy, Sparkles, Zap, ShieldCheck, Gift } from 'lucide-react'
import { MemberTierBadge } from '../MemberTierBadge'
import { ExperienceProgressBar } from './ExperienceProgressBar'
import type { TierResponse } from '../../api/points'

// 会员等级权益详情卡片
export default function MemberTierCard({
  tierData,
  registry,
  loading,
}: {
  tierData: TierResponse | null
  registry: any
  loading: boolean
}) {
  if (loading) {
    return (
      <div className="card h-full flex items-center justify-center py-8 text-[var(--color-text-muted)] text-sm">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> 正在加载会员等级...
      </div>
    )
  }

  if (!tierData) {
    return (
      <div className="card h-full flex items-center justify-center py-6">
        <p className="text-sm text-[var(--color-text-muted)]">暂时无法获取会员等级信息</p>
      </div>
    )
  }

  const { tier, label, tone, lifetimeEarnedPoints, bonusBps, nextTier } = tierData

  let nextTierLabel = nextTier
  if (nextTier && registry?.memberTiers) {
    const found = registry.memberTiers.find((t: any) => t.value === nextTier)
    if (found) nextTierLabel = found.label
  }

  return (
    <div className="card h-full flex flex-col justify-between gap-4">
      <div>
        <div className="flex items-start sm:items-center justify-between gap-2.5 mb-3">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="w-10 h-10 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-xl flex items-center justify-center shrink-0">
              <Trophy className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h4 className="font-heading font-bold text-sm sm:text-base text-[var(--color-text)] whitespace-nowrap">
                  会员权益
                </h4>
                <MemberTierBadge tier={tier} label={label} tone={tone} />
              </div>
              <p className="text-xs text-[var(--color-text-muted)] mt-0.5 truncate">
                每日签到加成与平台专属特权
              </p>
            </div>
          </div>
          <span className="text-xs font-semibold text-[var(--color-text)] bg-[var(--color-background)] px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-lg border border-[var(--color-border)]/60 shrink-0 whitespace-nowrap">
            累计 {lifetimeEarnedPoints} 积分
          </span>
        </div>

        {/* 成长阶梯进度展示 (Plan A: 流光质感进度条) */}
        <div className="mt-4 p-3 rounded-xl bg-[var(--color-background)] border border-[var(--color-border)]/50">
          <ExperienceProgressBar
            tierData={tierData}
            variant="detailed"
            nextTierLabelOverride={nextTierLabel}
          />
        </div>
        {/* 特权清单矩阵 */}
        <div className="mt-4 grid grid-cols-2 gap-2 text-xs pt-3 border-t border-[var(--color-border)]/60">
          <div className="p-2.5 rounded-lg bg-[var(--color-background)] border border-[var(--color-border)]/50 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-500 shrink-0" />
            <div className="min-w-0">
              <div className="font-bold text-[var(--color-text)] truncate">签到加成</div>
              <div className="text-[11px] text-[var(--color-text-muted)] truncate">
                {bonusBps > 0 ? `+${(bonusBps / 100).toFixed(1).replace(/\.0$/, '')}% 额外积分` : '升级享额外加成'}
              </div>
            </div>
          </div>
          <div className="p-2.5 rounded-lg bg-[var(--color-background)] border border-[var(--color-border)]/50 flex items-center gap-2">
            <Zap className="w-4 h-4 text-[var(--color-primary)] shrink-0" />
            <div className="min-w-0">
              <div className="font-bold text-[var(--color-text)] truncate">履约提速</div>
              <div className="text-[11px] text-[var(--color-text-muted)] truncate">全天候秒级直发</div>
            </div>
          </div>
          <div className="p-2.5 rounded-lg bg-[var(--color-background)] border border-[var(--color-border)]/50 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
            <div className="min-w-0">
              <div className="font-bold text-[var(--color-text)] truncate">售后保障</div>
              <div className="text-[11px] text-[var(--color-text-muted)] truncate">失效卡密极速核实</div>
            </div>
          </div>
          <div className="p-2.5 rounded-lg bg-[var(--color-background)] border border-[var(--color-border)]/50 flex items-center gap-2">
            <Gift className="w-4 h-4 text-purple-500 shrink-0" />
            <div className="min-w-0">
              <div className="font-bold text-[var(--color-text)] truncate">专属特权</div>
              <div className="text-[11px] text-[var(--color-text-muted)] truncate">高阶活动优先参与</div>
            </div>
          </div>
        </div>
      </div>

      <div className="pt-3 border-t border-[var(--color-border)]/60 flex items-center justify-between text-xs text-[var(--color-text-muted)]">
        <span>当前等级专属加成：</span>
        <span className="font-bold text-[var(--color-primary)]">
          {bonusBps === 0 ? '暂无等级加成' : `+${(bonusBps / 100).toFixed(1).replace(/\.0$/, '')}%`}
        </span>
      </div>
    </div>
  )
}
