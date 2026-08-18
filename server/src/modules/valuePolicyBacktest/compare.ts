export function compareFixed(left: string, right: string): number {
  const normalize = (value: string) => {
    const [whole, fraction = ''] = value.split('.')
    const sign = whole.startsWith('-') ? -1n : 1n
    const absWhole = whole.startsWith('-') ? whole.slice(1) : whole
    return { sign, whole: BigInt(absWhole || '0'), fraction }
  }
  const a = normalize(left)
  const b = normalize(right)
  const scale = Math.max(a.fraction.length, b.fraction.length)
  const toScaled = (part: typeof a) => {
    const frac = part.fraction.padEnd(scale, '0')
    return part.sign * (part.whole * (10n ** BigInt(scale)) + BigInt(frac || '0'))
  }
  const leftValue = toScaled(a)
  const rightValue = toScaled(b)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}
