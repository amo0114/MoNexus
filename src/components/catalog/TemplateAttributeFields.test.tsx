import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ProductTemplateDefinition, TemplateAttributes, TemplateWidget } from '../../types/catalog'
import TemplateAttributeFields from './TemplateAttributeFields'

/**
 * Minimal slice of redemption_code (docs/specs/product-commerce-v2/templates.json)
 * plus select / stringList / integer / unknown widgets for control coverage.
 */
const REDEMPTION_FIXTURE: ProductTemplateDefinition = {
  key: 'redemption_code',
  version: 1,
  label: '卡密与兑换码',
  productSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      serviceName: { type: 'string', title: '适用产品', minLength: 1, maxLength: 100 },
      region: { type: 'string', title: '适用地区', minLength: 1, maxLength: 100 },
      redemptionMethod: { type: 'string', title: '兑换方式', minLength: 1, maxLength: 1000 },
      accessModel: { type: 'string', title: '账号使用方式', enum: ['exclusive', 'shared'] },
      formats: {
        type: 'array',
        title: '文件格式',
        maxItems: 8,
        items: { type: 'string', minLength: 1, maxLength: 40 },
      },
      estimatedMinutes: {
        type: 'integer',
        title: '预计服务时长（分钟）',
        minimum: 1,
        maximum: 1440,
      },
      mystery: { type: 'string', title: '未知控件' },
    },
    required: ['serviceName', 'redemptionMethod'],
  },
  offerSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      unitLabel: { type: 'string', title: '销售单位', minLength: 1, maxLength: 40 },
      faceValueLabel: { type: 'string', title: '面值或授权范围', minLength: 1, maxLength: 100 },
    },
    required: ['unitLabel'],
  },
  ui: {
    productOrder: [
      'serviceName',
      'region',
      'redemptionMethod',
      'accessModel',
      'formats',
      'estimatedMinutes',
      'mystery',
    ],
    offerOrder: ['unitLabel', 'faceValueLabel'],
    widgets: {
      serviceName: 'text',
      region: 'text',
      redemptionMethod: 'textarea',
      accessModel: 'select',
      formats: 'stringList',
      estimatedMinutes: 'integer',
      mystery: 'unknown' as unknown as TemplateWidget,
      unitLabel: 'text',
      faceValueLabel: 'text',
    },
    enumLabels: {
      accessModel: {
        exclusive: '独享账号',
        shared: '共享账号',
      },
    },
  },
  fulfillmentRules: [
    {
      whenProductAttributes: {},
      configurations: ['inventory'],
      requireStructuredDelivery: 'none',
      requireRequiredDateField: false,
    },
  ],
}

function Harness({
  initial = {},
  target = 'product',
  mode = 'draft',
  onChange,
}: {
  initial?: TemplateAttributes
  target?: 'product' | 'offer'
  mode?: 'draft' | 'publish'
  onChange?: (next: TemplateAttributes) => void
}) {
  const [value, setValue] = useState<TemplateAttributes>(initial)
  return (
    <TemplateAttributeFields
      template={REDEMPTION_FIXTURE}
      target={target}
      mode={mode}
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
    />
  )
}

describe('TemplateAttributeFields', () => {
  it('renders required-looking product fields from the redemption_code fixture', () => {
    render(
      <TemplateAttributeFields
        template={REDEMPTION_FIXTURE}
        target="product"
        value={{}}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByTestId('template-attribute-fields')).toHaveAttribute('data-target', 'product')
    expect(screen.getByLabelText(/适用产品/)).toBeInTheDocument()
    expect(screen.getByLabelText('适用地区')).toBeInTheDocument()
    expect(screen.getByLabelText(/兑换方式/)).toBeInTheDocument()
    expect(screen.getByText(/适用产品/).textContent).toContain('*')
    expect(screen.getByText(/兑换方式/).textContent).toContain('*')
    expect(screen.getByText('适用地区').textContent).not.toContain('*')
  })

  it('renders select options with ui.enumLabels', () => {
    render(
      <TemplateAttributeFields
        template={REDEMPTION_FIXTURE}
        target="product"
        value={{}}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('option', { name: '请选择' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '独享账号' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '共享账号' })).toBeInTheDocument()
  })

  it('omits empty keys on change, strips keys outside the order list, and never emits JSON null', () => {
    const onChange = vi.fn()
    render(<Harness initial={{ serviceName: '示例软件', extra: 'drop-me' }} onChange={onChange} />)

    fireEvent.change(screen.getByTestId('template-attr-region-control'), { target: { value: '全球' } })
    expect(onChange).toHaveBeenCalledTimes(1)
    const afterFill = onChange.mock.calls[0][0] as TemplateAttributes
    expect(afterFill).toEqual({ serviceName: '示例软件', region: '全球' })
    expect(afterFill).not.toHaveProperty('extra')
    expect(Object.values(afterFill).every((item) => item !== null)).toBe(true)

    fireEvent.change(screen.getByTestId('template-attr-serviceName-control'), { target: { value: '' } })
    const afterClear = onChange.mock.calls[1][0] as TemplateAttributes
    expect(afterClear).toEqual({ region: '全球' })
    expect(afterClear).not.toHaveProperty('serviceName')
    expect(afterClear).not.toHaveProperty('extra')
  })

  it('loads existing attributes into the controls', () => {
    render(
      <TemplateAttributeFields
        template={REDEMPTION_FIXTURE}
        target="product"
        value={{
          serviceName: '示例软件',
          region: '全球',
          redemptionMethod: '在软件的兑换入口输入卡密。',
          accessModel: 'shared',
          formats: ['SVG', 'PNG'],
          estimatedMinutes: 30,
        }}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByTestId('template-attr-serviceName-control')).toHaveValue('示例软件')
    expect(screen.getByTestId('template-attr-region-control')).toHaveValue('全球')
    expect(screen.getByTestId('template-attr-redemptionMethod-control')).toHaveValue('在软件的兑换入口输入卡密。')
    expect(screen.getByTestId('template-attr-accessModel-control')).toHaveValue('shared')
    expect(screen.getByTestId('template-attr-formats-item-0')).toHaveValue('SVG')
    expect(screen.getByTestId('template-attr-formats-item-1')).toHaveValue('PNG')
    expect(screen.getByTestId('template-attr-estimatedMinutes-control')).toHaveValue(30)
  })

  it('renders offerOrder fields for the offer target', () => {
    render(
      <TemplateAttributeFields
        template={REDEMPTION_FIXTURE}
        target="offer"
        value={{ unitLabel: '1 个兑换码' }}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByTestId('template-attribute-fields')).toHaveAttribute('data-target', 'offer')
    expect(screen.getByLabelText(/销售单位/)).toHaveValue('1 个兑换码')
    expect(screen.getByLabelText('面值或授权范围')).toBeInTheDocument()
    expect(screen.queryByLabelText(/适用产品/)).not.toBeInTheDocument()
  })

  it('omits empty integer values instead of coercing them to 0', () => {
    const onChange = vi.fn()
    render(<Harness initial={{ estimatedMinutes: 30 }} onChange={onChange} />)

    fireEvent.change(screen.getByTestId('template-attr-estimatedMinutes-control'), { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith({})
    expect(onChange.mock.calls[0][0]).not.toHaveProperty('estimatedMinutes')
    expect(onChange.mock.calls[0][0]).not.toEqual({ estimatedMinutes: 0 })

    fireEvent.change(screen.getByTestId('template-attr-estimatedMinutes-control'), { target: { value: '45' } })
    expect(onChange).toHaveBeenLastCalledWith({ estimatedMinutes: 45 })

    onChange.mockClear()
    fireEvent.change(screen.getByTestId('template-attr-estimatedMinutes-control'), { target: { value: '1.5' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('omits empty strings from a stringList and emits an explicit empty array when cleared', () => {
    const onChange = vi.fn()
    render(<Harness initial={{ formats: ['SVG', 'PNG'] }} onChange={onChange} />)

    fireEvent.change(screen.getByTestId('template-attr-formats-item-0'), { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith({ formats: ['PNG'] })

    fireEvent.click(screen.getByTestId('template-attr-formats-remove-0'))
    expect(onChange).toHaveBeenLastCalledWith({ formats: [] })
  })

  it('renders a disabled note for unknown widgets without crashing', () => {
    render(
      <TemplateAttributeFields
        template={REDEMPTION_FIXTURE}
        target="product"
        value={{ mystery: 'keep' }}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByTestId('template-attr-mystery-unsupported')).toHaveTextContent('不支持的控件类型')
    expect(screen.queryByTestId('template-attr-mystery-control')).not.toBeInTheDocument()
  })

  it('emits select enum values (not labels) and allows clearing in draft mode', () => {
    const onChange = vi.fn()
    render(
      <TemplateAttributeFields
        template={REDEMPTION_FIXTURE}
        target="product"
        value={{}}
        onChange={onChange}
        mode="draft"
      />,
    )

    fireEvent.change(screen.getByTestId('template-attr-accessModel-control'), { target: { value: 'exclusive' } })
    expect(onChange).toHaveBeenCalledWith({ accessModel: 'exclusive' })

    fireEvent.change(screen.getByTestId('template-attr-accessModel-control'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({})
  })

  it('shows a publish required hint for missing schema-required fields', () => {
    render(
      <TemplateAttributeFields
        template={REDEMPTION_FIXTURE}
        target="product"
        value={{}}
        onChange={vi.fn()}
        mode="publish"
      />,
    )

    expect(screen.getByTestId('template-attr-serviceName-required-hint')).toHaveTextContent('发布前必填')
    expect(screen.getByTestId('template-attr-redemptionMethod-required-hint')).toHaveTextContent('发布前必填')
    expect(screen.queryByTestId('template-attr-region-required-hint')).not.toBeInTheDocument()
  })
})
