import { BlockList, isIP } from 'node:net'

export type ClientIpClass = 'public' | 'private' | 'loopback' | 'invalid'

const loopbackNets = new BlockList()
loopbackNets.addSubnet('127.0.0.0', 8, 'ipv4')
loopbackNets.addAddress('::1', 'ipv6')

const privateNets = new BlockList()
privateNets.addSubnet('10.0.0.0', 8, 'ipv4')
privateNets.addSubnet('172.16.0.0', 12, 'ipv4')
privateNets.addSubnet('192.168.0.0', 16, 'ipv4')
privateNets.addSubnet('169.254.0.0', 16, 'ipv4')
privateNets.addSubnet('100.64.0.0', 10, 'ipv4')
privateNets.addSubnet('fc00::', 7, 'ipv6')
privateNets.addSubnet('fe80::', 10, 'ipv6')

const unspecifiedNets = new BlockList()
unspecifiedNets.addAddress('0.0.0.0', 'ipv4')
unspecifiedNets.addAddress('::', 'ipv6')

function parseIpv4Octets(address: string): [number, number, number, number] | null {
  if (isIP(address) !== 4) return null
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null
  }
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!]
}

function parseIpv6Hextets(address: string): number[] | null {
  if (isIP(address) !== 6) return null
  const halves = address.split('::')
  if (halves.length > 2) return null

  const parseSide = (side: string): number[] | null => {
    if (side === '') return []
    const tokens = side.split(':')
    const result: number[] = []
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!
      if (token.includes('.')) {
        if (i !== tokens.length - 1) return null
        const octets = parseIpv4Octets(token)
        if (!octets) return null
        result.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return null
        result.push(Number.parseInt(token, 16))
      }
    }
    return result
  }

  const left = parseSide(halves[0]!)
  const right = halves.length === 2 ? parseSide(halves[1]!) : []
  if (!left || !right) return null

  if (halves.length === 1) {
    return left.length === 8 ? left : null
  }
  const missing = 8 - (left.length + right.length)
  if (missing < 1) return null
  return [...left, ...new Array<number>(missing).fill(0), ...right]
}

/** Formats 8 uint16 hextets into RFC 5952 canonical lowercase compressed IPv6. */
function formatIpv6Canonical(hextets: readonly number[]): string {
  let bestStart = -1
  let bestLen = 0
  let curStart = -1
  let curLen = 0

  for (let i = 0; i < 8; i += 1) {
    if (hextets[i] === 0) {
      if (curStart === -1) curStart = i
      curLen += 1
      if (curLen > bestLen) {
        bestStart = curStart
        bestLen = curLen
      }
    } else {
      curStart = -1
      curLen = 0
    }
  }

  // RFC 5952 §4.2.2: never shorten a single 16-bit zero field.
  if (bestLen < 2) {
    return hextets.map(value => value.toString(16)).join(':')
  }

  const left = hextets.slice(0, bestStart).map(value => value.toString(16)).join(':')
  const right = hextets.slice(bestStart + bestLen).map(value => value.toString(16)).join(':')
  return `${left}::${right}`
}

type CanonicalIp =
  | { address: string; version: 4 }
  | { address: string; version: 6; hextets: number[] }

function parseCanonicalIp(ip: string | null | undefined): CanonicalIp | null {
  if (typeof ip !== 'string' || ip.length === 0) return null
  if (ip !== ip.trim()) return null

  const version = isIP(ip)
  if (version === 4) {
    return { address: ip, version: 4 }
  }
  if (version !== 6) return null

  const hextets = parseIpv6Hextets(ip)
  if (!hextets) return null

  // Normalize all IPv4-mapped IPv6 forms (::ffff:a.b.c.d, ::ffff:xxxx:yyyy,
  // 0:0:0:0:0:ffff:...) to canonical dotted-quad IPv4 so hashing, redaction,
  // classification, and rate-limit keys never split dual-stack clients.
  if (
    hextets[0] === 0
    && hextets[1] === 0
    && hextets[2] === 0
    && hextets[3] === 0
    && hextets[4] === 0
    && hextets[5] === 0xffff
  ) {
    const hi = hextets[6]!
    const lo = hextets[7]!
    return {
      address: `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`,
      version: 4,
    }
  }

  return {
    address: formatIpv6Canonical(hextets),
    version: 6,
    hextets,
  }
}

/**
 * Validates and canonicalizes a client IP address.
 * - IPv4-mapped IPv6 addresses are unwrapped to canonical IPv4.
 * - IPv6 addresses are formatted in lowercase RFC 5952 compressed form.
 * - Leading/trailing whitespace or invalid inputs return null.
 */
export function normalizeClientIp(ip: string | null | undefined): string | null {
  return parseCanonicalIp(ip)?.address ?? null
}

/**
 * Produces a stable rate-limit / concurrency key for a client IP:
 * - IPv4 (including IPv4-mapped IPv6) -> canonical IPv4 address.
 * - IPv6 -> canonical masked prefix (default `/56`, e.g. `2001:db8:1234:5600::/56`).
 * - Idempotent when given an already-masked IPv6 `/<ipv6PrefixBits>` key.
 * - Unparseable or missing input -> `'unknown'`.
 */
export function clientIpRateLimitKey(ip: string | null | undefined, ipv6PrefixBits = 56): string {
  const prefixBits = Number.isInteger(ipv6PrefixBits) && ipv6PrefixBits >= 1 && ipv6PrefixBits <= 128
    ? ipv6PrefixBits
    : 56

  if (typeof ip !== 'string' || ip.length === 0) return 'unknown'
  const candidate = ip.trim()
  if (!candidate) return 'unknown'

  let rawAddress = candidate
  const cidrMatch = /^([^/]+)\/([0-9]{1,3})$/.exec(candidate)
  if (cidrMatch && Number(cidrMatch[2]) === prefixBits) {
    rawAddress = cidrMatch[1]!
  }

  const parsed = parseCanonicalIp(rawAddress)
  if (!parsed) return 'unknown'
  if (parsed.version === 4) return parsed.address

  const masked = parsed.hextets.map((hextet, index) => {
    const bitStart = index * 16
    if (prefixBits <= bitStart) return 0
    if (prefixBits >= bitStart + 16) return hextet
    const keepBits = prefixBits - bitStart
    const mask = (0xffff << (16 - keepBits)) & 0xffff
    return hextet & mask
  })
  return `${formatIpv6Canonical(masked)}/${prefixBits}`
}

export function classifyClientIp(ip: string | null | undefined): ClientIpClass {
  const parsed = parseCanonicalIp(ip)
  if (!parsed) return 'invalid'

  const type = parsed.version === 4 ? 'ipv4' : 'ipv6'
  if (unspecifiedNets.check(parsed.address, type)) return 'invalid'
  if (loopbackNets.check(parsed.address, type)) return 'loopback'
  if (privateNets.check(parsed.address, type)) return 'private'
  return 'public'
}

export function redactIpHint(ip: string | null | undefined): string {
  const parsed = parseCanonicalIp(ip)
  if (!parsed) return '未知 IP'
  if (classifyClientIp(parsed.address) !== 'public') return '未知 IP'
  if (parsed.version === 4) {
    const [first, second, third] = parsed.address.split('.')
    return `${first}.${second}.${third}.*`
  }
  return 'IPv6 地址'
}

export function routeGroupOf(path: string | undefined): string {
  const raw = (path ?? '').split('?')[0] ?? ''
  const parts = raw.split('/').filter(Boolean)
  const start = parts[0] === 'api' ? 1 : 0
  const group = parts[start]
  if (!group) return 'root'
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(group)) return 'other'
  return group
}
