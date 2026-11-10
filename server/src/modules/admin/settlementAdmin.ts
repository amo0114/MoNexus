import {
  applyRecoveryAction,
  executeSettlementBatch,
  getSettlementBatch,
  listRecoveryCases,
  listSettlementBatches,
  listSettlementEntries,
  previewSettlementBatch,
  type RecoveryActionKind,
} from '../merchantFinance/index.js'

// Thin admin adapters: permissions/MFA/DTO validation live in routes; the
// financial rules and lock order live in merchantFinance.

export async function listAllSettlements(status?: string, page = 1, pageSize = 20) {
  return listSettlementEntries({ status, page, pageSize })
}

export async function batchSettle(adminUserId: number, settlementIds: number[], requestKey?: string) {
  return executeSettlementBatch(adminUserId, settlementIds, requestKey)
}

export async function previewSettlements(settlementIds: number[]) {
  return previewSettlementBatch(settlementIds)
}

export async function listBatches(page = 1, pageSize = 20) {
  return listSettlementBatches(page, pageSize)
}

export async function getBatch(batchId: number) {
  return getSettlementBatch(batchId)
}

export async function listMerchantRecoveryCases(query: { merchantId?: number; status?: string; page?: number; pageSize?: number }) {
  return listRecoveryCases(query)
}

export async function actOnMerchantRecovery(adminUserId: number, caseId: number, input: {
  kind: RecoveryActionKind
  amount: number
  requestKey: string
  evidence?: string
  note?: string
}) {
  return applyRecoveryAction({ ...input, caseId, actorUserId: adminUserId })
}
