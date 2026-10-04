import { lazy, Suspense, type Dispatch, type SetStateAction } from 'react'
import ProductCategorySelect from '../../../components/catalog/ProductCategorySelect'
import TemplateAttributeFields from '../../../components/catalog/TemplateAttributeFields'
import ProductDetailsFields from '../../../components/catalog/ProductDetailsFields'
import ProductImageUploader from '../../../components/merchant/ProductImageUploader'
import FieldLabel from '../../../components/catalog/wizard/FieldLabel'
import type { RichTextInsertedImage } from '../../../components/catalog/RichTextEditor'
import {
  PRODUCT_VISIBILITY,
  type CategoryRegistryItem,
  type ProductDetails,
  type ProductTemplateDefinition,
  type ProductVisibility,
  type TemplateAttributes,
  type TemplateKey,
} from '../../../types/catalog'

const RichTextEditor = lazy(() => import('../../../components/catalog/RichTextEditor'))

interface Props {
  images: string[]
  imageKeys: Record<string, string>
  onImagesChange: Dispatch<SetStateAction<string[]>>
  onImageKeysChange: Dispatch<SetStateAction<Record<string, string>>>
  unresolvedImages: boolean
  disabled: boolean
  name: string
  onNameChange: (name: string) => void
  description: string
  onDescriptionChange: (description: string) => void
  richDescription: string | null
  onRichDescriptionChange: (html: string | null) => void
  attributes: TemplateAttributes
  onAttributesChange: (attributes: TemplateAttributes) => void
  details: ProductDetails
  onDetailsChange: (details: ProductDetails) => void
  visibility: ProductVisibility
  onVisibilityChange: (visibility: ProductVisibility) => void
  categories: CategoryRegistryItem[]
  categoryId: number | null
  onCategoryIdChange: (categoryId: number | null) => void
  templates: ProductTemplateDefinition[]
  templateKey: TemplateKey | null
  onTemplateKeyChange: (value: string) => void
  selectedTemplate: ProductTemplateDefinition | null
  savedTemplateKey: TemplateKey | null
  templateLocked: boolean
  fieldMode: 'draft' | 'publish'
  onInsertDescriptionImage: () => Promise<RichTextInsertedImage | null>
}

export default function ProductInformationSection({
  images,
  imageKeys,
  onImagesChange,
  onImageKeysChange,
  unresolvedImages,
  disabled,
  name,
  onNameChange,
  description,
  onDescriptionChange,
  richDescription,
  onRichDescriptionChange,
  attributes,
  onAttributesChange,
  details,
  onDetailsChange,
  visibility,
  onVisibilityChange,
  categories,
  categoryId,
  onCategoryIdChange,
  templates,
  templateKey,
  onTemplateKeyChange,
  selectedTemplate,
  savedTemplateKey,
  templateLocked,
  fieldMode,
  onInsertDescriptionImage,
}: Props) {
  return (
    <section className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] p-5 sm:p-8 space-y-5" data-testid="product-edit-info">
      <h2 className="font-heading text-lg font-bold text-[var(--color-text)]">商品信息</h2>
      <ProductImageUploader
        images={images}
        imageKeys={imageKeys}
        onChange={onImagesChange}
        onImageKeysChange={onImageKeysChange}
        disabled={disabled}
      />
      {unresolvedImages && (
        <p className="text-xs text-[var(--color-text-muted)]" data-testid="product-edit-images-unresolved">
          部分图片缺少可写引用。请替换为平台上传或 /assets 静态图后再保存图集；本次保存不会修改图集。
        </p>
      )}
      <div>
        <FieldLabel required>商品名称</FieldLabel>
        <input
          type="text"
          className="input"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          disabled={disabled}
          data-testid="product-edit-name"
        />
      </div>
      <div>
        <FieldLabel>一句话简介</FieldLabel>
        <textarea
          className="input min-h-[60px] resize-y"
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          disabled={disabled}
          data-testid="product-edit-description"
        />
      </div>
      <ProductCategorySelect
        categories={categories}
        value={categoryId}
        onChange={onCategoryIdChange}
        disabled={disabled}
      />
      {templateLocked ? (
        <p className="text-sm text-[var(--color-text-muted)]" data-testid="product-edit-template-locked">
          商品形态：{selectedTemplate?.label ?? savedTemplateKey}
        </p>
      ) : (
        <div data-testid="product-edit-template-picker">
          <FieldLabel>商品形态</FieldLabel>
          <select
            className="input appearance-none cursor-pointer"
            value={templateKey ?? ''}
            onChange={(event) => {
              onTemplateKeyChange(event.target.value)
            }}
            disabled={disabled}
            data-testid="product-edit-template-select"
          >
            <option value="">请选择商品形态</option>
            {templates.map(template => (
              <option key={template.key} value={template.key}>{template.label}</option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
            历史商品可补选一次形态，选定并保存后不可更改。
          </p>
        </div>
      )}
      {selectedTemplate && (
        <div data-testid="product-edit-attributes">
          <FieldLabel>商品参数</FieldLabel>
          <TemplateAttributeFields
            template={selectedTemplate}
            target="product"
            value={attributes}
            onChange={onAttributesChange}
            disabled={disabled}
            mode={fieldMode}
          />
        </div>
      )}
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
            disabled={disabled}
          />
        </Suspense>
      </div>
      <ProductDetailsFields
        value={details}
        onChange={onDetailsChange}
        disabled={disabled}
        mode={fieldMode}
      />
      <div data-testid="product-edit-visibility">
        <FieldLabel required>浏览可见性</FieldLabel>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer text-sm ${
            visibility === PRODUCT_VISIBILITY.PUBLIC
              ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
              : 'border-[var(--color-border)]'
          }`}>
            <input
              type="radio"
              name="productEditVisibility"
              value={PRODUCT_VISIBILITY.PUBLIC}
              checked={visibility === PRODUCT_VISIBILITY.PUBLIC}
              onChange={() => onVisibilityChange(PRODUCT_VISIBILITY.PUBLIC)}
              className="w-4 h-4 mt-0.5"
              disabled={disabled}
              data-testid="product-edit-visibility-public"
            />
            <span>游客可浏览商品信息</span>
          </label>
          <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer text-sm ${
            visibility === PRODUCT_VISIBILITY.MEMBERS_ONLY
              ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
              : 'border-[var(--color-border)]'
          }`}>
            <input
              type="radio"
              name="productEditVisibility"
              value={PRODUCT_VISIBILITY.MEMBERS_ONLY}
              checked={visibility === PRODUCT_VISIBILITY.MEMBERS_ONLY}
              onChange={() => onVisibilityChange(PRODUCT_VISIBILITY.MEMBERS_ONLY)}
              className="w-4 h-4 mt-0.5"
              disabled={disabled}
              data-testid="product-edit-visibility-members_only"
            />
            <span>仅登录后可浏览</span>
          </label>
        </div>
        <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">兑换始终需要登录</p>
      </div>
    </section>
  )
}
