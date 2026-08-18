export function gcd(a: bigint, b: bigint): bigint {
  if (typeof a !== 'bigint' || typeof b !== 'bigint') {
    throw new Error('gcd operands must be bigint')
  }
  let x = a < 0n ? -a : a
  let y = b < 0n ? -b : b
  while (y !== 0n) {
    const next = x % y
    x = y
    y = next
  }
  return x
}
