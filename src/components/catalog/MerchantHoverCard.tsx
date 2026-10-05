import { useState, useRef, useEffect, type ReactNode } from 'react'
import { Crown, Headphones, ShieldCheck, ShoppingBag, Star, ChevronRight, BadgeCheck } from 'lucide-react'
import type { ProductMerchant } from '../../pages/ProductDetailPage'
import MerchantHonorBadge from './MerchantHonorBadge'
import './MerchantHoverCard.css'

interface MerchantHoverCardProps {
  merchant: ProductMerchant
  preview?: boolean
  onContactSupport: () => void
  onEnterShop?: () => void
  children?: ReactNode
}

export default function MerchantHoverCard({
  merchant,
  preview = false,
  onContactSupport,
  onEnterShop,
}: MerchantHoverCardProps) {
  const [isOpen, setIsOpen] = useState(false)
  const timerRef = useRef<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleMouseEnter = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setIsOpen(true)
  }

  const handleMouseLeave = () => {
    timerRef.current = window.setTimeout(() => {
      setIsOpen(false)
    }, 200)
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false)
    }
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  const avatarUrl = merchant.logoUrl || merchant.avatarUrl
  const initial = merchant.name.trim().charAt(0) || '商'
  const primaryTitle = merchant.title || (preview ? '金牌商家' : '商家服务')
  const badgesList =
    merchant.badges && merchant.badges.length > 0
      ? merchant.badges
      : ['平台认证', '秒级履约', '全额存管', '优质商户']

  const rating = merchant.ratingAvg != null ? merchant.ratingAvg.toFixed(1) : '4.9'

  return (
    <div
      className="pd-merchant-hovercard-wrap"
      ref={containerRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Trigger in Byline */}
      <button
        type="button"
        className="pd-byline-store-trigger"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
      >
        <span className="pd-byline-icon">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="pd-byline-avatar-img" />
          ) : (
            <span className="pd-byline-initial">{initial}</span>
          )}
        </span>
        <span className="pd-byline-name">{merchant.name}</span>
        <span className="pd-byline-tag">
          <ShieldCheck size={11} />
          {primaryTitle}
        </span>
        {preview && (
          <span className="pd-byline-tag pd-tag-gold">
            <Crown size={11} />
            金牌商家
          </span>
        )}
      </button>

      {/* Popover Card */}
      {isOpen && (
        <div
          className="pd-merchant-hovercard-dialog"
          role="dialog"
          aria-label={`${merchant.name}商家名片`}
        >
          {/* Card Header */}
          <div className="pd-hovercard-head">
            <div className="pd-hovercard-avatar-wrap">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="pd-hovercard-avatar-img" />
              ) : (
                <div className="pd-hovercard-avatar-fallback">
                  <span>{initial}</span>
                </div>
              )}
              <span className="pd-hovercard-online-dot" title="在线" />
            </div>

            <div className="pd-hovercard-meta">
              <div className="pd-hovercard-name-row">
                <h3>{merchant.name}</h3>
                <BadgeCheck size={16} className="pd-hovercard-verified-icon" />
              </div>
              <p className="pd-hovercard-sub">官方实名认证 · 履约资金存管保障</p>
            </div>
          </div>

          {/* Badges Wall */}
          <div className="pd-hovercard-badges-wall">
            {badgesList.map((badge: string, idx: number) => (
              <MerchantHonorBadge key={idx} badge={badge} />
            ))}
          </div>

          {/* Performance Metrics */}
          <div className="pd-hovercard-metrics">
            <div className="pd-hovercard-metric-item">
              <strong>
                <Star size={13} fill="currentColor" /> {rating}
              </strong>
              <span>综合评分</span>
            </div>
            <div className="pd-hovercard-metric-item">
              <strong>{(merchant.sales ?? 1280).toLocaleString()}+</strong>
              <span>已售单量</span>
            </div>
            <div className="pd-hovercard-metric-item">
              <strong>{merchant.responseTime || '< 5分钟'}</strong>
              <span>平均响应</span>
            </div>
          </div>

          {/* Card Actions */}
          <div className="pd-hovercard-actions">
            <button
              type="button"
              className="pd-hovercard-btn-support"
              onClick={() => {
                setIsOpen(false)
                onContactSupport()
              }}
            >
              <Headphones size={14} />
              在线咨询
            </button>
            {onEnterShop && (
              <button
                type="button"
                className="pd-hovercard-btn-shop"
                onClick={() => {
                  setIsOpen(false)
                  onEnterShop()
                }}
              >
                <ShoppingBag size={14} />
                进入店铺
                <ChevronRight size={13} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
