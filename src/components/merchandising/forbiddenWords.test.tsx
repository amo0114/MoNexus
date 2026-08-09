// Forbidden-word scan across every merchandising component (T-MERCH-FE-001).
// The spec bans certification/guarantee phrasing (spec §8.3 / implement §6.3 /
// CHK-ID-004): 平台认证 / 官方认证 / 平台担保 / 质量保证. These must never
// appear in the rendered DOM of the badge/disclosure/shelf primitives.

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DISPLAY_LABEL, type BadgeSpec, type MerchandisingProjection } from '../../types/merchandising'
import BadgeMark from './BadgeMark'
import EditorialShelf, { type EditorialShelfItem } from './EditorialShelf'
import MerchantPartnerMark from './MerchantPartnerMark'
import SponsoredShelf, { type SponsoredShelfProps } from './SponsoredShelf'

const FORBIDDEN_WORDS = ['平台认证', '官方认证', '平台担保', '质量保证'] as const

const badges: BadgeSpec[] = [
  { code: 'platform_owned', label: DISPLAY_LABEL.PLATFORM_OWNED },
  { code: 'platform_pick', label: DISPLAY_LABEL.PLATFORM_PICK },
  { code: 'hot', label: DISPLAY_LABEL.HOT },
]

const merchandising: MerchandisingProjection = {
  rankingRunId: '00000000-0000-0000-0000-000000000000',
  hot: { effectiveOrders: 18, rank: 2, windowDays: 30, computedAt: '2026-08-09T00:00:00.000Z' },
  platformOwned: true,
  platformPick: { label: '平台精选', publicReason: '本周上新' },
  merchantPartner: { label: '平台合作伙伴', validUntil: '2026-09-08T00:00:00.000Z' },
}

function assertNoForbiddenWords(text: string) {
  for (const word of FORBIDDEN_WORDS) {
    expect(text).not.toContain(word)
  }
}

describe('merchandising primitives — forbidden words absent from rendered DOM', () => {
  it('BadgeMark', () => {
    render(<BadgeMark badges={badges} />)
    assertNoForbiddenWords(document.body.textContent ?? '')
  })

  it('SponsoredShelf (with all disclosures)', () => {
    const props: SponsoredShelfProps = {
      items: [
        { productId: 1, disclosure: { code: 'sponsored', label: DISPLAY_LABEL.SPONSORED } },
        { productId: 2, disclosure: { code: 'sponsored', label: DISPLAY_LABEL.SPONSORED } },
      ],
      title: DISPLAY_LABEL.SPONSORED,
      renderItem: () => <div>商品</div>,
    }
    render(<SponsoredShelf {...props} />)
    assertNoForbiddenWords(document.body.textContent ?? '')
  })

  it('EditorialShelf', () => {
    const items: EditorialShelfItem[] = [
      { id: 1, platformPick: { label: '平台精选', publicReason: '本周上新' } },
    ]
    render(<EditorialShelf items={items} renderItem={() => <div>商品</div>} />)
    assertNoForbiddenWords(document.body.textContent ?? '')
  })

  it('MerchantPartnerMark (label + non-guarantee tooltip)', () => {
    render(<MerchantPartnerMark merchantPartner={merchandising.merchantPartner} />)
    assertNoForbiddenWords(document.body.textContent ?? '')
  })

  it('combined fixture (all primitives at once)', () => {
    render(
      <div>
        <BadgeMark badges={badges} />
        <SponsoredShelf
          items={[{ productId: 1, disclosure: { code: 'sponsored', label: DISPLAY_LABEL.SPONSORED } }]}
          renderItem={() => <div>商品</div>}
        />
        <EditorialShelf
          items={[{ id: 2, platformPick: { label: '平台精选', publicReason: null } }]}
          renderItem={() => <div>商品</div>}
        />
        <MerchantPartnerMark merchantPartner={merchandising.merchantPartner} />
      </div>,
    )
    assertNoForbiddenWords(document.body.textContent ?? '')
  })
})
