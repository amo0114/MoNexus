import { yuanStringToAmountMinor } from './amount.js'
import type { VmqfoxGetData, VmqfoxQueryByPayIdData } from './client.js'
import { paymentMethodFromPayType, type VmqfoxAdapterConfig } from './config.js'
import type { NormalizedPayment } from '../types.js'

export type VmqfoxRemoteState = -1 | 0 | 1 | 2

export function mapVmqfoxState(state: number): NormalizedPayment['status'] | null {
  if (state === -1) return 'cancelled'
  if (state === 0) return 'processing'
  if (state === 1 || state === 2) return 'succeeded'
  return null
}

export function isVmqfoxRemoteState(state: number): state is VmqfoxRemoteState {
  return state === -1 || state === 0 || state === 1 || state === 2
}

export function immutableStateVersion(state: number, payId: string, reallyPrice: string): string {
  return `${state}:${payId}:${reallyPrice}`
}

export function paymentFromQuery(
  config: VmqfoxAdapterConfig,
  payId: string,
  data: VmqfoxQueryByPayIdData,
): NormalizedPayment {
  const status = mapVmqfoxState(data.status) ?? 'unknown'
  const method = paymentMethodFromPayType(String(data.type))
  return {
    status,
    providerPaymentId: payId,
    providerOrderId: data.publicToken,
    providerCaptureId: null,
    amountMinor: yuanStringToAmountMinor(data.reallyPrice),
    quotedAmountMinor: yuanStringToAmountMinor(data.price),
    quotedPaymentMethod: method ?? undefined,
    currency: 'CNY',
    providerAccountKey: config.accountKey,
    immutableStateVersion: immutableStateVersion(data.status, payId, data.reallyPrice),
    rawStatus: String(data.status),
  }
}

export function paymentFromGet(
  config: VmqfoxAdapterConfig,
  data: VmqfoxGetData,
): NormalizedPayment {
  const status = mapVmqfoxState(data.state) ?? 'unknown'
  const method = paymentMethodFromPayType(String(data.payType))
  return {
    status,
    providerPaymentId: data.payId,
    providerCaptureId: null,
    amountMinor: yuanStringToAmountMinor(data.reallyPrice),
    quotedAmountMinor: yuanStringToAmountMinor(data.price),
    quotedPaymentMethod: method ?? undefined,
    currency: 'CNY',
    providerAccountKey: config.accountKey,
    immutableStateVersion: immutableStateVersion(data.state, data.payId, data.reallyPrice),
    rawStatus: String(data.state),
  }
}
