import PurchaseFormFieldsEditor from '../../../components/merchant/PurchaseFormFieldsEditor'
import type { PurchaseFormField } from '../../../types/merchant'

interface Props {
  fields: PurchaseFormField[]
  onChange: (fields: PurchaseFormField[]) => void
}

export default function PurchaseFormSection({ fields, onChange }: Props) {
  return (
    <section
      className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] p-5 sm:p-8 space-y-3"
      data-testid="product-edit-purchase-form"
    >
      <h2 className="font-heading text-lg font-bold text-[var(--color-text)]">购买资料</h2>
      <PurchaseFormFieldsEditor fields={fields} onChange={onChange} />
    </section>
  )
}
