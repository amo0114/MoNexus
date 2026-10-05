export default function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">
      {children} {required && <span className="text-red-500 normal-case">*</span>}
    </label>
  )
}
