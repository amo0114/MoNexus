// storeFeed.ts — pure, framework-free unified store feed composer
// (SPEC-CMI-UX-001 §4; REQ-UX-FEED-001~006).
//
// This module has NO React, NO network, NO store access. It is a deterministic
// pure function: the same inputs always yield the same outputs and the inputs
// are never mutated. All eligibility is decided by the backend before this
// function runs — this composer only arranges already-authorized candidates
// into one product stream (it never re-interprets campaign/editorial rules).
//
// Contract (spec §4.2):
//   - first 12 display slots use the fixed template O,O,S,O,O,E,O,O,S,O,O,O;
//   - at most 2 sponsored + 1 editorial candidates are injected (S1/S2/E1 are
//     positional: S1 = sponsored[0], S2 = sponsored[1], E1 = editorial[0]);
//   - a missing / expired / hydrate-failed candidate is filled by the next
//     organic product (no empty slot, no placeholder);
//   - the same productId appears at most once per session (sponsored wins over
//     editorial, which wins over organic);
//   - only the organic actually placed into the first 12 slots is consumed
//     there; the rest of the current cursor page is appended in original order
//     right after slot 12, so pagination never loses or duplicates an item;
//   - `searchQuery.trim() !== ''` returns organic only (no candidate injection);
//   - the server cursor is never rewritten here.

export interface FeedProductLike {
  id: number
}

/** A sponsored candidate after hydration; `product: null` means hydrate failed. */
export interface SponsoredFeedCandidate<P extends FeedProductLike> {
  productId: number
  product: P | null
}

/** An editorial candidate after hydration; `product: null` means hydrate failed. */
export interface EditorialFeedCandidate<P extends FeedProductLike> {
  productId: number
  product: P | null
  publicReason?: string | null
}

export type FeedItemKind = 'organic' | 'sponsored' | 'editorial'

/** One output card of the unified feed. */
export interface FeedOutputItem<P extends FeedProductLike> {
  kind: FeedItemKind
  productId: number
  product: P
  /** Editorial only: optional short public reason (display ≤40 chars). */
  publicReason?: string | null
}

export interface ComposeStoreFeedInput<P extends FeedProductLike> {
  /** The current cursor page's organic products (already fetched). */
  organic: P[]
  /** Sponsored candidates; only the first two usable ones are injected. */
  sponsored: SponsoredFeedCandidate<P>[]
  /** Editorial candidates; only the first usable one is injected. */
  editorial: EditorialFeedCandidate<P>[]
  /** Non-empty → search mode: organic only, no injection. */
  searchQuery: string
  /** productIds already shown in this session (previous pages). */
  seenProductIds?: ReadonlySet<number>
}

export interface ComposeStoreFeedResult<P extends FeedProductLike> {
  /** Blended items in final display order for this batch. */
  items: FeedOutputItem<P>[]
  /** Session seen set: previous + every item placed this call. */
  seenProductIds: Set<number>
}

/** Frozen 12-slot template (D-UX-03): O,O,S,O,O,E,O,O,S,O,O,O. */
const FIRST_SCREEN_TEMPLATE: ReadonlyArray<'O' | 'S' | 'E'> = [
  'O', 'O', 'S', 'O', 'O', 'E', 'O', 'O', 'S', 'O', 'O', 'O',
]

export const FIRST_SCREEN_SLOT_COUNT = FIRST_SCREEN_TEMPLATE.length
export const MAX_SPONSORED_PER_SCREEN = 2
export const MAX_EDITORIAL_PER_SCREEN = 1

export function composeStoreFeed<P extends FeedProductLike>(
  input: ComposeStoreFeedInput<P>,
): ComposeStoreFeedResult<P> {
  const seen = new Set<number>(input.seenProductIds ?? [])
  const items: FeedOutputItem<P>[] = []

  // Rule 9 (D-UX-02): a non-empty search query means "results stay relevant" —
  // only organic is returned, never an injected candidate.
  if (input.searchQuery.trim() !== '') {
    for (const product of input.organic) {
      if (seen.has(product.id)) continue
      seen.add(product.id)
      items.push({ kind: 'organic', productId: product.id, product })
    }
    return { items, seenProductIds: seen }
  }

  // Pass 1 — which sponsored ids are actually placed (positional S1/S2).
  // Precomputing lets us enforce "sponsored > editorial" even when the
  // editorial slot is processed before the second sponsored slot.
  const placedSponsoredIds = new Set<number>()
  for (let i = 0; i < MAX_SPONSORED_PER_SCREEN && i < input.sponsored.length; i++) {
    const candidate = input.sponsored[i]!
    if (candidate.product != null && !seen.has(candidate.productId)) {
      placedSponsoredIds.add(candidate.productId)
    }
  }

  let sponsoredIndex = 0
  let editorialIndex = 0
  // Organic consumption cursor — only the organic actually placed in the first
  // 12 slots advances this pointer (rule 5: the rest of the page follows).
  let organicIndex = 0

  const takeSponsored = (): SponsoredFeedCandidate<P> | null => {
    if (sponsoredIndex >= input.sponsored.length) return null
    const candidate = input.sponsored[sponsoredIndex]!
    sponsoredIndex += 1
    return candidate
  }

  const takeEditorial = (): EditorialFeedCandidate<P> | null => {
    if (editorialIndex >= input.editorial.length) return null
    const candidate = input.editorial[editorialIndex]!
    editorialIndex += 1
    return candidate
  }

  const takeNextOrganic = (): P | null => {
    while (organicIndex < input.organic.length) {
      const candidate = input.organic[organicIndex]!
      organicIndex += 1
      if (seen.has(candidate.id)) continue
      return candidate
    }
    return null
  }

  const place = (item: FeedOutputItem<P>) => {
    seen.add(item.productId)
    items.push(item)
  }

  for (const slot of FIRST_SCREEN_TEMPLATE) {
    let placed = false
    if (slot === 'S') {
      const candidate = takeSponsored()
      if (candidate && candidate.product != null && !seen.has(candidate.productId)) {
        place({ kind: 'sponsored', productId: candidate.productId, product: candidate.product })
        placed = true
      }
    } else if (slot === 'E') {
      const candidate = takeEditorial()
      if (
        candidate
        && candidate.product != null
        && !seen.has(candidate.productId)
        && !placedSponsoredIds.has(candidate.productId)
      ) {
        place({
          kind: 'editorial',
          productId: candidate.productId,
          product: candidate.product,
          publicReason: candidate.publicReason ?? null,
        })
        placed = true
      }
    }
    // O slot, or an S/E slot with a missing/dup/hydrate-failed candidate →
    // the next organic fills (rule 3).
    if (!placed) {
      const nextOrganic = takeNextOrganic()
      if (nextOrganic) {
        place({ kind: 'organic', productId: nextOrganic.id, product: nextOrganic })
      }
    }
  }

  // Rule 5/6: every remaining loaded organic of this page is appended in its
  // original order right after slot 12 — nothing is dropped or duplicated.
  for (; organicIndex < input.organic.length; organicIndex++) {
    const product = input.organic[organicIndex]!
    if (seen.has(product.id)) continue
    place({ kind: 'organic', productId: product.id, product })
  }

  return { items, seenProductIds: seen }
}
