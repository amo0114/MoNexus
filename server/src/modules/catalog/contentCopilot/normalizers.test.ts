import { describe, expect, it } from 'vitest'
import {
  detectHardFacts,
  extractTuples,
  findDurations,
  hasForbiddenMarkup,
  normalizeSpace,
  parseNumberToken,
  regionPlatformIds,
} from './normalizers.js'

describe('content copilot normalizers (SPEC-AI-PRODUCT-001 §7.5)', () => {
  it('parses arabic and chinese numerals', () => {
    expect(parseNumberToken('30')).toBe(30)
    expect(parseNumberToken('三十')).toBe(30)
    expect(parseNumberToken('十二')).toBe(12)
    expect(parseNumberToken('两')).toBe(2)
    expect(parseNumberToken('一百零五')).toBe(105)
    expect(parseNumberToken('三万五千')).toBe(35000)
    expect(parseNumberToken('abc')).toBeNull()
  })

  it.each([
    ['30 天', { kind: 'days', days: 30 }],
    ['三十天', { kind: 'days', days: 30 }],
    ['30日', { kind: 'days', days: 30 }],
    ['2 周', { kind: 'days', days: 14 }],
    ['一个月', { kind: 'months', months: 1 }],
    ['3 个月', { kind: 'months', months: 3 }],
    ['一个季度', { kind: 'months', months: 3 }],
    ['半年', { kind: 'months', months: 6 }],
    ['1 年', { kind: 'months', months: 12 }],
    ['60 分钟', { kind: 'minutes', minutes: 60 }],
    ['1 小时', { kind: 'minutes', minutes: 60 }],
  ])('normalises duration %s', (text, expected) => {
    expect(findDurations(text).map(item => item.expr)).toEqual([expected])
  })

  it.each([
    ['5秒内完成交付', 5 / 60],
    ['3 秒钟', 3 / 60],
    ['半天内完成交付', null],
    ['一天半', null],
    ['几分钟内到账', null],
  ])('detects timing durations in %s', (text, minutes) => {
    const found = findDurations(text)
    expect(found).toHaveLength(1)
    if (minutes != null) expect(found[0].expr).toEqual({ kind: 'minutes', minutes })
    expect(detectHardFacts(text).some(item => item.cls === 'H1')).toBe(true)
  })

  it('parses half units and keeps vague counts unmatchable', () => {
    expect(findDurations('半天')[0].expr).toEqual({ kind: 'days', days: 0.5 })
    expect(findDurations('一天半')[0].expr).toEqual({ kind: 'days', days: 1.5 })
    const vague = findDurations('数日')[0].expr as { days: number }
    expect(Number.isNaN(vague.days)).toBe(true)
  })

  it('does not read 「十分」 as minutes', () => {
    expect(findDurations('操作十分简单')).toEqual([])
  })

  it('normalises quantity aliases without magnitude conversion', () => {
    expect(extractTuples('100G')).toEqual([{ value: 100, unit: 'GB' }])
    expect(extractTuples('100GB')).toEqual([{ value: 100, unit: 'GB' }])
    expect(extractTuples('0.1TB')).toEqual([{ value: 0.1, unit: 'TB' }])
    expect(extractTuples('3 台设备')).toEqual([{ value: 3, unit: 'device' }])
    expect(extractTuples('¥ 20')).toEqual([{ value: 20, unit: 'money' }])
  })

  it('keeps vague quantities as unmatchable facts', () => {
    const tuples = extractTuples('几元，若干台')
    expect(tuples.map(item => item.unit)).toEqual(['yuan', 'device'])
    expect(tuples.every(item => Number.isNaN(item.value))).toBe(true)
  })

  it('classifies prices, points, percentages and discounts as H7', () => {
    expect(detectHardFacts('1积分，100元，¥20，20%，8折，100GB').map(item => item.cls))
      .toEqual(['H7', 'H7', 'H7', 'H7', 'H1', 'H7'])
  })

  describe('text boundaries (review of 507f01b)', () => {
    it('normalises horizontal whitespace without merging lines or paragraphs', () => {
      for (const separator of ['\n', '\r\n', '\r', '\u2028', '\u2029', '\n\n']) {
        const text = `  月套餐\t 30天 ${separator} 年套餐\u00a0 365天  `
        const normalised = normalizeSpace(text)
        expect(normalised, JSON.stringify(separator)).toBe('月套餐 30天\n年套餐 365天')
        expect(normalizeSpace(normalised)).toBe(normalised)
      }
    })

    it('detects Chinese price units and percentages immediately before Latin text', () => {
      for (const [text, price] of [
        ['优惠20%OFF', '20%'], ['优惠20％OFF', '20％'],
        ['售价1元VIP', '1元'], ['售价1积分VIP', '1积分'],
        ['折扣8折VIP', '8折'], ['售价几块VIP', '几块'],
      ]) {
        const mentions = detectHardFacts(text).filter(item => item.cls === 'H7')
        expect(mentions.map(item => item.text), text).toEqual([price])
        expect(text.slice(mentions[0].start, mentions[0].end)).toBe(price)
      }
    })

    it('detects vague currency prefixes as unmatchable H7 values', () => {
      for (const text of ['¥若干', '$几', '￥数', '¥ 几', '$ 若干']) {
        expect(detectHardFacts(text).map(item => item.cls), text).toEqual(['H7'])
        expect(extractTuples(text), text).toEqual([{ value: Number.NaN, unit: 'money' }])
      }
    })

    it('still requires a word boundary after Latin capacity and speed units', () => {
      expect(extractTuples('100GBundle 50MBasic')).toEqual([])
      expect(extractTuples('100GB，50Mbps')).toEqual([
        { value: 100, unit: 'GB' }, { value: 50, unit: 'Mbps' },
      ])
    })
  })

  it('classifies delivery wording as H6', () => {
    expect(detectHardFacts('下单后自动交付，或商家人工处理，也可自动开通').filter(item => item.cls === 'H6').map(item => item.text))
      .toEqual(['下单后自动交付', '商家人工处理', '自动开通'])
  })

  it('ignores idiomatic 「一次性」 and 「一位」', () => {
    expect(extractTuples('一次性兑换码，每一位用户限购')).toEqual([])
  })

  it('maps region and platform synonyms to canonical ids', () => {
    expect(regionPlatformIds('美区账号')).toEqual(new Set(['region:us']))
    expect(regionPlatformIds('支持 iPhone 与安卓')).toEqual(new Set(['platform:ios', 'platform:android']))
    expect(regionPlatformIds('Machine learning')).toEqual(new Set())
  })

  it('classifies hard-fact mentions H1–H5', () => {
    const classes = detectHardFacts('30 天，永久有效，秒发，包退，美区').map(item => item.cls).sort()
    expect(classes).toEqual(['H1', 'H2', 'H3', 'H4', 'H5'])
  })

  it('flags markup, links and contact details', () => {
    expect(hasForbiddenMarkup('<b>粗体</b>')).toBe(true)
    expect(hasForbiddenMarkup('访问 https://example.com')).toBe(true)
    expect(hasForbiddenMarkup('联系 a@b.cn')).toBe(true)
    expect(hasForbiddenMarkup('致电 13812345678')).toBe(true)
    expect(hasForbiddenMarkup('登录后在个人中心兑换')).toBe(false)
  })
})
