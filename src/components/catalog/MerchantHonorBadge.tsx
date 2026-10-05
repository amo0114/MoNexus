import { Crown, Zap, ShieldCheck, Gem, Award, Flame, Sparkles, type LucideIcon } from 'lucide-react'

export interface MerchantHonorBadgeProps {
  badge: string
  className?: string
}

type BadgeTheme = 'gold' | 'cyan' | 'emerald' | 'purple' | 'amber' | 'rose' | 'default'

interface BadgeConfig {
  icon: LucideIcon
  theme: BadgeTheme
}

/**
 * Remove any unicode emojis (e.g. 👑, ⚡, 🛡️, 💎, 🏆, 🔥) from badge text
 * including variation selectors, so we can cleanly render mature SVG vector icons.
 */
function cleanBadgeText(raw: string): string {
  return raw
    .replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, '')
    .trim()
}

/**
 * Resolves appropriate Lucide vector icon and semantic theme color
 * based on badge keywords or legacy emoji markers.
 */
function resolveBadgeConfig(raw: string): BadgeConfig {
  const text = raw.trim()

  // 1. Certified / Official (平台认证 / 官方认证 / 品牌授权)
  if (text.includes('认证') || text.includes('官方') || text.includes('自营') || text.includes('👑')) {
    return { icon: Crown, theme: 'gold' }
  }

  // 2. Instant fulfillment / Speed (秒级履约 / 极速发货 / 自动发卡)
  if (text.includes('秒') || text.includes('履约') || text.includes('极速') || text.includes('直发') || text.includes('⚡')) {
    return { icon: Zap, theme: 'cyan' }
  }

  // 3. Escrow / Financial Security (全额存管 / 资金存管 / 担保 / 售后保障)
  if (text.includes('存管') || text.includes('保障') || text.includes('全额') || text.includes('包赔') || text.includes('🛡')) {
    return { icon: ShieldCheck, theme: 'emerald' }
  }

  // 4. Premium / Quality / Diamond (优质商户 / 旗舰服务 / 钻石卖家)
  if (text.includes('优质') || text.includes('金牌') || text.includes('钻石') || text.includes('旗舰') || text.includes('💎')) {
    return { icon: Gem, theme: 'purple' }
  }

  // 5. Store Longevity / Award (5年老店 / 百年老店 / 荣誉商户)
  if (text.includes('年') || text.includes('老店') || text.includes('🏆') || text.includes('奖')) {
    return { icon: Award, theme: 'amber' }
  }

  // 6. Hot / Trending (热卖 / 爆款)
  if (text.includes('热') || text.includes('爆') || text.includes('🔥')) {
    return { icon: Flame, theme: 'rose' }
  }

  // Default fallback
  return { icon: Sparkles, theme: 'default' }
}

export default function MerchantHonorBadge({ badge, className = '' }: MerchantHonorBadgeProps) {
  const cleanText = cleanBadgeText(badge) || badge
  const { icon: Icon, theme } = resolveBadgeConfig(badge)

  return (
    <span
      className={`pd-honor-badge pd-honor-badge--${theme} ${className}`.trim()}
      data-theme-variant={theme}
      title={cleanText}
    >
      <Icon size={12} className="pd-honor-badge-icon" aria-hidden="true" />
      <span className="pd-honor-badge-text">{cleanText}</span>
    </span>
  )
}
