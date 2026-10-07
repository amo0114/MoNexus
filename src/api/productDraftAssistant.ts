import api from './client'
import type { ProductEditorActor } from './catalog'
import type { ProductDetails, TemplateAttributes, TemplateKey } from '../types/catalog'

export type ProductDraftSuggestion = {
  templateKey: TemplateKey | null
  categoryId: number | null
  name: string | null
  description: string | null
  offerName: string | null
  attributes: TemplateAttributes
  offerAttributes: TemplateAttributes
  details: ProductDetails
}
export type ProductDraftSuggestionResponse = {
  generationId: number
  suggestion: ProductDraftSuggestion
  missingFields: string[]
  rejectedFieldCount: number
  truncated: boolean
}
export async function getDraftAssistantAvailability(actor: ProductEditorActor): Promise<boolean> {
  const { data } = await api.get<{ available: boolean }>(`/${actor}/products/draft-assistant`)
  return data.available === true
}
export async function requestProductDraftSuggestion(actor: ProductEditorActor, description: string, signal: AbortSignal) {
  const { data } = await api.post<ProductDraftSuggestionResponse>(
    `/${actor}/products/draft-suggestions`, { description }, { timeout: 55_000, signal },
  )
  return data
}
