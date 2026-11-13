/**
 * Scroll reveal: content eases in as it enters the viewport using a CSS
 * scroll-driven animation (see `.reveal`). Visibility never depends on
 * JavaScript, so full-page captures, find-in-page and unsupported browsers
 * always see the content.
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
