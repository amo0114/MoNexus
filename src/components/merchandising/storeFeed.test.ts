// storeFeed.test.ts — pure feed composer red/green tests
// (SPEC-CMI-UX-001 §4.2; REQ-UX-FEED-001~006; AC-UX-002/003/006/008).

import { describe, expect, it } from 'vitest'
import {
  composeStoreFeed,
  FIRST_SCREEN_SLOT_COUNT,
  MAX_EDITORIAL_PER_SCREEN,
  MAX_SPONSORED_PER_SCREEN,
  type FeedOutputItem,
  type FeedProductLike,
} from './storeFeed'

interface P extends FeedProductLike {
  name: string
}

function product(id: number): P {
  return { id, name: `P${id}` }
}

function organic(range: [number, number]): P[] {
  const items: P[] = []
  for (let id = range[0]; id <= range[1]; id++) items.push(product(id))
  return items
}

function feedItems(items: FeedOutputItem<P>[]) {
  return items.map(item => ({ kind: item.kind, id: item.productId }))
}

describe('composeStoreFeed — first 12 slots (AC-UX-002)', () => {
  it('places 2 sponsored + 1 editorial at the frozen template positions with 9 organic', () => {
    const result = composeStoreFeed({
      organic: organic([1, 12]),
      sponsored: [{ productId: 101, product: product(101) }, { productId: 102, product: product(102) }],
      editorial: [{ productId: 201, product: product(201), publicReason: '编辑精选' }],
      searchQuery: '',
    })

    // Template: O,O,S,O,O,E,O,O,S,O,O,O — 9 organic + S1 + E1 + S2 = 12;
    // the remaining O10,O11,O12 are appended right after slot 12 (rule 5).
    expect(result.items).toHaveLength(15)
    expect(result.items.slice(0, 12).map(item => item.kind)).toEqual([
      'organic', 'organic', 'sponsored', 'organic', 'organic', 'editorial',
      'organic', 'organic', 'sponsored', 'organic', 'organic', 'organic',
    ])
    expect(result.items[2].productId).toBe(101)
    expect(result.items[5].productId).toBe(201)
    expect(result.items[8].productId).toBe(102)
    // Appended unconsumed organic in original order.
    expect(result.items.slice(12).map(i => i.productId)).toEqual([10, 11, 12])
  })

  it('keeps the template exact even when extra candidates exist (only S1/S2/E1 used)', () => {
    const result = composeStoreFeed({
      organic: organic([1, 12]),
      sponsored: [
        { productId: 101, product: product(101) },
        { productId: 102, product: product(102) },
        { productId: 103, product: product(103) },
      ],
      editorial: [
        { productId: 201, product: product(201) },
        { productId: 202, product: product(202) },
      ],
      searchQuery: '',
    })
    expect(result.items.filter(i => i.kind === 'sponsored')).toHaveLength(MAX_SPONSORED_PER_SCREEN)
    expect(result.items.filter(i => i.kind === 'editorial')).toHaveLength(MAX_EDITORIAL_PER_SCREEN)
  })

  it('AC-UX-002 two-page example: O1..O12 loaded + 3 candidates → 12 blend then O10,O11,O12 appended', () => {
    const result = composeStoreFeed({
      organic: organic([1, 12]),
      sponsored: [{ productId: 101, product: product(101) }, { productId: 102, product: product(102) }],
      editorial: [{ productId: 201, product: product(201) }],
      searchQuery: '',
    })
    expect(result.items.map(i => i.productId)).toEqual([
      1, 2, 101, 3, 4, 201, 5, 6, 102, 7, 8, 9, 10, 11, 12,
    ])
  })
})

describe('composeStoreFeed — fallback and dedup (AC-UX-003)', () => {
  it('fills a missing editorial candidate with the next organic', () => {
    const result = composeStoreFeed({
      organic: organic([1, 12]),
      sponsored: [],
      editorial: [{ productId: 201, product: null }], // hydrate failed
      searchQuery: '',
    })
    expect(result.items).toHaveLength(12)
    expect(result.items.map(i => i.kind).every(k => k === 'organic')).toBe(true)
    expect(result.items.map(i => i.productId)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
  })

  it('fills a missing sponsored candidate with organic and keeps the second sponsored', () => {
    const result = composeStoreFeed({
      organic: organic([1, 12]),
      sponsored: [
        { productId: 101, product: null }, // hydrate failed
        { productId: 102, product: product(102) },
      ],
      editorial: [],
      searchQuery: '',
    })
    // Slot 3 falls back to O3; slot 9 still gets S2 (product 102).
    expect(result.items[2].kind).toBe('organic')
    expect(result.items[8].kind).toBe('sponsored')
    expect(result.items[8].productId).toBe(102)
    expect(result.items[0].productId).toBe(1)
    expect(result.items[2].productId).toBe(3)
  })

  it('sponsored wins over editorial and organic for the same productId (shown once)', () => {
    const result = composeStoreFeed({
      organic: organic([1, 12]),
      // product 5 is both sponsored and editorial; sponsored must win.
      sponsored: [{ productId: 5, product: product(5) }],
      editorial: [{ productId: 5, product: product(5), publicReason: 'x' }],
      searchQuery: '',
    })
    const seen = result.items.map(i => i.productId)
    expect(new Set(seen).size).toBe(seen.length)
    expect(result.items.filter(i => i.productId === 5)).toHaveLength(1)
    expect(result.items.find(i => i.productId === 5)?.kind).toBe('sponsored')
  })

  it('an organic item whose id was injected as sponsored is replaced, not duplicated', () => {
    // Product 3 appears in the organic list AND as a sponsored candidate.
    const result = composeStoreFeed({
      organic: organic([1, 12]),
      sponsored: [{ productId: 3, product: product(3) }],
      editorial: [],
      searchQuery: '',
    })
    const ids = result.items.map(i => i.productId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter(id => id === 3)).toHaveLength(1)
    expect(result.items.find(i => i.productId === 3)?.kind).toBe('sponsored')
  })
})

describe('composeStoreFeed — search bypass (AC-UX-006)', () => {
  it('returns organic only when a search query is present', () => {
    const result = composeStoreFeed({
      organic: organic([1, 5]),
      sponsored: [{ productId: 101, product: product(101) }],
      editorial: [{ productId: 201, product: product(201) }],
      searchQuery: '  账号  ',
    })
    expect(result.items.map(i => i.kind).every(k => k === 'organic')).toBe(true)
    expect(result.items.map(i => i.productId)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('composeStoreFeed — pagination never drops or duplicates (AC-UX-008)', () => {
  it('two pages with 3 candidates: every loaded organic appears exactly once, cursor untouched', () => {
    // Page 1: O1..O12 organic; page 2: O13..O24 (server cursor continues).
    const page1 = composeStoreFeed({
      organic: organic([1, 12]),
      sponsored: [{ productId: 101, product: product(101) }, { productId: 102, product: product(102) }],
      editorial: [{ productId: 201, product: product(201) }],
      searchQuery: '',
      seenProductIds: new Set(),
    })
    const page2 = composeStoreFeed({
      organic: organic([13, 24]),
      sponsored: [],
      editorial: [],
      searchQuery: '',
      seenProductIds: page1.seenProductIds,
    })
    const allIds = [...page1.items, ...page2.items].map(i => i.productId)
    // 12 + 12 organic + 3 candidates, no duplicates, order preserved per page.
    expect(new Set(allIds).size).toBe(allIds.length)
    expect(allIds).toEqual([
      1, 2, 101, 3, 4, 201, 5, 6, 102, 7, 8, 9, 10, 11, 12, // page1 blend + rest
      13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, // page2
    ])
    // The server cursor is a caller concern — the composer never rewrites it;
    // assert the seen set reflects every shown id exactly once.
    expect(page2.seenProductIds.size).toBe(27)
  })

  it('two pages with no candidates: plain organic, no gaps or repeats', () => {
    const page1 = composeStoreFeed({
      organic: organic([1, 8]),
      sponsored: [],
      editorial: [],
      searchQuery: '',
      seenProductIds: new Set(),
    })
    expect(page1.items).toHaveLength(8)
    const page2 = composeStoreFeed({
      organic: organic([9, 16]),
      sponsored: [],
      editorial: [],
      searchQuery: '',
      seenProductIds: page1.seenProductIds,
    })
    const ids = [...page1.items, ...page2.items].map(i => i.productId)
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    expect(new Set(ids).size).toBe(16)
  })

  it('insufficient organic (< 12): only the actual items are output, nothing invented', () => {
    const result = composeStoreFeed({
      organic: organic([1, 5]),
      sponsored: [{ productId: 101, product: product(101) }, { productId: 102, product: product(102) }],
      editorial: [{ productId: 201, product: product(201) }],
      searchQuery: '',
    })
    // Template consumes O1,O2 + S1 + O3,O4 + E1 + O5 then runs out: 8 items.
    expect(result.items.map(i => i.productId)).toEqual([1, 2, 101, 3, 4, 201, 5, 102])
    expect(result.items.length).toBeLessThan(FIRST_SCREEN_SLOT_COUNT)
  })

  it('page 2 dedups organic ids that were already injected on page 1', () => {
    const page1 = composeStoreFeed({
      organic: organic([1, 12]),
      sponsored: [{ productId: 3, product: product(3) }], // injected, replaces organic 3
      editorial: [],
      searchQuery: '',
      seenProductIds: new Set(),
    })
    // Simulate a page 2 that (incorrectly) contains product 3 again — it must be dropped.
    const page2 = composeStoreFeed({
      organic: [product(3), ...organic([13, 20])],
      sponsored: [],
      editorial: [],
      searchQuery: '',
      seenProductIds: page1.seenProductIds,
    })
    const ids = [...page1.items, ...page2.items].map(i => i.productId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter(id => id === 3)).toHaveLength(1)
  })
})

describe('composeStoreFeed — purity', () => {
  it('does not mutate its inputs', () => {
    const organicInput = organic([1, 12])
    const sponsoredInput = [{ productId: 101, product: product(101) }]
    const editorialInput = [{ productId: 201, product: product(201) }]
    const seenInput = new Set<number>([50])

    composeStoreFeed({
      organic: organicInput,
      sponsored: sponsoredInput,
      editorial: editorialInput,
      searchQuery: '',
      seenProductIds: seenInput,
    })

    expect(organicInput).toHaveLength(12)
    expect(sponsoredInput).toHaveLength(1)
    expect(editorialInput).toHaveLength(1)
    expect(seenInput.has(50)).toBe(true)
    expect(seenInput.size).toBe(1)
  })
})
