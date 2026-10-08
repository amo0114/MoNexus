import type { ProductDraftSuggestion } from '../../api/productDraftAssistant'
import type { CategoryRegistryItem, ProductTemplateDefinition, TemplateAttributes } from '../../types/catalog'

export type DraftChange = {
  key: string
  label: string
  before: string
  after: string
  apply: (current: ProductDraftSuggestion) => ProductDraftSuggestion
}

export function displayDraftValue(value: unknown): string {
  if (value == null || value === '' || (Array.isArray(value) && !value.length)) return '未填写'
  return Array.isArray(value) ? value.join('、') : String(value)
}

/** Only fixed tags are introduced after human confirmation; every source character is escaped. */
export function draftIntroductionHtml(text: string | null | undefined): string | null {
  if (!text?.trim()) return null
  const escaped = text.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  return escaped.split(/\n\s*\n/).map(paragraph => `<p>${paragraph.replace(/\r?\n/g, '<br>')}</p>`).join('')
}

export function attributeLabel(template: ProductTemplateDefinition | null, target: 'product' | 'offer', key: string): string {
  const schema = target === 'product' ? template?.productSchema : template?.offerSchema
  const properties = schema?.properties as Record<string, { title?: string }> | undefined
  return properties?.[key]?.title ?? key
}

export function displayAttribute(template: ProductTemplateDefinition | null, key: string, value: unknown): string {
  return template?.ui.enumLabels?.[key]?.[String(value)] ?? displayDraftValue(value)
}

/** Compare validated proposals locally; never send edited fields back to the model. */
export function getDraftChanges(current: ProductDraftSuggestion, next: ProductDraftSuggestion,
  templates: ProductTemplateDefinition[], categories: CategoryRegistryItem[]): DraftChange[] {
  const changes: DraftChange[] = []
  const oldTemplate = templates.find(item => item.key === current.templateKey) ?? null
  const newTemplate = templates.find(item => item.key === next.templateKey) ?? null
  const add = (key: string, label: string, before: unknown, after: unknown, apply: DraftChange['apply'], format = displayDraftValue) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ key, label, before: format(before), after: format(after), apply })
  }
  for (const [key, label] of [['name', '商品名称'], ['description', '商品简介'], ['introduction', '详细商品介绍'], ['offerName', '主规格名称']] as const) {
    add(key, label, current[key], next[key], value => ({ ...value, [key]: next[key] }))
  }
  add('categoryId', '商品分类', current.categoryId, next.categoryId, value => ({ ...value, categoryId: next.categoryId }),
    value => categories.find(item => item.id === value)?.label ?? '未填写')

  if (current.templateKey !== next.templateKey) {
    const describe = (value: ProductDraftSuggestion, template: ProductTemplateDefinition | null) => [
      template?.label ?? '未选择形态',
      ...(['attributes', 'offerAttributes'] as const).flatMap(target => Object.entries(value[target]).map(([key, item]) =>
        `${target === 'attributes' ? '商品' : '规格'} · ${attributeLabel(template, target === 'attributes' ? 'product' : 'offer', key)}：${displayAttribute(template, key, item)}`)),
    ].join('\n')
    changes.push({ key: 'templateKey', label: '商品形态与所属参数（一起更换）', before: describe(current, oldTemplate), after: describe(next, newTemplate),
      apply: value => ({ ...value, templateKey: next.templateKey, attributes: next.attributes, offerAttributes: next.offerAttributes }) })
  } else {
    for (const target of ['attributes', 'offerAttributes'] as const) {
      for (const key of new Set([...Object.keys(current[target]), ...Object.keys(next[target])])) {
        add(`${target}.${key}`, `${target === 'attributes' ? '商品' : '规格'} · ${attributeLabel(newTemplate, target === 'attributes' ? 'product' : 'offer', key)}`,
          current[target][key], next[target][key], value => {
            const attributes: TemplateAttributes = { ...value[target] }
            if (next[target][key] === undefined) delete attributes[key]
            else attributes[key] = next[target][key]
            return { ...value, [target]: attributes }
          }, value => displayAttribute(newTemplate, key, value))
      }
    }
  }
  // FAQ is human-authored and is deliberately outside the model's schema.
  for (const [key, label] of [['highlights', '商品亮点'], ['usageInstructions', '使用说明'], ['purchaseNotes', '购买须知'], ['afterSalesInstructions', '售后说明']] as const) {
    add(`details.${key}`, label, current.details[key], next.details[key], value => ({ ...value, details: { ...value.details, [key]: next.details[key] } }))
  }
  return changes
}
