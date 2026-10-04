import { Loader2 } from 'lucide-react'
import type { ProductEditorActor, ProductEditorOffer } from '../../../api/catalog'
import type { ProductTemplateDefinition, TemplateAttributes } from '../../../types/catalog'
import OfferDeliveryFieldsEditor from '../../../components/catalog/wizard/DeliveryFieldsEditor'
import OfferStructuredContentEditor from '../../../components/catalog/wizard/StructuredContentEditor'
import type { OfferStructuredDraft } from './offerDrafts'
import { offerStructuredRequirement, shouldEditDeliveryFields, shouldEditStructuredContent } from './offerRequirements'

interface Props {
  offer: ProductEditorOffer
  actor: ProductEditorActor
  busy: boolean
  bindingOfferId: number | null
  selectedTemplate: ProductTemplateDefinition | null
  productAttributes: TemplateAttributes
  draft: OfferStructuredDraft | undefined
  fileLabel: string | undefined
  onFileChange: (file: File | null) => void
  onBindFile: () => void
  onDraftChange: (patch: Partial<OfferStructuredDraft>) => void
}

export default function OfferEditingRow({
  offer,
  actor,
  busy,
  bindingOfferId,
  selectedTemplate,
  productAttributes,
  draft,
  fileLabel,
  onFileChange,
  onBindFile,
  onDraftChange,
}: Props) {
  const requirement = offerStructuredRequirement(offer, selectedTemplate, productAttributes)
  const showDeliveryFields = draft ? shouldEditDeliveryFields(offer, requirement) : false
  const showStructured = draft ? shouldEditStructuredContent(offer, requirement) : false
  const offerBusy = busy || actor !== 'merchant'

  return (
    <li
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm"
      data-testid={`product-edit-offer-${offer.id}`}
    >
      <span className="font-bold">{offer.name}</span>
      <span className="text-[var(--color-text-muted)] ml-2 font-mono">{offer.price} 积分</span>
      {offer.fixedContentType === 'file' && (
        <div className="mt-2 space-y-1.5">
          <p className="text-xs text-[var(--color-text-muted)]">
            {fileLabel ?? (offer.fixedFileId != null ? `文件 #${offer.fixedFileId}` : '尚未绑定交付文件')}
          </p>
          {actor === 'merchant' ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="file"
                className="input text-xs py-1"
                disabled={busy}
                onChange={(event) => {
                  onFileChange(event.target.files?.[0] ?? null)
                }}
                data-testid={`product-edit-offer-file-${offer.id}`}
              />
              <button
                type="button"
                className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-40"
                disabled={busy}
                onClick={onBindFile}
                data-testid={`product-edit-offer-file-bind-${offer.id}`}
              >
                {bindingOfferId === offer.id
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : (offer.fixedFileId ? '替换文件' : '挂载文件')}
              </button>
            </div>
          ) : (
            <p className="text-xs text-[var(--color-text-muted)]">
              请在商品列表的「规格管理」中挂载交付文件。
            </p>
          )}
        </div>
      )}
      {draft && (showDeliveryFields || showStructured) && (
        <div className="mt-3 space-y-3">
          {showDeliveryFields && (
            <OfferDeliveryFieldsEditor variant="edit"
              fields={draft.deliveryFields}
              onChange={(deliveryFields) => onDraftChange({ deliveryFields })}
              disabled={offerBusy}
              testIdPrefix={`product-edit-offer-${offer.id}-delivery`}
            />
          )}
          {showStructured && (
            <OfferStructuredContentEditor variant="edit"
              fields={draft.structuredFields}
              values={draft.structuredValues}
              onFieldsChange={(structuredFields) => onDraftChange({ structuredFields })}
              onValuesChange={(structuredValues) => onDraftChange({ structuredValues })}
              disabled={offerBusy}
              testIdPrefix={`product-edit-offer-${offer.id}-structured`}
            />
          )}
        </div>
      )}
    </li>
  )
}
