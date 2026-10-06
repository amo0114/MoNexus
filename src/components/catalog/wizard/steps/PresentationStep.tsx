import { lazy, Suspense } from 'react'
import type {
  CategoryRegistryItem,
  ProductDetails,
  ProductTemplateDefinition,
  ProductVisibility,
  TemplateAttributes,
} from '../../../../types/catalog'
import { PRODUCT_VISIBILITY } from '../../../../types/catalog'
import type { PurchaseFormField } from '../../../../types/merchant'
import type { RichTextInsertedImage } from '../../RichTextEditor'
import ProductCategorySelect from '../../ProductCategorySelect'
import ProductDetailsFields from '../../ProductDetailsFields'
import TemplateAttributeFields from '../../TemplateAttributeFields'
import ProductImageUploader from '../../../merchant/ProductImageUploader'
import PurchaseFormFieldsEditor from '../../../merchant/PurchaseFormFieldsEditor'
import FieldLabel from '../FieldLabel'

const RichTextEditor = lazy(() => import('../../RichTextEditor'))

interface Props {
  name: string
  onNameChange: (name: string) => void
  categories: CategoryRegistryItem[]
  categoryId: number | null
  onCategoryIdChange: (categoryId: number | null) => void
  images: string[]
  imageKeys: Record<string, string>
  onImagesChange: React.Dispatch<React.SetStateAction<string[]>>
  onImageKeysChange: React.Dispatch<React.SetStateAction<Record<string, string>>>
  description: string
  onDescriptionChange: (description: string) => void
  visibility: ProductVisibility
  onVisibilityChange: (visibility: ProductVisibility) => void
  richDescription: string | null
  onRichDescriptionChange: (html: string | null) => void
  /** Upload + write-ref bookkeeping stay in the parent. */
  onInsertDescriptionImage: () => Promise<RichTextInsertedImage | null>
  /** Registry template for the 商品参数 block; null until one is selected. */
  template: ProductTemplateDefinition | null
  productAttributes: TemplateAttributes
  onProductAttributesChange: (attributes: TemplateAttributes) => void
  productDetails: ProductDetails
  onProductDetailsChange: (details: ProductDetails) => void
  purchaseForm: PurchaseFormField[]
  onPurchaseFormChange: (fields: PurchaseFormField[]) => void
  disabled?: boolean
}

/**
 * 展示信息 step (step 1): name, category, media, visibility, details, purchase form.
 *
 * Every value is mirrored in from the parent; edits leave as callbacks. The
 * 图文详情 image insertion is delegated upward so upload refs and the
 * descriptionImages write list keep living in the wizard.
 */
export default function PresentationStep({
  name,
  onNameChange,
  categories,
  categoryId,
  onCategoryIdChange,
  images,
  imageKeys,
  onImagesChange,
  onImageKeysChange,
  description,
  onDescriptionChange,
  visibility,
  onVisibilityChange,
  richDescription,
  onRichDescriptionChange,
  onInsertDescriptionImage,
  template,
  productAttributes,
  onProductAttributesChange,
  productDetails,
  onProductDetailsChange,
  purchaseForm,
  onPurchaseFormChange,
  disabled,
}: Props) {
  return (
    <div className="space-y-5" data-testid="wizard-step-display">
      <div>
        <FieldLabel required>商品名称</FieldLabel>
        <input type="text" className="input" placeholder="输入吸引人的商品名称" value={name}
          onChange={(e) => onNameChange(e.target.value)} data-testid="wizard-name" />
      </div>
      <ProductCategorySelect
        categories={categories}
        value={categoryId}
        onChange={onCategoryIdChange}
        disabled={disabled}
      />
      <ProductImageUploader
        images={images}
        imageKeys={imageKeys}
        onChange={onImagesChange}
        onImageKeysChange={onImageKeysChange}
        disabled={disabled}
      />
      <div>
        <FieldLabel>一句话简介</FieldLabel>
        <textarea className="input min-h-[60px] resize-y" placeholder="简明扼要地概括商品亮点..."
          value={description} onChange={(e) => onDescriptionChange(e.target.value)} />
      </div>
      <div data-testid="wizard-visibility">
        <FieldLabel required>浏览可见性</FieldLabel>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer text-sm ${
            visibility === PRODUCT_VISIBILITY.PUBLIC
              ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
              : 'border-[var(--color-border)]'
          }`}>
            <input type="radio" name="wizardVisibility" value={PRODUCT_VISIBILITY.PUBLIC}
              checked={visibility === PRODUCT_VISIBILITY.PUBLIC}
              onChange={() => onVisibilityChange(PRODUCT_VISIBILITY.PUBLIC)}
              className="w-4 h-4 mt-0.5" data-testid="wizard-visibility-public" />
            <span>游客可浏览商品信息</span>
          </label>
          <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer text-sm ${
            visibility === PRODUCT_VISIBILITY.MEMBERS_ONLY
              ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
              : 'border-[var(--color-border)]'
          }`}>
            <input type="radio" name="wizardVisibility" value={PRODUCT_VISIBILITY.MEMBERS_ONLY}
              checked={visibility === PRODUCT_VISIBILITY.MEMBERS_ONLY}
              onChange={() => onVisibilityChange(PRODUCT_VISIBILITY.MEMBERS_ONLY)}
              className="w-4 h-4 mt-0.5" data-testid="wizard-visibility-members_only" />
            <span>仅登录后可浏览</span>
          </label>
        </div>
        <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">兑换始终需要登录</p>
      </div>
      <div>
        <FieldLabel>图文详情</FieldLabel>
        <Suspense fallback={
          <div className="input min-h-[140px] flex items-center text-sm text-[var(--color-text-muted)]">
            正在加载图文编辑器…
          </div>
        }>
          <RichTextEditor
            value={richDescription}
            onChange={onRichDescriptionChange}
            onInsertImage={onInsertDescriptionImage}
            placeholder="详细描述商品特性、使用教程、售后承诺等..."
            disabled={disabled}
          />
        </Suspense>
      </div>
      {template && (
        <div data-testid="wizard-product-attributes">
          <FieldLabel>商品参数</FieldLabel>
          <TemplateAttributeFields
            template={template}
            target="product"
            value={productAttributes}
            onChange={onProductAttributesChange}
            disabled={disabled}
            mode="draft"
          />
        </div>
      )}
      <ProductDetailsFields
        value={productDetails}
        onChange={onProductDetailsChange}
        disabled={disabled}
        mode="draft"
      />
      <div data-testid="wizard-purchase-form">
        <FieldLabel>购买资料</FieldLabel>
        <PurchaseFormFieldsEditor fields={purchaseForm} onChange={onPurchaseFormChange} />
      </div>
    </div>
  )
}
