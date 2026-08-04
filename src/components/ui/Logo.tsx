/**
 * MoNexus brand mark — Ledger Knot.
 *
 * The mark is deliberately raster-based: its small optical corrections and
 * softly resolved edges come from the approved Image2 artwork, rather than
 * being approximated again in CSS or SVG.
 */
interface LogoProps {
  className?: string
}

export default function Logo({ className = '' }: LogoProps) {
  return (
    <span
      className={['brand-logo relative inline-grid', className].filter(Boolean).join(' ')}
      aria-hidden="true"
    >
      <img
        className="brand-logo__light"
        src="/brand/ledger-knot/mark-light.png"
        alt=""
        decoding="async"
        draggable={false}
      />
      <img
        className="brand-logo__dark"
        src="/brand/ledger-knot/mark-dark.png"
        alt=""
        decoding="async"
        draggable={false}
      />
      <img
        className="brand-logo__soft"
        src="/brand/ledger-knot/mark-soft.png"
        alt=""
        decoding="async"
        draggable={false}
      />
      <img
        className="brand-logo__black"
        src="/brand/ledger-knot/mark-black.png"
        alt=""
        decoding="async"
        draggable={false}
      />
    </span>
  )
}
