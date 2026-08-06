import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { config } from '../../config/index.js'
import { badRequest } from '../httpError.js'

/**
 * SPEC-STORAGE-001：管理端可配 endpoint 的 SSRF 收敛。
 * DNS 解析后检查最终 IP；生产默认 HTTPS。
 * Allowlist：单标签（如 minio）仅精确匹配；多标签 FQDN 允许精确或子域后缀；
 * 命中后仍做 DNS/IP 检查（私网仅 allowlist 主机可放行）。
 */

function normalizeIp(ip: string): string {
  const lower = ip.toLowerCase()
  if (lower.startsWith('::ffff:')) return lower.slice(7)
  return lower
}

function isBlockedIp(ip: string): boolean {
  const n = normalizeIp(ip)
  if (n === '::1' || n === '0.0.0.0') return true
  if (n.startsWith('127.')) return true
  if (n.startsWith('10.')) return true
  if (n.startsWith('192.168.')) return true
  if (n.startsWith('169.254.')) return true
  if (n.startsWith('100.64.')) return true
  if (n.startsWith('0.')) return true
  const m = /^172\.(\d+)\./.exec(n)
  if (m) {
    const second = Number(m[1])
    if (second >= 16 && second <= 31) return true
  }
  // IPv6 ULA fc00::/7, link-local fe80::/10
  if (n.includes(':')) {
    if (n.startsWith('fe80:') || n.startsWith('fe8') || n.startsWith('fe9') || n.startsWith('fea') || n.startsWith('feb')) {
      return true
    }
    // fc00::/7 → first hextet fc00–fdff
    const first = n.split(':')[0] ?? ''
    if (/^f[cd][0-9a-f]{0,2}$/i.test(first) || first.toLowerCase().startsWith('fc') || first.toLowerCase().startsWith('fd')) {
      // more precise: parse first 8 bits
      if (/^f[cd]/i.test(first)) return true
    }
  }
  return false
}

/**
 * Allowlist entries:
 * - Single label (e.g. `minio`): **exact host match only** (Docker Compose service names).
 * - Multi-label FQDN (e.g. `minio.internal`): exact or subdomain suffix match.
 * Bare public TLDs (`com`, `io`) are rejected.
 */
function normalizeAllowlistEntry(entry: string): string | null {
  const s = entry.toLowerCase().replace(/^\./, '')
  if (!s || s.length < 2) return null
  if (s.includes('..') || s.startsWith('.') || s.endsWith('.')) return null
  const labels = s.split('.')
  if (labels.some(l => !l || l.length > 63)) return null
  // Reject bare TLD-like single labels that are too short or known bare suffixes
  if (labels.length === 1) {
    // Exact-match Docker hostnames: minio, monexus-minio, etc.
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(s)) return null
    // Block obvious public TLDs used alone
    if (/^(com|net|org|io|co|dev|app|xyz|cn|info)$/.test(s)) return null
    return s
  }
  if (labels.length < 2) return null
  return s
}

/** Exported for unit tests (allowlist matching rules without full DNS). */
export function hostMatchesStorageAllowlist(
  hostname: string,
  allowlist: string[],
): boolean {
  if (!allowlist.length) return false
  const host = hostname.toLowerCase()
  return allowlist.some(raw => {
    const s = normalizeAllowlistEntry(raw)
    if (!s) return false
    const labels = s.split('.')
    if (labels.length === 1) {
      // Single-label: exact match only (never *.minio via suffix)
      return host === s
    }
    return host === s || host.endsWith(`.${s}`)
  })
}

function hostAllowedByList(hostname: string): boolean {
  return hostMatchesStorageAllowlist(hostname, config.storageEndpointAllowlist)
}

export async function assertSafeStorageEndpoint(endpoint: string): Promise<void> {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw badRequest('endpoint 不是合法 URL')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badRequest('endpoint 仅支持 http/https')
  }

  if (url.username || url.password) {
    throw badRequest('endpoint 不得包含用户名或密码')
  }

  const hostname = url.hostname
  const allowlisted = hostAllowedByList(hostname)

  if (config.isProduction && url.protocol !== 'https:' && !allowlisted) {
    throw badRequest('生产环境 endpoint 必须使用 HTTPS（自建 MinIO 请配置 STORAGE_ENDPOINT_ALLOWLIST）')
  }

  // Always resolve and check IPs — allowlist only permits http in production /
  // private MinIO, never skips private-IP rejection for non-allowlisted hosts.
  // For allowlisted hosts we still reject obvious loopback/metadata unless
  // the hostname itself is explicitly allowlisted (self-hosted).
  const ips: string[] = []
  if (isIP(hostname)) {
    ips.push(hostname)
  } else {
    try {
      const records = await lookup(hostname, { all: true })
      for (const r of records) ips.push(r.address)
    } catch {
      throw badRequest('无法解析 endpoint 主机名')
    }
  }

  if (ips.length === 0) {
    throw badRequest('无法解析 endpoint 主机名')
  }

  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      if (allowlisted) {
        // Self-hosted MinIO on private net: allowlist host may resolve private.
        continue
      }
      throw badRequest('endpoint 解析到不可达的内网或保留地址')
    }
  }
}
