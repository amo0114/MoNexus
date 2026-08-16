// CategoryCoverField.test.tsx — category default-cover upload/preview/
// replace/remove widget (SPEC-CMI-UX-001 §5.4; AC-UX-009/012/014/016/017).

import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PlatformMediaRef } from '../../types/catalog'
import CategoryCoverField from './CategoryCoverField'

vi.mock('../../api/uploads', () => ({
  uploadImage: vi.fn(),
}))

import { uploadImage } from '../../api/uploads'

const mockedUpload = vi.mocked(uploadImage)

function makeFile(): File {
  return new File(['fake-image'], 'cover.webp', { type: 'image/webp' })
}

/** Stateful harness mirroring the form: onChange updates the draft `value`. */
function Harness({ existingUrl = null }: { existingUrl?: string | null }) {
  const [value, setValue] = useState<PlatformMediaRef | null | undefined>(undefined)
  return (
    <CategoryCoverField existingUrl={existingUrl} value={value} onChange={setValue} testId="cover" />
  )
}

describe('CategoryCoverField — preview', () => {
  it('previews the existing canonical URL (legacy read-only, AC-UX-009)', () => {
    render(
      <CategoryCoverField
        existingUrl="/assets/category/network.webp"
        value={undefined}
        onChange={vi.fn()}
        testId="cover"
      />,
    )
    const preview = screen.getByTestId('cover-preview') as HTMLImageElement
    expect(preview.getAttribute('src')).toBe('/assets/category/network.webp')
    expect(preview.getAttribute('alt')).toBe('分类默认封面预览')
  })

  it('previews a static ref path', () => {
    render(
      <CategoryCoverField
        existingUrl={null}
        value={{ kind: 'static', path: '/assets/category/static.webp' }}
        onChange={vi.fn()}
        testId="cover"
      />,
    )
    const preview = screen.getByTestId('cover-preview') as HTMLImageElement
    expect(preview.getAttribute('src')).toBe('/assets/category/static.webp')
  })

  it('renders an upload call-to-action when no cover is present (AC-UX-012)', () => {
    render(
      <CategoryCoverField existingUrl={null} value={undefined} onChange={vi.fn()} required testId="cover" />,
    )
    expect(screen.getByText('上传图片')).toBeInTheDocument()
    expect(screen.getByLabelText('默认封面 *')).toBeInTheDocument()
  })
})

describe('CategoryCoverField — upload / replace / remove', () => {
  it('uploads a local image, reports objectKey and previews the returned URL (AC-UX-009/016)', async () => {
    mockedUpload.mockResolvedValue({ key: 'abc123.webp', url: 'http://localhost:3000/uploads/abc123.webp' })
    render(<Harness />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [makeFile()] } })

    const preview = await screen.findByTestId('cover-preview') as HTMLImageElement
    expect(preview.getAttribute('src')).toBe('http://localhost:3000/uploads/abc123.webp')
    expect(screen.getByText('替换图片')).toBeInTheDocument()
  })

  it('remove clears the preview and reports null (inactive remove is allowed)', async () => {
    mockedUpload.mockResolvedValue({ key: 'abc.webp', url: 'http://localhost:3000/uploads/abc.webp' })
    render(<Harness existingUrl="/assets/category/network.webp" />)
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [makeFile()] } })
    await screen.findByTestId('cover-preview')

    fireEvent.click(screen.getByText('移除封面'))
    expect(screen.queryByTestId('cover-preview')).not.toBeInTheDocument()
    expect(screen.getByText('上传图片')).toBeInTheDocument()
  })

  it('a failed upload surfaces an error and preserves the form draft (AC-UX-014)', async () => {
    mockedUpload.mockRejectedValue({ response: { data: { error: { message: '上传失败' } } } })
    const onChange = vi.fn()
    render(<CategoryCoverField existingUrl={null} value={undefined} onChange={onChange} testId="cover" />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [makeFile()] } })

    await waitFor(() => expect(screen.getByTestId('cover-action-error')).toBeInTheDocument())
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('CategoryCoverField — a11y (AC-UX-017)', () => {
  it('exposes a labelled, keyboard-operable file input with busy/error wiring', async () => {
    mockedUpload.mockImplementation(() => new Promise(() => {})) // never resolves → busy
    render(<CategoryCoverField existingUrl={null} value={undefined} onChange={vi.fn()} testId="cover" />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(fileInput).toHaveAttribute('aria-busy', 'false')
    fireEvent.change(fileInput, { target: { files: [makeFile()] } })
    await waitFor(() => expect(fileInput).toHaveAttribute('aria-busy', 'true'))
  })

  it('renders a form-level error with role=alert (AC-UX-012)', () => {
    render(
      <CategoryCoverField
        existingUrl={null}
        value={undefined}
        onChange={vi.fn()}
        required
        error="请上传分类默认封面"
        testId="cover"
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('请上传分类默认封面')
  })
})
