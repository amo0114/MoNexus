import { useLogoStore, type LogoVariant } from '../../stores/logoStore'

interface LogoProps {
  /** Force a specific variant (overrides the user preference). */
  variant?: LogoVariant
  className?: string
}

/**
 * MoNexus brand mark. Two candidate forms are kept side-by-side
 * (Flow and Concentric) and the active one is chosen from logoStore.
 *
 * Both marks use stroke="currentColor" / fill="currentColor" so the
 * caller controls hue via Tailwind text color, and they automatically
 * follow light / dark mode through the --color-primary token system.
 *
 * Both SVGs use mathematically clean geometry only (straight runs +
 * perfect circular arcs) so they remain crisp at every render size
 * from 16px favicon to 100px hero.
 */
export default function Logo({ variant, className = '' }: LogoProps) {
  const active = useLogoStore((s) => s.variant)
  const choice = variant ?? active
  return choice === 'concentric' ? <ConcentricMark className={className} /> : <FlowMark className={className} />
}

/**
 * Variant A — "Fluid 'N' Flow".
 * Two straight verticals stitched together by two perfect 180° semicircles.
 * Reads as an "N" abstracted into a single continuous tube — Nexus by way
 * of the letter, without becoming a literal lettermark.
 */
export function FlowMark({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 36 36"
      fill="none"
      stroke="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M 6 25 V 15 A 6 6 0 0 1 18 15 V 21 A 6 6 0 0 0 30 21 V 11"
        strokeWidth="6.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Variant B — "Concentric Nexus".
 * A filled center node + two concentric arcs, reading as a hub broadcasting.
 * Lifted vocabulary from Apple AirDrop / Podcasts; sharp circular geometry only.
 */
export function ConcentricMark({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 36 36"
      fill="none"
      stroke="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <circle cx="18" cy="18" r="4.5" fill="currentColor" stroke="none" />
      <path d="M 9.5 18 A 8.5 8.5 0 0 1 26.5 18" strokeWidth="4.5" strokeLinecap="round" />
      <path d="M 4 18 A 14 14 0 0 0 32 18" strokeWidth="4.5" strokeLinecap="round" />
    </svg>
  )
}
