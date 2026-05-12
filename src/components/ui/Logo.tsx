/**
 * MoNexus brand mark — "Concentric Nexus".
 *
 * Filled center node + two concentric arcs reading as a hub broadcasting.
 * Mathematically clean geometry only (perfect circular arcs) so the mark
 * stays crisp at every render size from a 16px favicon to a 128px hero.
 * stroke/fill use currentColor so the caller controls hue via Tailwind
 * text color; the mark follows --color-primary automatically in light
 * and dark mode.
 */
interface LogoProps {
  className?: string
}

export default function Logo({ className = '' }: LogoProps) {
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
