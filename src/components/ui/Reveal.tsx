/**
 * Structural reveal wrapper. Content renders visibly by default without
 * gating visibility on JS or scroll-driven `opacity: 0` animations, which
 * can leave cards unpainted on iOS Safari / WebKit.
 */
export default function Reveal({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return <div className={`reveal ${className}`}>{children}</div>
}
