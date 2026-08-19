import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { AlipaySdk as AlipaySdkType } from 'alipay-sdk'
import { badRequest } from '../../../../lib/httpError.js'
import { assertStructuredFormPost } from '../formPost.js'
import type { FormPostAction } from '../types.js'
import type { AlipayAdapterConfig } from './config.js'
import { formPostHostsFor, gatewayHostOf } from './config.js'

const require = createRequire(import.meta.url)
const alipaySdkRoot = dirname(require.resolve('alipay-sdk/package.json'))
// Load compiled CJS so Vitest cannot pick the package "source" TypeScript export.
const { AlipaySdk } = require(join(alipaySdkRoot, 'dist/commonjs/index.js')) as {
  AlipaySdk: typeof AlipaySdkType
}

export type AlipaySdkSurface = {
  pageExecute(method: string, httpMethod: 'GET' | 'POST', params: Record<string, unknown>): string
  checkNotifySign(postData: Record<string, string>): boolean
  exec(
    method: string,
    params?: Record<string, unknown>,
    options?: { validateSign?: boolean },
  ): Promise<Record<string, unknown>>
}

export function createOfficialAlipaySdk(config: AlipayAdapterConfig): AlipaySdkSurface {
  const sdk = new AlipaySdk({
    appId: config.appId,
    privateKey: config.privateKey,
    gateway: config.gatewayUrl,
    signType: 'RSA2',
    keyType: 'PKCS1',
    camelcase: false,
    timeout: 8_000,
    ...(config.certs
      ? {
          appCertContent: config.certs.appCert,
          alipayPublicCertContent: config.certs.alipayCert,
          alipayRootCertContent: config.certs.rootCert,
        }
      : { alipayPublicKey: config.alipayPublicKey }),
  })
  return {
    pageExecute(method, httpMethod, params) {
      return sdk.pageExecute(method, httpMethod, params)
    },
    checkNotifySign(postData) {
      try {
        return sdk.checkNotifySign(postData)
      } catch {
        return false
      }
    },
    async exec(method, params, options) {
      return sdk.exec(method, params, { validateSign: options?.validateSign ?? true })
    },
  }
}

function looksLikeHtml(value: string): boolean {
  return /<\s*\/?\s*[a-z!][\s\S]*>/i.test(value) || /javascript:/i.test(value)
}

/**
 * Official pageExecute(POST) emits executable HTML. V1 only returns a
 * structured field map after HTTPS allowlist and size checks.
 */
export function structuredFormPostFromSignedUrl(
  signed: string,
  config: AlipayAdapterConfig,
): { actionUrl: string; fields: FormPostAction['fields'] } {
  if (typeof signed !== 'string' || signed.length === 0) {
    throw badRequest('alipay pageExecute returned an empty action')
  }
  if (looksLikeHtml(signed)) {
    throw badRequest('form_post must not include HTML')
  }

  let parsed: URL
  try {
    parsed = new URL(signed)
  } catch {
    throw badRequest('form_post actionUrl is not a valid URL')
  }

  const fields: Record<string, string> = {}
  for (const [key, value] of parsed.searchParams.entries()) {
    fields[key] = value
  }
  const actionUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  const allowHosts = new Set(formPostHostsFor(config.mode))
  allowHosts.add(gatewayHostOf(config.gatewayUrl))
  return {
    actionUrl,
    fields: assertStructuredFormPost({ actionUrl, method: 'POST', fields }, {
      hosts: [...allowHosts],
    }),
  }
}

export function pickString(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}
