// SPEC-MERCHANT-AGENT-001 §5 read_help — fixed platform guidance maintained in
// code. Never reads repository docs, prompts, config or operations material.

import type { HelpTopic } from './constants.js'

export const HELP_TEXT: Record<HelpTopic, string> = {
  publication: '商品发布前需满足：规范封面、可用分类、按商品形态填写的参数、购买须知与售后说明（按形态要求）、至少一个启用且当前可售的规格，以及有效的交付配置。缺项在商品编辑页的“发布检查”中逐项列出，补齐并保存后再点发布，发布时会重新检查。',
  availability: '即时库存类规格按可用交付单元计数，可在“管理可售资源”中导入或作废；限量名额类规格按名额计数，可调整名额。库存或名额为 0 的规格无法购买。提醒阈值由平台设置。',
  manual_fulfillment: '人工服务订单需在履约截止时间前开始并完成交付；临近或超过截止时间的订单会出现在待办中。打开订单详情可查看状态并执行开始履约、交付或沟通进度。',
  content_boundaries: '商品说明文案只基于商品已有信息和商家提供的公开补充生成；不会编造价格、库存、有效期、地区、退款或时效承诺。提案需要商家在编辑器中逐项选择、填入并手动保存后才生效。',
}
