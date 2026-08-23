import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  randomBytes,
} from 'node:crypto'

// WeChat Pay publishes Java/Go/PHP SDKs only; Node uses the platform crypto APIs those SDKs wrap.

export const WECHATPAY_AUTH_SCHEME = 'WECHATPAY2-SHA256-RSA2048'
export const WECHATPAY_SIGN_TEST_PREFIX = 'WECHATPAY/SIGNTEST/'
export const AES_GCM_KEY_BYTES = 32
export const AES_GCM_TAG_BYTES = 16
export const WEBHOOK_TIMESTAMP_MAX_SKEW_SEC = 5 * 60

export function buildRequestSignMessage(
  method: string,
  urlPathAndQuery: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  return `${method}\n${urlPathAndQuery}\n${timestamp}\n${nonce}\n${body}\n`
}

export function buildResponseSignMessage(timestamp: string, nonce: string, body: string): string {
  return `${timestamp}\n${nonce}\n${body}\n`
}

export function rsaSha256Sign(privateKeyPem: string, message: string): string {
  const signer = createSign('RSA-SHA256')
  signer.update(message)
  signer.end()
  return signer.sign(createPrivateKey(privateKeyPem), 'base64')
}

export function rsaSha256Verify(publicKeyOrCertPem: string, message: string, signatureB64: string): boolean {
  if (signatureB64.startsWith(WECHATPAY_SIGN_TEST_PREFIX)) return false
  try {
    const verifier = createVerify('RSA-SHA256')
    verifier.update(message)
    verifier.end()
    return verifier.verify(createPublicKey(publicKeyOrCertPem), signatureB64, 'base64')
  } catch {
    return false
  }
}

export function buildAuthorizationHeader(input: {
  mchid: string
  serialNo: string
  privateKeyPem: string
  method: string
  urlPathAndQuery: string
  body: string
  timestamp: string
  nonce: string
}): string {
  const message = buildRequestSignMessage(
    input.method,
    input.urlPathAndQuery,
    input.timestamp,
    input.nonce,
    input.body,
  )
  const signature = rsaSha256Sign(input.privateKeyPem, message)
  return `${WECHATPAY_AUTH_SCHEME} mchid="${input.mchid}",nonce_str="${input.nonce}",signature="${signature}",timestamp="${input.timestamp}",serial_no="${input.serialNo}"`
}

export function randomNonce(): string {
  return randomBytes(16).toString('hex')
}

export function unixTimestampSeconds(now: Date): string {
  return Math.floor(now.getTime() / 1000).toString()
}

export function isTimestampFresh(timestamp: string, now: Date, maxSkewSec = WEBHOOK_TIMESTAMP_MAX_SKEW_SEC): boolean {
  if (!/^[0-9]{1,16}$/.test(timestamp)) return false
  const ts = Number(timestamp)
  const skew = Math.abs(Math.floor(now.getTime() / 1000) - ts)
  return Number.isSafeInteger(ts) && skew <= maxSkewSec
}

function assertApiV3Key(apiV3Key: string): Buffer {
  const key = Buffer.from(apiV3Key, 'utf8')
  if (key.length !== AES_GCM_KEY_BYTES) {
    throw new Error('WECHAT_PAY_APIV3_KEY must be exactly 32 bytes')
  }
  return key
}

/** Official APIv3 resource decrypt: AES-256-GCM, 128-bit tag, UTF-8 key/nonce/AAD. */
export function decryptAesGcm(input: {
  apiV3Key: string
  nonce: string
  ciphertextB64: string
  associatedData: string
}): string {
  const key = assertApiV3Key(input.apiV3Key)
  const buf = Buffer.from(input.ciphertextB64, 'base64')
  if (buf.length <= AES_GCM_TAG_BYTES) {
    throw new Error('ciphertext too short')
  }
  const data = buf.subarray(0, buf.length - AES_GCM_TAG_BYTES)
  const tag = buf.subarray(buf.length - AES_GCM_TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(input.nonce, 'utf8'))
  decipher.setAAD(Buffer.from(input.associatedData, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

export function encryptAesGcm(input: {
  apiV3Key: string
  nonce: string
  plaintext: string
  associatedData: string
}): string {
  const key = assertApiV3Key(input.apiV3Key)
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(input.nonce, 'utf8'))
  cipher.setAAD(Buffer.from(input.associatedData, 'utf8'))
  const encrypted = Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([encrypted, tag]).toString('base64')
}

export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const expected = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== expected) continue
    if (Array.isArray(value)) return value[0] ?? ''
    return value ?? ''
  }
  return ''
}
