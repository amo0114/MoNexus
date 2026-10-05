import React from 'react'
import Logo from './Logo'

export interface KineticBrandProps {
  /**
   * Whether the brand is in its condensed form (M · X).
   * Typically driven by page scroll state (e.g. scrollY > 36px).
   */
  isCondensed?: boolean
  /**
   * Whether the user is on an admin page (shows '管理后台' badge if needed).
   */
  isAdminPage?: boolean
  /**
   * Additional className on the outermost button container.
   */
  className?: string
  /**
   * Callback when the brand button is clicked.
   */
  onClick?: () => void
}

/**
 * KineticBrand
 *
 * Implements the flagship slide-down kinetic convergence animation for MoNexus,
 * inspired by Anthropic's logotype morph (ANTHROPIC → A\).
 *
 * Mechanics:
 * - Top / Expanded:   [Logo]  M O N E X U S
 * - Scrolled / Morph: [Logo]  M · X
 *
 * 1. The Ledger Knot Logo and initial letter 'M' act as the visual left anchor.
 * 2. Letters 'ONE' and 'US' gracefully fade out with an ease-out horizontal retreat.
 * 3. The precision separator dot '·' (cybernetic primary neon point) expands with an elastic pop.
 * 4. The connecting hub letter 'X' smoothly glides leftward to dock right beside the dot.
 * 5. Fixed container bounds guarantee zero Cumulative Layout Shift (CLS = 0).
 */
export default function KineticBrand({
  isCondensed = false,
  isAdminPage = false,
  className = '',
  onClick,
}: KineticBrandProps) {
  return (
    <div className={['flex items-center gap-2.5', className].filter(Boolean).join(' ')}>
      <button
        type="button"
        onClick={onClick}
        title="MoNexus 首页"
        aria-label="MoNexus 首页"
        className="min-h-[40px] py-1 flex items-center gap-2 min-[360px]:gap-2.5 cursor-pointer group focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] rounded text-left select-none"
      >
        {/* Brand Mark (Ledger Knot) */}
        <Logo className="w-7 h-7 min-[360px]:w-8 min-[360px]:h-8 text-[var(--color-primary)] transition-transform duration-300 group-hover:scale-105 shrink-0" />

        {/* Wordmark Container with Fixed Layout Box to ensure CLS = 0 on desktop */}
        <div
          className="relative flex items-center overflow-visible md:w-[8.4rem] md:min-w-[8.4rem] h-6"
        >
          <span
            className="font-heading font-bold text-[var(--color-text)] text-sm min-[360px]:text-lg leading-none tracking-[0.18em] flex items-center whitespace-nowrap"
            style={{
              fontFeatureSettings: '"tnum" 1',
            }}
          >
            {/* 1. M: Static Anchor */}
            <span className="inline-block shrink-0 will-change-transform">
              M
            </span>

            {/* 2. Precision Separator Dot '·' (fades in quietly without bounce) */}
            <span
              aria-hidden={!isCondensed}
              className="inline-flex items-center justify-center shrink-0 overflow-hidden"
              style={{
                width: isCondensed ? '14px' : '0px',
                opacity: isCondensed ? 1 : 0,
                transform: isCondensed ? 'scale(1)' : 'scale(0.85)',
                transition:
                  'width 500ms cubic-bezier(0.22, 1, 0.36, 1), opacity 300ms ease, transform 500ms cubic-bezier(0.22, 1, 0.36, 1)',
                pointerEvents: 'none',
              }}
            >
              <span
                className="w-[5px] h-[5px] rounded-full bg-[var(--color-primary)] inline-block shrink-0 shadow-none dark:shadow-[0_0_8px_var(--color-primary)]"
              />
            </span>

            {/* 3. ONE: Collapses in width and fades out */}
            <span
              aria-hidden={isCondensed}
              className="inline-flex overflow-hidden shrink-0"
              style={{
                maxWidth: isCondensed ? '0px' : '64px',
                opacity: isCondensed ? 0 : 1,
                transform: isCondensed ? 'translateX(-6px)' : 'translateX(0)',
                transition:
                  'max-width 500ms cubic-bezier(0.22, 1, 0.36, 1), opacity 300ms ease, transform 500ms cubic-bezier(0.22, 1, 0.36, 1)',
                pointerEvents: isCondensed ? 'none' : 'auto',
              }}
            >
              <span className="inline-block whitespace-nowrap tracking-[0.18em]">
                ONE
              </span>
            </span>

            {/* 4. X: Glides smoothly from 'MONEXUS' into 'M · X' */}
            <span
              className="inline-block shrink-0 will-change-transform transition-colors duration-300"
              style={{
                color: 'var(--color-text)',
              }}
            >
              X
            </span>

            {/* 5. US: Collapses in width and fades out */}
            <span
              aria-hidden={isCondensed}
              className="inline-flex overflow-hidden shrink-0"
              style={{
                maxWidth: isCondensed ? '0px' : '48px',
                opacity: isCondensed ? 0 : 1,
                transform: isCondensed ? 'translateX(-6px)' : 'translateX(0)',
                transition:
                  'max-width 500ms cubic-bezier(0.22, 1, 0.36, 1), opacity 300ms ease, transform 500ms cubic-bezier(0.22, 1, 0.36, 1)',
                pointerEvents: isCondensed ? 'none' : 'auto',
              }}
            >
              <span className="inline-block whitespace-nowrap tracking-[0.18em]">
                US
              </span>
            </span>
          </span>
        </div>
      </button>

      {/* Admin badge if on admin route */}
      {isAdminPage && (
        <span className="hidden sm:inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold bg-[var(--color-primary)]/10 text-[var(--color-primary)] border border-[var(--color-primary)]/20 whitespace-nowrap">
          管理后台
        </span>
      )}
    </div>
  )
}
