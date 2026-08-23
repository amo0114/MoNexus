import { badRequest } from '../../../lib/httpError.js'
import type { FormPostAction } from './types.js'

export const FORM_POST_MAX_FIELDS = 32
export const FORM_POST_MAX_NAME_LENGTH = 64
export const FORM_POST_MAX_VALUE_LENGTH = 1024
export const FORM_POST_MAX_TOTAL_BYTES = 8192
export const FORM_POST_FIELD_NAME = /^[A-Za-z0-9_.-]{1,64}$/

const HTML_MARKERS = /<\s*\/?\s*[a-z!][\s\S]*>/i

export type FormPostAllowlist = {
  hosts: readonly string[]
}

function looksLikeHtml(value: string): boolean {
  return HTML_MARKERS.test(value) || /javascript:/i.test(value)
}

/**
 * V1 form_post is a structured action only. Reject HTML documents, non-HTTPS
 * URLs, hosts outside the provider allowlist, and oversized fields.
 */
export function assertStructuredFormPost(
  action: Pick<FormPostAction, 'actionUrl' | 'method' | 'fields'>,
  allowlist: FormPostAllowlist,
): FormPostAction['fields'] {
  if (action.method !== 'POST') {
    throw badRequest('form_post method must be POST')
  }
  if (typeof action.actionUrl !== 'string' || action.actionUrl.length === 0) {
    throw badRequest('form_post actionUrl is required')
  }
  if (looksLikeHtml(action.actionUrl) || action.actionUrl.includes('<')) {
    throw badRequest('form_post must not include HTML')
  }

  let parsed: URL
  try {
    parsed = new URL(action.actionUrl)
  } catch {
    throw badRequest('form_post actionUrl is not a valid URL')
  }
  if (parsed.protocol !== 'https:') {
    throw badRequest('form_post actionUrl must use https')
  }
  const host = parsed.hostname.toLowerCase()
  const allowed = new Set(allowlist.hosts.map(entry => entry.toLowerCase()))
  if (!allowed.has(host)) {
    throw badRequest('form_post actionUrl host is not allowlisted')
  }

  const fields = action.fields
  if (fields == null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw badRequest('form_post fields must be a string map')
  }
  const keys = Object.keys(fields)
  if (keys.length > FORM_POST_MAX_FIELDS) {
    throw badRequest('form_post has too many fields')
  }

  let totalBytes = Buffer.byteLength(action.actionUrl, 'utf8')
  const normalized: Record<string, string> = {}
  for (const key of keys) {
    if (key.length > FORM_POST_MAX_NAME_LENGTH || !FORM_POST_FIELD_NAME.test(key)) {
      throw badRequest('form_post field name is invalid')
    }
    const value = fields[key]
    if (typeof value !== 'string') {
      throw badRequest('form_post field values must be strings')
    }
    if (value.length > FORM_POST_MAX_VALUE_LENGTH) {
      throw badRequest('form_post field value exceeds size limit')
    }
    if (looksLikeHtml(key) || looksLikeHtml(value)) {
      throw badRequest('form_post must not include HTML')
    }
    totalBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8')
    normalized[key] = value
  }
  if (totalBytes > FORM_POST_MAX_TOTAL_BYTES) {
    throw badRequest('form_post payload exceeds size limit')
  }
  return normalized
}
