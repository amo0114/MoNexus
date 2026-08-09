import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import ProductPublicationChecklist from './ProductPublicationChecklist'
import {
  catalogFixtureReadinessNotReady,
  catalogFixtureReadinessReady,
} from '../../api/catalog.fixtures'
import { READINESS_DETAIL_CODES } from '../../types/catalog'
import { getReadinessIssueMessage } from '../../api/catalog'

/**
 * ProductPublicationChecklist contract/a11y tests (T-CAT-FE-001A, spec §6.1).
 *
 * The checklist renders stable readiness `details[].code` values as human
 * copy; the machine code stays available via `data-code` and is never parsed
 * from prose. Unknown codes render a safe generic message.
 */
describe('ProductPublicationChecklist (spec §6.1)', () => {
  it('shows the ready state when ready', () => {
    render(<ProductPublicationChecklist issues={catalogFixtureReadinessReady.issues} />)
    expect(screen.getByTestId('publication-ready')).toHaveTextContent('已满足发布条件')
    expect(screen.queryByTestId('publication-issues')).not.toBeInTheDocument()
    // No publish CTA unless onPublish is provided.
    expect(screen.queryByTestId('publication-publish')).not.toBeInTheDocument()
  })

  it('lists every readiness issue with its stable code and human copy', () => {
    render(<ProductPublicationChecklist issues={catalogFixtureReadinessNotReady.issues} />)
    const issues = screen.getAllByTestId('readiness-issue')
    expect(issues).toHaveLength(2)

    const [cover, offer] = issues
    expect(cover).toHaveAttribute('data-code', READINESS_DETAIL_CODES.COVER_REQUIRED)
    expect(cover).toHaveTextContent(getReadinessIssueMessage(READINESS_DETAIL_CODES.COVER_REQUIRED))
    expect(cover).not.toHaveTextContent('规格')

    expect(offer).toHaveAttribute('data-code', READINESS_DETAIL_CODES.OFFER_NOT_SELLABLE)
    expect(offer).toHaveTextContent(getReadinessIssueMessage(READINESS_DETAIL_CODES.OFFER_NOT_SELLABLE))
    // Offer-scoped issue exposes the target offer id.
    expect(offer).toHaveTextContent('规格 42')
  })

  it('renders the stable code for tooling even though it is visually hidden', () => {
    render(<ProductPublicationChecklist issues={catalogFixtureReadinessNotReady.issues} />)
    const issue = screen.getAllByTestId('readiness-issue')[0]
    expect(issue.querySelector('.sr-only')).toHaveTextContent(
      READINESS_DETAIL_CODES.COVER_REQUIRED,
    )
    // The mono code chip is aria-hidden (human text already carries meaning).
    expect(issue.querySelector('[aria-hidden="true"]')).toHaveTextContent(
      READINESS_DETAIL_CODES.COVER_REQUIRED,
    )
  })

  it('falls back to a safe generic message for unknown readiness codes', () => {
    render(
      <ProductPublicationChecklist
        issues={[{ code: 'SOME_NEW_BACKEND_CODE', field: 'offers', offerId: null }]}
      />,
    )
    const issue = screen.getByTestId('readiness-issue')
    expect(issue).toHaveAttribute('data-code', 'SOME_NEW_BACKEND_CODE')
    expect(issue).toHaveTextContent(getReadinessIssueMessage('SOME_NEW_BACKEND_CODE'))
  })

  it('shows a generic not-ready row when not ready with no detail codes', () => {
    render(<ProductPublicationChecklist issues={[]} ready={false} />)
    const issue = screen.getByTestId('readiness-issue')
    expect(issue).toHaveAttribute('data-code', '')
    expect(issue).toHaveTextContent('发布条件尚未全部满足')
  })

  it('gates the publish CTA on ready and keeps it keyboard operable when allowed', () => {
    const onPublish = vi.fn()
    const { rerender } = render(
      <ProductPublicationChecklist
        issues={catalogFixtureReadinessNotReady.issues}
        onPublish={onPublish}
      />,
    )
    const button = screen.getByTestId('publication-publish')
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onPublish).not.toHaveBeenCalled()

    rerender(
      <ProductPublicationChecklist issues={[]} ready onPublish={onPublish} />,
    )
    expect(screen.getByTestId('publication-publish')).toBeEnabled()
    fireEvent.click(screen.getByTestId('publication-publish'))
    expect(onPublish).toHaveBeenCalledTimes(1)
  })

  it('disables the CTA while publishing and shows in-flight copy', () => {
    const onPublish = vi.fn()
    render(<ProductPublicationChecklist issues={[]} ready onPublish={onPublish} publishing />)
    const button = screen.getByTestId('publication-publish')
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('发布中…')
  })

  it('honors an external disabled state', () => {
    render(<ProductPublicationChecklist issues={[]} ready onPublish={vi.fn()} disabled />)
    expect(screen.getByTestId('publication-publish')).toBeDisabled()
  })

  it('is accessible: labelled region and CTA is a native button', () => {
    render(<ProductPublicationChecklist issues={[]} ready onPublish={vi.fn()} />)
    expect(screen.getByRole('region', { name: '发布检查清单' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /发布商品/ })).toBeInTheDocument()
  })
})
