import { serializeAmountMinor } from './money.js'
import type { PaymentAction } from '../payment/providers/types.js'

export function moneyFields<T extends Record<string, bigint>>(fields: T): { [K in keyof T]: string } {
  const result = {} as { [K in keyof T]: string }
  for (const key of Object.keys(fields) as Array<keyof T>) {
    result[key] = serializeAmountMinor(fields[key])
  }
  return result
}

export function publicPaymentAction(action: PaymentAction | null | undefined) {
  if (!action) return null
  if (action.type === 'none') return { type: 'none' as const }
  if (action.type === 'redirect') {
    return { type: 'redirect' as const, url: action.url, expiresAt: action.expiresAt }
  }
  if (action.type === 'qr_code') {
    return {
      type: 'qr_code' as const,
      content: action.content,
      display: action.display,
      expiresAt: action.expiresAt,
    }
  }
  if (action.type === 'client_secret') {
    return {
      type: 'client_secret' as const,
      clientSecret: action.clientSecret,
      expiresAt: action.expiresAt,
    }
  }
  return {
    type: 'form_post' as const,
    actionUrl: action.actionUrl,
    method: 'POST' as const,
    fields: action.fields,
    expiresAt: action.expiresAt,
  }
}

export function parseStoredAction(raw: string | null): PaymentAction | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as PaymentAction
  } catch {
    return null
  }
}
