import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import {
  __setWebhookDnsResolverForTests,
  assertResolvedWebhookTarget,
  classifyWebhookFailure,
  callWebhook,
  isPubliclyRoutableIp,
  signWebhookPayload,
  validateWebhookUrl,
  verifyWebhookSignature,
  WebhookTargetError,
} from '../lib/outboundWebhook.js'
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  generateWebhookSecret,
  maskWebhookSecret,
} from '../lib/webhookSecret.js'

/**
 * P7b B-T6 纯函数与安全边界层：签名向量、SSRF 可路由矩阵、URL 校验、
 * 连接期钉扎（DNS rebinding 双解析）、密钥加解密往返。无 DB、无 mock。
 */

describe('P7b webhook signature (硬验收 ⑦ 接收端参考实现)', () => {
  const secret = 'a'.repeat(64)
  const body = JSON.stringify({ taskId: 7, orderId: 42, content: undefined })
  const t = 1_700_000_000

  it('signs in Stripe-style t=<sec>,v1=<64hex> wire format', () => {
    const sig = signWebhookPayload(secret, body, t)
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
    expect(sig.startsWith(`t=${t},v1=`)).toBe(true)
  })

  it('signature bytes match the DOCUMENTED formula HMAC-SHA256(secret, `${t}.${body}`)', () => {
    // 独立复算文档约定的签名串——若有人改了分隔符/编码,这里会与实现分叉。
    const sig = signWebhookPayload(secret, body, t)
    const documented = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
    expect(sig).toBe(`t=${t},v1=${documented}`)
  })

  it('verify accepts a fresh matching signature', () => {
    const sig = signWebhookPayload(secret, body, t)
    expect(verifyWebhookSignature(secret, body, sig, t)).toBe(true)
    // 容差内的时钟漂移仍接受。
    expect(verifyWebhookSignature(secret, body, sig, t + 299)).toBe(true)
  })

  it('verify rejects tampered body, wrong secret, replay window, and malformed header', () => {
    const sig = signWebhookPayload(secret, body, t)
    expect(verifyWebhookSignature(secret, `${body} `, sig, t)).toBe(false)
    expect(verifyWebhookSignature('b'.repeat(64), body, sig, t)).toBe(false)
    // 超出 300s 默认容差 → 防重放拒绝。
    expect(verifyWebhookSignature(secret, body, sig, t + 301)).toBe(false)
    expect(verifyWebhookSignature(secret, body, sig, t - 301)).toBe(false)
    // 大写十六进制不符合 [0-9a-f]{64} 契约。
    expect(verifyWebhookSignature(secret, body, sig.toUpperCase(), t)).toBe(false)
    expect(verifyWebhookSignature(secret, body, 'garbage', t)).toBe(false)
    expect(verifyWebhookSignature(secret, body, `t=${t},v1=short`, t)).toBe(false)
  })
})

describe('P7b isPubliclyRoutableIp 矩阵 (硬验收 ⑦)', () => {
  const publicV4 = ['8.8.8.8', '1.1.1.1', '203.0.112.1', '198.20.0.1', '9.9.9.9']
  const privateOrReservedV4 = [
    '0.0.0.0', '0.1.2.3', // 0/8
    '10.0.0.1', '10.255.255.255', // RFC1918
    '100.64.0.1', '100.127.255.255', // CGNAT 100.64/10
    '127.0.0.1', // loopback
    '169.254.1.1', // link-local
    '172.16.0.1', '172.31.255.255', // RFC1918
    '192.0.0.1', '192.0.2.5', // 192.0.0/24 + TEST-NET-1
    '192.168.1.1', // RFC1918
    '198.18.0.1', '198.19.255.255', // benchmark
    '198.51.100.7', // TEST-NET-2
    '203.0.113.9', // TEST-NET-3
    '224.0.0.1', '239.1.1.1', '255.255.255.255', // multicast/reserved/broadcast
  ]
  const publicV6 = ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']
  const privateOrReservedV6 = [
    '::', '::1', // unspecified/loopback
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:192.168.1.1', // v4-mapped 内嵌私网
    '::ffff:169.254.0.1', // v4-mapped link-local
    '64:ff9b::7f00:1', // NAT64 内嵌 127.0.0.1
    'fe80::1', // link-local
    'fec0::1', // site-local (deprecated)
    'fc00::1', 'fd12:3456::1', // ULA fc00::/7
    'ff02::1', // multicast
    '2001:db8::1', // documentation
  ]

  it('accepts public v4/v6', () => {
    for (const ip of [...publicV4, ...publicV6]) expect(isPubliclyRoutableIp(ip)).toBe(true)
  })
  it('rejects private/reserved v4', () => {
    for (const ip of privateOrReservedV4) expect(isPubliclyRoutableIp(ip)).toBe(false)
  })
  it('rejects private/reserved/mapped v6', () => {
    for (const ip of privateOrReservedV6) expect(isPubliclyRoutableIp(ip)).toBe(false)
  })
  it('rejects non-IP strings', () => {
    for (const s of ['', 'not-an-ip', '999.1.1.1', 'example.com']) expect(isPubliclyRoutableIp(s)).toBe(false)
  })
})

describe('P7b validateWebhookUrl (硬验收 ⑦: https/443/no-userinfo/no-private-literal)', () => {
  it('accepts https public host and https public IP literal', () => {
    expect(validateWebhookUrl('https://hook.example.com/provision').hostname).toBe('hook.example.com')
    expect(validateWebhookUrl('https://8.8.8.8/x').hostname).toBe('8.8.8.8')
    // 显式 :443 被 WHATWG URL 规范化为默认端口(port===''),仍是被接受的 https。
    expect(validateWebhookUrl('https://host.example.com:443/x').port).toBe('')
  })

  it('rejects http scheme (no escape hatch in test env)', () => {
    expect(config.autoProvisionAllowInsecureTargets).toBe(false)
    expect(() => validateWebhookUrl('http://hook.example.com/x')).toThrow(WebhookTargetError)
    try {
      validateWebhookUrl('http://hook.example.com/x')
    } catch (err) {
      expect((err as WebhookTargetError).code).toBe('url_invalid')
    }
  })

  it('rejects userinfo, non-443 port, over-length, and private IP literal', () => {
    expect(() => validateWebhookUrl('https://user:pass@hook.example.com/x')).toThrow(/用户名密码/)
    expect(() => validateWebhookUrl('https://hook.example.com:8443/x')).toThrow(/443/)
    expect(() => validateWebhookUrl(`https://hook.example.com/${'a'.repeat(2100)}`)).toThrow(WebhookTargetError)
    // 私网/保留 IP 字面量 → dns_blocked。
    for (const u of ['https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://[::1]/x', 'https://[fc00::1]/x']) {
      try {
        validateWebhookUrl(u)
        throw new Error(`expected ${u} to be blocked`)
      } catch (err) {
        expect(err).toBeInstanceOf(WebhookTargetError)
        expect((err as WebhookTargetError).code).toBe('dns_blocked')
      }
    }
  })
})

describe('P7b connect-time pinning (硬验收 ⑦: DNS rebinding blocked at each connect)', () => {
  it('blocks a public-looking hostname that resolves to loopback', async () => {
    // localhost 通过 URL 校验(非 IP 字面量),但连接期钉扎 lookup 解析到
    // 127.0.0.1 → 整体拒绝。这正是 DNS rebinding 的防线(硬验收 ⑦)。
    expect(config.autoProvisionAllowInsecureTargets).toBe(false)
    const sig = signWebhookPayload('s'.repeat(64), '{}', 1)
    await expect(callWebhook('https://localhost/hook', '{}', sig)).rejects.toBeInstanceOf(WebhookTargetError)
    try {
      await callWebhook('https://localhost/hook', '{}', sig)
    } catch (err) {
      expect(classifyWebhookFailure(err)).toBe('dns_blocked')
    }
  })
})

describe('P7b save-time DNS resolution (复审 P2: 保存时 + 连接时双重校验)', () => {
  afterEach(() => {
    __setWebhookDnsResolverForTests(null)
  })

  it('rejects https://localhost at save time — resolves to loopback (real resolver)', async () => {
    // 复审场景原文:https://localhost 能保存、直到真正外呼才失败。修复后
    // 保存时即解析并拒绝。localhost 由 /etc/hosts 解析,无外网依赖。
    await expect(assertResolvedWebhookTarget(new URL('https://localhost/hook')))
      .rejects.toMatchObject({ code: 'dns_blocked' })
  })

  it('rejects when ANY resolved address is non-routable (multi-A poisoning)', async () => {
    __setWebhookDnsResolverForTests(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ])
    await expect(assertResolvedWebhookTarget(new URL('https://hook.example.com/x')))
      .rejects.toMatchObject({ code: 'dns_blocked' })
  })

  it('passes an all-public resolution and skips IP literals (already validated)', async () => {
    __setWebhookDnsResolverForTests(async () => [{ address: '93.184.216.34', family: 4 }])
    await expect(assertResolvedWebhookTarget(new URL('https://hook.example.com/x'))).resolves.toBeUndefined()
    // IP 字面量不走解析器(validateWebhookUrl 已判):resolver 抛错也不影响。
    __setWebhookDnsResolverForTests(async () => {
      throw new Error('resolver must not be called for IP literals')
    })
    await expect(assertResolvedWebhookTarget(new URL('https://93.184.216.34/x'))).resolves.toBeUndefined()
  })

  it('maps NXDOMAIN / resolver failure to dns_error (settable at save, not first call)', async () => {
    __setWebhookDnsResolverForTests(async () => {
      const e: NodeJS.ErrnoException = new Error('getaddrinfo ENOTFOUND')
      e.code = 'ENOTFOUND'
      throw e
    })
    await expect(assertResolvedWebhookTarget(new URL('https://no-such-host.example.invalid/x')))
      .rejects.toMatchObject({ code: 'dns_error' })
  })
})

describe('P7b webhookSecret AES-256-GCM (硬验收 ⑤)', () => {
  it('round-trips a generated secret', () => {
    const secret = generateWebhookSecret()
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    const ct = encryptWebhookSecret(secret)
    expect(ct.startsWith('v1:')).toBe(true)
    expect(ct).not.toContain(secret) // 密文不得含明文
    expect(decryptWebhookSecret(ct)).toBe(secret)
  })

  it('produces distinct ciphertexts for the same plaintext (random IV)', () => {
    const secret = generateWebhookSecret()
    expect(encryptWebhookSecret(secret)).not.toBe(encryptWebhookSecret(secret))
  })

  it('throws loudly on tampered ciphertext (GCM auth tag) and bad format', () => {
    const ct = encryptWebhookSecret(generateWebhookSecret())
    const [v, iv, tag, body] = ct.split(':')
    const flipped = body.slice(0, -1) + (body.endsWith('0') ? '1' : '0')
    expect(() => decryptWebhookSecret(`${v}:${iv}:${tag}:${flipped}`)).toThrow()
    expect(() => decryptWebhookSecret('v9:x:y:z')).toThrow(/format invalid/)
    expect(() => decryptWebhookSecret('not-a-ciphertext')).toThrow(/format invalid/)
  })

  it('masks to last 4 only', () => {
    expect(maskWebhookSecret('0123456789abcdef')).toBe('****cdef')
  })
})
