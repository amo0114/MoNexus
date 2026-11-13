import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProductTraceSheet from './ProductTraceSheet'
import { listInventoryBatches, listOfferRevisions } from '../../../api/governance'
import { fx } from '../../../test/governanceFixtures'

vi.mock('../../../api/governance', () => ({
  listInventoryBatches: vi.fn(),
  getInventoryBatch: vi.fn(),
  voidInventoryBatch: vi.fn(),
  listOfferRevisions: vi.fn(),
}))

beforeEach(() => vi.resetAllMocks())

describe('ProductTraceSheet revisions', () => {
  it('renders an offer creation revision, which has no before snapshot', async () => {
    const page = fx.offerRevisions()
    const created = { ...page.items[0], revision: 1, actorType: 'system' as const, beforeSafe: null, changedFields: ['price'] }
    vi.mocked(listInventoryBatches).mockResolvedValue({ items: [], pageInfo: { nextCursor: null, hasNextPage: false }, asOf: page.asOf })
    vi.mocked(listOfferRevisions).mockResolvedValue({ ...page, items: [page.items[0], created] })
    render(
      <ProductTraceSheet scope="admin" product={{ id: 4, name: '示例', offers: [{ id: 4, name: '默认规格' }] }}
        canReadBatches canVoid={false} canReadRevisions onOpenChange={() => {}} />,
    )
    fireEvent.mouseDown(screen.getByRole('tab', { name: '规格修订' }))
    expect(await screen.findByTestId('offer-revision-1')).toHaveTextContent('初始配置')
    expect(screen.getByTestId('offer-revision-2')).toBeInTheDocument()
  })
})
