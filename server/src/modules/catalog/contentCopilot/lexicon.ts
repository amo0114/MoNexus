// SPEC-AI-PRODUCT-001 §7.4 / §7.5 — closed lexicons. These are data, versioned
// by VALIDATOR_VERSION: any edit here requires bumping it.

/** H2 — unbounded / perpetual wording. Never supportable in V1 (CP-09). */
export const UNBOUNDED_TERMS = [
  '永不过期',
  '长期有效',
  '无限制',
  '不限速',
  '不限量',
  '无上限',
  '永久',
  '终身',
  '不限',
  '无限',
] as const

/** H3 — delivery timing wording; only supportable by a verified instant-delivery claim. */
export const TIMING_TERMS = ['立即到账', '全天候', '秒发', '秒到', '即时', '实时', '马上'] as const

/** H4 — refund / guarantee / authenticity promises. Never supportable in V1 (CP-10). */
export const PROMISE_TERMS = [
  '稳定不掉线',
  '永不封号',
  '不封号',
  '无条件',
  '百分百',
  '100%',
  '包退',
  '包换',
  '包赔',
  '退款',
  '退货',
  '赔付',
  '保证',
  '保障',
  '担保',
  '绝对',
  '官方',
  '正品',
] as const

type LexiconEntry = { id: string; zh: string[]; latin: string[]; latinCaseSensitive?: string[] }

/** H5 — regions. Canonical ids let 「美区」 and 「美国」 compare equal. */
export const REGION_LEXICON: LexiconEntry[] = [
  { id: 'region:cn', zh: ['中国大陆', '中国', '大陆', '国内', '内地'], latin: [] },
  { id: 'region:hk', zh: ['香港', '港区', '港服'], latin: [], latinCaseSensitive: ['HK'] },
  { id: 'region:tw', zh: ['台湾', '台区'], latin: [], latinCaseSensitive: ['TW'] },
  { id: 'region:mo', zh: ['澳门'], latin: [] },
  { id: 'region:jp', zh: ['日本', '日区', '日服'], latin: [], latinCaseSensitive: ['JP'] },
  { id: 'region:kr', zh: ['韩国', '韩区', '韩服'], latin: [], latinCaseSensitive: ['KR'] },
  { id: 'region:us', zh: ['美国', '美区', '美服'], latin: [], latinCaseSensitive: ['US', 'USA'] },
  { id: 'region:uk', zh: ['英国', '英区'], latin: [], latinCaseSensitive: ['UK'] },
  { id: 'region:de', zh: ['德国'], latin: [] },
  { id: 'region:fr', zh: ['法国'], latin: [] },
  { id: 'region:sg', zh: ['新加坡', '狮城'], latin: [], latinCaseSensitive: ['SG'] },
  { id: 'region:tr', zh: ['土耳其', '土区'], latin: [] },
  { id: 'region:ru', zh: ['俄罗斯'], latin: [] },
  { id: 'region:in', zh: ['印度'], latin: [] },
  { id: 'region:au', zh: ['澳大利亚', '澳洲'], latin: [] },
  { id: 'region:ca', zh: ['加拿大'], latin: [] },
  { id: 'region:eu', zh: ['欧洲', '欧区'], latin: [] },
  { id: 'region:global', zh: ['全世界', '全球', '海外', '国外', '全区'], latin: [] },
]

/** H5 — device platforms. */
export const PLATFORM_LEXICON: LexiconEntry[] = [
  { id: 'platform:ios', zh: ['苹果手机', '苹果设备', '苹果系统'], latin: ['iOS', 'iPhone', 'iPad', 'iPadOS'] },
  { id: 'platform:android', zh: ['安卓'], latin: ['Android'] },
  { id: 'platform:windows', zh: [], latin: ['Windows', 'Win10', 'Win11'] },
  { id: 'platform:macos', zh: ['苹果电脑'], latin: ['macOS', 'MacBook', 'Mac'] },
  { id: 'platform:linux', zh: [], latin: ['Linux'] },
  { id: 'platform:harmony', zh: ['鸿蒙'], latin: ['HarmonyOS'] },
  { id: 'platform:router', zh: ['路由器'], latin: ['OpenWrt'] },
  { id: 'platform:tv', zh: ['智能电视', '电视'], latin: ['Apple TV'], latinCaseSensitive: ['TV'] },
  { id: 'platform:console', zh: [], latin: ['Switch', 'PS5', 'PS4', 'Xbox'] },
]

/** delivery_method wording per fact (§7.3). */
export const DELIVERY_PHRASES = {
  instant: ['下单后自动交付', '下单后自动发货', '自动发货', '自动交付', '自动发放', '即时交付', '即时发货'],
  manual: ['商家人工处理', '人工处理', '商家处理', '人工服务', '人工交付', '人工发货', '人工完成'],
  autoOpen: ['自动开通'],
} as const

/** «预计» semantics required for service_duration claims. */
export const ESTIMATE_TERMS = ['预计', '大约', '大概', '左右', '约'] as const

/** Xboard calendar periods → months (CP-08). onetime / reset_traffic are not durations. */
export const PERIOD_MONTHS: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  half_yearly: 6,
  yearly: 12,
  two_yearly: 24,
  three_yearly: 36,
}
