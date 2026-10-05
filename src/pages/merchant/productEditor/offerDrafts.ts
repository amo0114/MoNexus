import type { ProductEditorOffer } from '../../../api/catalog'
import type { FulfillmentRule } from '../../../types/catalog'
import type { DeliveryField } from '../../../types/merchant'

export type OfferStructuredDraft = {
  deliveryFields: DeliveryField[]
  structuredFields: DeliveryField[]
  structuredValues: Record<string, string>
}

export function draftsFromOffers(offers: ProductEditorOffer[]): Record<number, OfferStructuredDraft> {
  const drafts: Record<number, OfferStructuredDraft> = {}
  for (const offer of offers) {
    const structured = parseStructuredContent(offer.fixedStructuredContent)
    drafts[offer.id] = {
      deliveryFields: parseDeliveryFields(offer.deliveryFields),
      structuredFields: structured.fields,
      structuredValues: structured.values,
    }
  }
  return drafts
}

export function reconcileOfferDrafts(
  previousDrafts: Record<number, OfferStructuredDraft>,
  previousOffers: ProductEditorOffer[],
  freshOffers: ProductEditorOffer[],
  requirementFor: (offer: ProductEditorOffer) => FulfillmentRule['requireStructuredDelivery'],
): { drafts: Record<number, OfferStructuredDraft>; conflictLabels: string[] } {
  const previousById = new Map(previousOffers.map(offer => [offer.id, offer]))
  const baselineDrafts = draftsFromOffers(previousOffers)
  const serverDrafts = draftsFromOffers(freshOffers)
  const next: Record<number, OfferStructuredDraft> = {}
  const conflictLabels: string[] = []
  for (const offer of freshOffers) {
    const previousOffer = previousById.get(offer.id)
    const previousDraft = previousDrafts[offer.id]
    const serverDraft = serverDrafts[offer.id]
    if (!previousOffer || !previousDraft) {
      next[offer.id] = serverDraft
      continue
    }
    const previousRequirement = requirementFor(previousOffer)
    const nextRequirement = requirementFor(offer)
    if (previousRequirement !== nextRequirement) {
      next[offer.id] = serverDraft
      continue
    }
    next[offer.id] = mergeOfferStructuredDraft(
      previousDraft,
      baselineDrafts[offer.id] ?? serverDraft,
      serverDraft,
      conflictLabels,
    )
  }
  return { drafts: next, conflictLabels }
}

function mergeOfferStructuredDraft(
  local: OfferStructuredDraft,
  baseline: OfferStructuredDraft,
  server: OfferStructuredDraft,
  conflictLabels: string[],
): OfferStructuredDraft {
  const structured = mergeKeyedStructured(local, baseline, server, conflictLabels)
  const deliveryFields = mergeFieldList(
    local.deliveryFields,
    baseline.deliveryFields,
    server.deliveryFields,
    conflictLabels,
  )
  return {
    deliveryFields,
    structuredFields: structured.fields,
    structuredValues: structured.values,
  }
}

function mergeKeyedStructured(
  local: OfferStructuredDraft,
  baseline: OfferStructuredDraft,
  server: OfferStructuredDraft,
  conflictLabels: string[],
): { fields: DeliveryField[]; values: Record<string, string> } {
  const localByKey = indexFieldsByKey(local.structuredFields)
  const baselineByKey = indexFieldsByKey(baseline.structuredFields)
  const serverByKey = indexFieldsByKey(server.structuredFields)
  const fields: DeliveryField[] = []
  const values: Record<string, string> = {}
  for (const key of orderedFieldKeys(server.structuredFields, local.structuredFields, baseline.structuredFields)) {
    const localField = localByKey.get(key)
    const baselineField = baselineByKey.get(key)
    const serverField = serverByKey.get(key)
    const localVal = local.structuredValues[key] ?? ''
    const baselineVal = baseline.structuredValues[key] ?? ''
    const serverVal = server.structuredValues[key] ?? ''
    const localPresent = localField != null
    const baselinePresent = baselineField != null
    const serverPresent = serverField != null
    const label = localField?.label || serverField?.label || baselineField?.label || key
    const localChanged = localPresent !== baselinePresent
      || !sameJson(localField ?? null, baselineField ?? null)
      || localVal !== baselineVal
    const serverChanged = serverPresent !== baselinePresent
      || !sameJson(serverField ?? null, baselineField ?? null)
      || serverVal !== baselineVal

    if (!localChanged && !serverChanged) {
      if (serverPresent && serverField) {
        fields.push(serverField)
        values[key] = serverVal
      }
      continue
    }
    if (localChanged && !serverChanged) {
      if (localPresent && localField) {
        fields.push(localField)
        values[key] = localVal
      }
      continue
    }
    if (!localChanged && serverChanged) {
      if (serverPresent && serverField) {
        fields.push(serverField)
        values[key] = serverVal
      }
      continue
    }
    if (localPresent && serverPresent && localField && serverField
      && sameJson(localField, serverField) && localVal === serverVal) {
      fields.push(serverField)
      values[key] = serverVal
      continue
    }
    rememberConflictLabel(conflictLabels, label)
    if (serverPresent && serverField) {
      fields.push(serverField)
      values[key] = serverVal
    } else if (localPresent && localField) {
      fields.push(localField)
      values[key] = localVal
    }
  }
  return { fields, values }
}

function mergeFieldList(
  localFields: DeliveryField[],
  baselineFields: DeliveryField[],
  serverFields: DeliveryField[],
  conflictLabels: string[],
): DeliveryField[] {
  const localByKey = indexFieldsByKey(localFields)
  const baselineByKey = indexFieldsByKey(baselineFields)
  const serverByKey = indexFieldsByKey(serverFields)
  const merged: DeliveryField[] = []
  for (const key of orderedFieldKeys(serverFields, localFields, baselineFields)) {
    const localField = localByKey.get(key)
    const baselineField = baselineByKey.get(key)
    const serverField = serverByKey.get(key)
    const localPresent = localField != null
    const baselinePresent = baselineField != null
    const serverPresent = serverField != null
    const label = localField?.label || serverField?.label || baselineField?.label || key

    if (localPresent && !baselinePresent && !serverPresent) {
      merged.push(localField)
      continue
    }
    if (!localPresent && !baselinePresent && serverPresent) {
      merged.push(serverField)
      continue
    }
    if (localPresent && !baselinePresent && serverPresent) {
      const result = threeWayMerge(localField, null, serverField)
      if (result.conflict) rememberConflictLabel(conflictLabels, label)
      merged.push(result.value ?? serverField)
      continue
    }
    if (!localPresent && baselinePresent && serverPresent) {
      if (sameJson(serverField, baselineField)) continue
      rememberConflictLabel(conflictLabels, label)
      merged.push(serverField)
      continue
    }
    if (localPresent && baselinePresent && !serverPresent) {
      if (sameJson(localField, baselineField)) continue
      rememberConflictLabel(conflictLabels, label)
      merged.push(localField)
      continue
    }
    if (!localPresent && baselinePresent && !serverPresent) continue
    if (localPresent && baselinePresent && serverPresent) {
      const result = threeWayMerge(localField, baselineField, serverField)
      if (result.conflict) rememberConflictLabel(conflictLabels, label)
      merged.push(result.value ?? serverField)
    }
  }
  return merged
}

function orderedFieldKeys(
  serverFields: DeliveryField[],
  localFields: DeliveryField[],
  baselineFields: DeliveryField[],
): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const field of [...serverFields, ...localFields, ...baselineFields]) {
    if (!field.key || seen.has(field.key)) continue
    seen.add(field.key)
    keys.push(field.key)
  }
  return keys
}

export function cloneOfferStructuredDraft(draft: OfferStructuredDraft): OfferStructuredDraft {
  return {
    deliveryFields: draft.deliveryFields.map(field => ({ ...field })),
    structuredFields: draft.structuredFields.map(field => ({ ...field })),
    structuredValues: { ...draft.structuredValues },
  }
}

function threeWayMerge<T>(
  local: T,
  baseline: T,
  server: T,
): { value: T; conflict: boolean } {
  if (sameJson(local, server)) return { value: server, conflict: false }
  if (!sameJson(local, baseline) && sameJson(server, baseline)) {
    return { value: local, conflict: false }
  }
  if (sameJson(local, baseline) && !sameJson(server, baseline)) {
    return { value: server, conflict: false }
  }
  return { value: server, conflict: true }
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  return JSON.stringify(left) === JSON.stringify(right)
}

function indexFieldsByKey(fields: DeliveryField[]): Map<string, DeliveryField> {
  const byKey = new Map<string, DeliveryField>()
  for (const field of fields) {
    if (field.key) byKey.set(field.key, field)
  }
  return byKey
}

function rememberConflictLabel(labels: string[], label: string) {
  const text = label.trim()
  if (!text || labels.includes(text)) return
  labels.push(text)
}

export function parseDeliveryFields(raw: unknown): DeliveryField[] {
  if (!Array.isArray(raw)) return []
  const fields: DeliveryField[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.key !== 'string' || typeof record.label !== 'string') continue
    fields.push({
      key: record.key,
      label: record.label,
      sensitive: record.sensitive === true,
      ...(typeof record.placeholder === 'string' ? { placeholder: record.placeholder } : {}),
    })
  }
  return fields
}

export function parseStructuredContent(raw: unknown): { fields: DeliveryField[]; values: Record<string, string> } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { fields: [], values: {} }
  const record = raw as { fields?: unknown; values?: unknown }
  const values: Record<string, string> = {}
  if (record.values && typeof record.values === 'object' && !Array.isArray(record.values)) {
    for (const [key, value] of Object.entries(record.values as Record<string, unknown>)) {
      if (typeof value === 'string') values[key] = value
    }
  }
  return { fields: parseDeliveryFields(record.fields), values }
}
