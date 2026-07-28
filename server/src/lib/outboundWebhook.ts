import { createHmac, timingSafeEqual } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns'
import type { LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { config } from '../config/index.js'

/**
 * P7b：自动开通 webhook 外呼安全面（设计 §3.3/§3.5，硬验收 ⑦⑨）。
 *
 * 硬规则：
 * - 仅 https + 443；URL 禁 userinfo（`user:pass@` 直接拒绝）；配置保存时与
 *   **每次外呼连接时**双重校验。
 * - 解析出的全部 A/AAAA 必须公网可路由，任一命中保留段整体拒绝；**连接期
 *   IP 钉扎**：校验发生在 socket 建连的 lookup 钩子里——TLS 证书校验仍按
 *   **原 hostname**（node:https 的 servername 默认取 URL 主机名，lookup 只
 *   替换 DNS 解析），DNS rebinding 在每次连接处被挡（硬验收 ⑦）。
 * - 绝不跟随重定向（node http/https request 天然不跟随，3xx 按失败处理）；
 *   超时 10s；响应体上限 64KB（超限即断连）。
 * - 协议语义 = **至少一次外呼**：HTTP 成功而结果事务失败时必然重试，接收端
 *   必须以稳定 taskId 幂等去重（硬验收 ⑨）。
 * - 测试逃生 AUTO_PROVISION_ALLOW_INSECURE_TARGETS（config 层生产拒启）：
 *   同时放开 http、任意端口与私网目标——e2e stub 接收端跑在 127.0.0.1。
 * - 失败对外只暴露**脱敏诊断码**（classifyWebhookFailure），绝不落远端响应体。
 */

export const WEBHOOK_TIMEOUT_MS = 10_000
export const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024
const WEBHOOK_MAX_URL_LENGTH = 2048

export class WebhookTargetError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

// ---------- IP 公网可路由判定（纯函数，测试矩阵直测） ----------

function ipv4ToBytes(ip: string): number[] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const bytes = parts.map(p => Number(p))
  if (bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) return null
  return bytes
}

function isPubliclyRoutableIpv4(ip: string): boolean {
  const b = ipv4ToBytes(ip)
  if (!b) return false
  const [a, s] = b
  if (a === 0) return false // 0.0.0.0/8 "this network"
  if (a === 10) return false // RFC1918
  if (a === 100 && s >= 64 && s <= 127) return false // 100.64/10 CGNAT
  if (a === 127) return false // loopback
  if (a === 169 && s === 254) return false // link-local
  if (a === 172 && s >= 16 && s <= 31) return false // RFC1918
  if (a === 192 && s === 0 && (b[2] === 0 || b[2] === 2)) return false // 192.0.0/24 + TEST-NET-1
  if (a === 192 && s === 168) return false // RFC1918
  if (a === 198 && (s === 18 || s === 19)) return false // benchmark 198.18/15
  if (a === 198 && s === 51 && b[2] === 100) return false // TEST-NET-2
  if (a === 203 && s === 0 && b[2] === 113) return false // TEST-NET-3
  if (a >= 224) return false // multicast 224/4 + reserved 240/4 + broadcast
  return true
}

/** 展开 IPv6 到 16 字节；非法返回 null。支持 `::` 缩写与内嵌 IPv4 尾段。 */
function ipv6ToBytes(ip: string): number[] | null {
  let head = ip
  // 内嵌 IPv4（如 ::ffff:127.0.0.1）：先把尾段换算成两个 hextet。
  const v4Match = head.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (v4Match) {
    const v4 = ipv4ToBytes(v4Match[2])
    if (!v4) return null
    head = `${v4Match[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  const sections = head.split('::')
  if (sections.length > 2) return null
  const left = sections[0] ? sections[0].split(':') : []
  const right = sections.length === 2 && sections[1] ? sections[1].split(':') : []
  const missing = 8 - left.length - right.length
  if (sections.length === 2 ? missing < 0 : missing !== 0) return null
  const groups = [...left, ...Array.from({ length: sections.length === 2 ? missing : 0 }, () => '0'), ...right]
  if (groups.length !== 8) return null
  const bytes: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    const v = parseInt(g, 16)
    bytes.push(v >> 8, v & 0xff)
  }
  return bytes
}

function isPubliclyRoutableIpv6(ip: string): boolean {
  const b = ipv6ToBytes(ip)
  if (!b) return false
  const allZero = b.every(x => x === 0)
  if (allZero) return false // ::
  if (b.slice(0, 15).every(x => x === 0) && b[15] === 1) return false // ::1
  // IPv4-mapped（::ffff:0:0/96）与 IPv4-compatible（::/96）：按内嵌 v4 判定。
  if (b.slice(0, 10).every(x => x === 0) && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) {
    return isPubliclyRoutableIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`)
  }
  // NAT64 well-known 前缀 64:ff9b::/96：同样按内嵌 v4 判定。
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every(x => x === 0)) {
    return isPubliclyRoutableIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`)
  }
  if (b[0] === 0xff) return false // multicast ff00::/8
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return false // link-local fe80::/10
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return false // site-local fec0::/10（已废弃仍拒）
  if ((b[0] & 0xfe) === 0xfc) return false // ULA fc00::/7
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false // 2001:db8::/32 文档段
  return true
}

export function isPubliclyRoutableIp(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return isPubliclyRoutableIpv4(ip)
  if (family === 6) return isPubliclyRoutableIpv6(ip)
  return false
}

// ---------- URL 校验（配置保存 + 每次外呼双重执行） ----------

function insecureAllowed(): boolean {
  return config.autoProvisionAllowInsecureTargets
}

/** 校验并规范化 webhook URL；不合法抛 WebhookTargetError（code 即脱敏诊断码）。 */
export function validateWebhookUrl(rawUrl: string): URL {
  if (rawUrl.length > WEBHOOK_MAX_URL_LENGTH) {
    throw new WebhookTargetError('url_invalid', '回调地址过长')
  }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new WebhookTargetError('url_invalid', '回调地址格式无效')
  }
  // 硬验收 ⑦：禁 userinfo——`https://user:pass@host/` 形态直接拒绝。
  if (url.username !== '' || url.password !== '') {
    throw new WebhookTargetError('url_invalid', '回调地址不允许携带用户名密码')
  }
  if (url.protocol !== 'https:' && !(insecureAllowed() && url.protocol === 'http:')) {
    throw new WebhookTargetError('url_invalid', '回调地址必须使用 https')
  }
  if (url.port !== '' && url.port !== '443' && !insecureAllowed()) {
    throw new WebhookTargetError('url_invalid', '回调地址仅允许 443 端口')
  }
  // IP 字面量主机：无 DNS 环节，直接按公网可路由判定。
  const bareHost = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(bareHost) !== 0 && !insecureAllowed() && !isPubliclyRoutableIp(bareHost)) {
    throw new WebhookTargetError('dns_blocked', '回调地址指向内网或保留地址')
  }
  return url
}

// ---------- 连接期钉扎 lookup（每次建连都重新解析并校验） ----------

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void

function pinnedLookup(hostname: string, options: { all?: boolean }, callback: LookupCallback): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, '')
    const list = addresses as LookupAddress[]
    if (list.length === 0) {
      const e: NodeJS.ErrnoException = new Error(`no address for ${hostname}`)
      e.code = 'ENOTFOUND'
      return callback(e, '')
    }
    // 任一解析结果命中保留段即整体拒绝——多 A 记录混入内网地址不给机会。
    if (!insecureAllowed()) {
      const blocked = list.find(a => !isPubliclyRoutableIp(a.address))
      if (blocked) {
        const e: NodeJS.ErrnoException = new WebhookTargetError(
          'dns_blocked',
          `webhook host resolves to a non-routable address`
        ) as NodeJS.ErrnoException
        return callback(e, '')
      }
    }
    if (options.all) return callback(null, list)
    callback(null, list[0].address, list[0].family)
  })
}

// ---------- 签名（Stripe 风格 t.v1） ----------

export function signWebhookPayload(secret: string, rawBody: string, timestampSec: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`).digest('hex')
  return `t=${timestampSec},v1=${mac}`
}

/** 接收端参考实现（运维文档引用 + 测试向量用）；tolerance 秒内防重放。 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string,
  nowSec: number,
  toleranceSec = 300
): boolean {
  const match = header.match(/^t=(\d+),v1=([0-9a-f]{64})$/)
  if (!match) return false
  const t = Number(match[1])
  if (Math.abs(nowSec - t) > toleranceSec) return false
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(match[2], 'hex'))
}

// ---------- 外呼 ----------

export interface WebhookCallResult {
  status: number
  body: string
}

/**
 * 发起一次外呼。URL 在此再次全量校验（钉扎 lookup 在建连处第三次校验解析
 * 结果）。绝不跟随重定向；HTTP 层失败/超时/超限一律抛 WebhookTargetError
 * 或底层错误——调用方用 classifyWebhookFailure 归类为脱敏诊断码。
 */
export function callWebhook(rawUrl: string, rawBody: string, signatureHeader: string): Promise<WebhookCallResult> {
  const url = validateWebhookUrl(rawUrl)
  const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise<WebhookCallResult>((resolve, reject) => {
    const req = doRequest(
      url,
      {
        method: 'POST',
        // 钉扎：lookup 里校验全部解析地址；TLS servername 保持默认 = URL
        // 主机名，证书校验按原域名进行（绝不按 IP 校验）。
        lookup: pinnedLookup as never,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(rawBody),
          'x-monexus-signature': signatureHeader,
        },
        timeout: WEBHOOK_TIMEOUT_MS,
      },
      res => {
        // 3xx 一律失败：不跟随重定向（重定向可指向未校验目标）。
        const status = res.statusCode ?? 0
        const chunks: Buffer[] = []
        let received = 0
        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > WEBHOOK_MAX_RESPONSE_BYTES) {
            req.destroy(new WebhookTargetError('body_too_large', 'webhook response exceeds size limit'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      }
    )
    req.on('timeout', () => {
      req.destroy(new WebhookTargetError('timeout', 'webhook call timed out'))
    })
    req.on('error', reject)
    req.end(rawBody)
  })
}

/** 把任意外呼失败归类为脱敏诊断码（落 ProvisionTask.lastError，绝不带远端内容）。 */
export function classifyWebhookFailure(err: unknown): string {
  if (err instanceof WebhookTargetError) return err.code
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_error'
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return 'connect_error'
  }
  if (typeof code === 'string' && code.startsWith('ERR_TLS')) return 'tls_error'
  if ((err as Error)?.message?.includes('certificate')) return 'tls_error'
  return 'request_error'
}
