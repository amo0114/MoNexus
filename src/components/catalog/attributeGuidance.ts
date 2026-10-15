/**
 * Fill-in guidance for the recommendation primary fields (PLAN-RECOMMENDATION-LOCAL-QUALITY-001 §6).
 *
 * Guidance set 2026-10-15.v1, product fields only. The 2026-10-15 local audit
 * (docs/reviews/recommendation-local-quality.md §6) found no verifiable values, so this set
 * has explanations only and no suggested values. It never validates, rewrites or blocks input.
 */
const GUIDANCE: Readonly<Record<string, string>> = {
  'redemption_code@1:serviceName': '填写兑换码适用的产品或平台名称。面值、周期和地区请填在对应参数或套餐里，不要写进这里。同一产品尽量使用一致的写法。',
  'account@1:serviceName': '填写账号所属的服务或平台名称。账号类型、周期和质保请填在对应参数或套餐里。同一服务尽量使用一致的写法。',
  'subscription@1:serviceName': '填写订阅的服务名称。不同周期或档位用套餐区分，服务名称保持一致。',
  'digital_file@1:contentCategory': '填写文件内容的实际类型，不要整句复制商品标题或套餐名称。同类内容尽量使用一致的写法。',
  'fixed_content@1:contentCategory': '填写交付内容的实际类型，不要整句复制商品标题或套餐名称。同类内容尽量使用一致的写法。',
}

export function productAttributeGuidance(templateKey: string, templateVersion: number, fieldKey: string): string | null {
  return GUIDANCE[`${templateKey}@${templateVersion}:${fieldKey}`] ?? null
}
