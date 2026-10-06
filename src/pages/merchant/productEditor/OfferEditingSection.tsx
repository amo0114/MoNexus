import type { ProductEditorActor, ProductEditorOffer } from '../../../api/catalog'
import type { ProductTemplateDefinition, TemplateAttributes } from '../../../types/catalog'
import OfferEditingRow from './OfferEditingRow'
import type { OfferStructuredDraft } from './offerDrafts'

interface Props {
  actor: ProductEditorActor
  offers: ProductEditorOffer[]
  busy: boolean
  bindingOfferId: number | null
  conflictLabels: string[]
  selectedTemplate: ProductTemplateDefinition | null
  productAttributes: TemplateAttributes
  offerDrafts: Record<number, OfferStructuredDraft>
  offerFileLabelById: Record<number, string>
  onOfferFileChange: (offerId: number, file: File | null) => void
  onBindOfferFile: (offer: ProductEditorOffer) => void
  onDraftChange: (offerId: number, draft: OfferStructuredDraft, patch: Partial<OfferStructuredDraft>) => void
}

export default function OfferEditingSection({
  actor,
  offers,
  busy,
  bindingOfferId,
  conflictLabels,
  selectedTemplate,
  productAttributes,
  offerDrafts,
  offerFileLabelById,
  onOfferFileChange,
  onBindOfferFile,
  onDraftChange,
}: Props) {
  return (    <section className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] p-5 sm:p-8 space-y-3" data-testid="product-edit-offers">
      <h2 className="font-heading text-lg font-bold text-[var(--color-text)]">套餐</h2>
      <p className="text-sm text-[var(--color-text-muted)]">
        {actor === 'merchant'
          ? '套餐价格与库存仍使用商品列表中的「规格管理」。文件交付规格可在本页挂载交付文件。'
          : '套餐价格、交付与库存仍使用商品列表中的「规格管理」。本页不改写套餐商业字段。'}
      </p>
      {conflictLabels.length > 0 && (
        <div
          className="rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-3 py-2 text-sm text-[var(--color-text)]"
          data-testid="product-edit-offer-conflicts"
        >
          以下字段与其他会话冲突，已采用最新规格内容：{conflictLabels.join('、')}
        </div>
      )}
      {offers.length > 0 && (
        <ul className="space-y-2">
          {offers.map(offer => {
            const draft = offerDrafts[offer.id]
            return (
              <OfferEditingRow
                key={offer.id}
                offer={offer}
                actor={actor}
                busy={busy}
                bindingOfferId={bindingOfferId}
                selectedTemplate={selectedTemplate}
                productAttributes={productAttributes}
                draft={draft}
                fileLabel={offerFileLabelById[offer.id]}
                onFileChange={(file) => onOfferFileChange(offer.id, file)}
                onBindFile={() => onBindOfferFile(offer)}
                onDraftChange={(patch) => {
                  if (draft) onDraftChange(offer.id, draft, patch)
                }}
              />
            )
          })}
        </ul>
      )}
    </section>
  )
}
