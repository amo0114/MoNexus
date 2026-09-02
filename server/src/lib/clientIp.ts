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

function normalizeIp(ip: string | null | undefined): { address: string; version: 4 | 6 } | null {
  if (ip == null) return null
  if (ip !== ip.trim()) return null
  const stripped = ip.replace(/^::ffff:/i, '')
  const version = isIP(stripped)
  if (version !== 4 && version !== 6) return null
  return { address: stripped, version }
}

export function classifyClientIp(ip: string | null | undefined): ClientIpClass {
  const parsed = normalizeIp(ip)
  if (!parsed) return 'invalid'

  const type = parsed.version === 4 ? 'ipv4' : 'ipv6'
  if (unspecifiedNets.check(parsed.address, type)) return 'invalid'
  if (loopbackNets.check(parsed.address, type)) return 'loopback'
  if (privateNets.check(parsed.address, type)) return 'private'
  return 'public'
}

export function redactIpHint(ip: string | null | undefined): string {
  const parsed = normalizeIp(ip)
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
