export interface FaqItem {
  question: string
  answer: string
}

export const DEFAULT_DIGITAL_FAQS: FaqItem[] = [
  {
    question: '兑换或购买后，如何获取卡密/服务凭据？',
    answer:
      '兑换成功后系统将自动秒发。您可以直接在兑换结果弹窗中复制卡密，或随时前往页面顶部的「订单」列表，进入该笔订单详情查看交付凭据、卡密与具体使用指引。',
  },
  {
    question: '如果卡密无法使用、提示失效或激活异常怎么办？',
    answer:
      '请先确认复制时未夹带首尾多余空格，并核对版本或客户端配置是否匹配。平台对所有在售商品提供交易存管与争议担保，若确认凭据异常，请点击本页或订单详情中的「联系客服」或申请平台介入，我们将第一时间为您核实补发或协助退款。',
  },
  {
    question: '本商品或套餐是否支持多设备/多端同时使用？',
    answer:
      '虚拟服务与订阅的设备数以当前商品「使用说明」及套餐规格标注为准。通常默认规格为单用户/单设备授权；如需在手机、平板与电脑多端并发使用，建议选择多设备并发版本。',
  },
  {
    question: '虚拟商品兑换后是否支持退款或退换？',
    answer:
      '因数字卡密与虚拟服务具有即时发货、即时查验及可复制特性，发货后通常不支持无理由退换。若商品本身存在失效、不可用或与描述严重不符且商家未能解决，平台仲裁保障机制将全额守护您的积分与资金安全。',
  },
]

export function resolveDisplayFaqs(customFaq?: FaqItem[] | null): FaqItem[] {
  if (customFaq && customFaq.length > 0) {
    if (customFaq.length >= 3) {
      return customFaq
    }
    const combined = [...customFaq]
    for (const item of DEFAULT_DIGITAL_FAQS) {
      if (combined.length >= 4) break
      if (!combined.some((c) => c.question === item.question)) {
        combined.push(item)
      }
    }
    return combined
  }
  return DEFAULT_DIGITAL_FAQS
}
