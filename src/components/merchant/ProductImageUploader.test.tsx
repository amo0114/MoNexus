import { useState, type Dispatch, type SetStateAction } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import ProductImageUploader from './ProductImageUploader'
import { useAppStore } from '../../stores/appStore'

vi.mock('../../api/uploads', () => ({
  uploadImage: vi.fn(),
  UploadError: class UploadError extends Error {
    constructor(message: string, public code: string) {
      super(message)
    }
  },
}))

vi.mock('../ui/ImageCropDialog', () => ({
  default: ({
    open,
    onConfirm,
  }: {
    open: boolean
    onConfirm: (blob: Blob) => void | Promise<void>
  }) =>
    open ? (
      <button
        type="button"
        data-testid="crop-confirm"
        onClick={() => { void onConfirm(new Blob(['x'], { type: 'image/jpeg' })) }}
      >
        确认并上传
      </button>
    ) : null,
}))

import { uploadImage } from '../../api/uploads'

const mockedUpload = vi.mocked(uploadImage)

function makeFile(name = 'cover.webp'): File {
  return new File(['fake-image'], name, { type: 'image/webp' })
}

function Harness({
  initialImages = [],
  initialKeys = {},
}: {
  initialImages?: string[]
  initialKeys?: Record<string, string>
}) {
  const [images, setImages] = useState<string[]>(initialImages)
  const [imageKeys, setImageKeys] = useState<Record<string, string>>(initialKeys)
  return (
    <div>
      <ProductImageUploader
        images={images}
        imageKeys={imageKeys}
        onChange={setImages}
        onImageKeysChange={setImageKeys}
      />
      <pre data-testid="tracked-keys">{JSON.stringify(imageKeys)}</pre>
      <pre data-testid="tracked-urls">{JSON.stringify(images)}</pre>
    </div>
  )
}

describe('ProductImageUploader objectKey tracking', () => {
  beforeEach(() => {
    useAppStore.setState({ toasts: [] })
    mockedUpload.mockReset()
    if (typeof URL.createObjectURL !== 'function') {
      URL.createObjectURL = vi.fn(() => 'blob:mock')
    }
    if (typeof URL.revokeObjectURL !== 'function') {
      URL.revokeObjectURL = vi.fn()
    }
  })

  it('keeps the upload objectKey across add and remove', async () => {
    mockedUpload.mockResolvedValue({
      key: 'objects/cover.webp',
      url: 'https://files.example/cover.webp',
    })
    render(<Harness />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [makeFile()] } })
    fireEvent.click(await screen.findByTestId('crop-confirm'))

    await waitFor(() => {
      expect(JSON.parse(screen.getByTestId('tracked-urls').textContent ?? '[]')).toEqual([
        'https://files.example/cover.webp',
      ])
    })
    expect(JSON.parse(screen.getByTestId('tracked-keys').textContent ?? '{}')).toEqual({
      'https://files.example/cover.webp': 'objects/cover.webp',
    })

    fireEvent.click(screen.getByLabelText('删除第 1 张'))
    await waitFor(() => {
      expect(JSON.parse(screen.getByTestId('tracked-urls').textContent ?? '[]')).toEqual([])
    })
    expect(JSON.parse(screen.getByTestId('tracked-keys').textContent ?? '{}')).toEqual({})
  })

  it('does not invent an objectKey for a direct external URL', () => {
    const onChange: Dispatch<SetStateAction<string[]>> = vi.fn()
    const onImageKeysChange: Dispatch<SetStateAction<Record<string, string>>> = vi.fn()
    render(
      <ProductImageUploader
        images={[]}
        imageKeys={{}}
        onChange={onChange}
        onImageKeysChange={onImageKeysChange}
      />,
    )

    fireEvent.change(screen.getByTestId('product-image-url-input'), {
      target: { value: 'https://cdn.example/hotlink.webp' },
    })
    fireEvent.click(screen.getByTestId('product-image-url-hotlink'))

    expect(onChange).toHaveBeenCalled()
    expect(onImageKeysChange).not.toHaveBeenCalled()
  })

  it('allows toggling and applying visual presets directly', () => {
    const onChange: Dispatch<SetStateAction<string[]>> = vi.fn()
    const onImageKeysChange: Dispatch<SetStateAction<Record<string, string>>> = vi.fn()
    render(
      <ProductImageUploader
        images={[]}
        imageKeys={{}}
        onChange={onChange}
        onImageKeysChange={onImageKeysChange}
      />,
    )

    // Initially preset panel is not open
    expect(screen.queryByTestId('product-image-presets-panel')).not.toBeInTheDocument()

    // Toggle open presets panel
    const toggleBtn = screen.getByTestId('product-image-presets-toggle')
    fireEvent.click(toggleBtn)
    expect(screen.getByTestId('product-image-presets-panel')).toBeInTheDocument()

    // Verify all 4 presets are listed
    expect(screen.getByTestId('product-preset-ai_token')).toBeInTheDocument()
    expect(screen.getByTestId('product-preset-cloud_license')).toBeInTheDocument()
    expect(screen.getByTestId('product-preset-membership_pass')).toBeInTheDocument()
    expect(screen.getByTestId('product-preset-dev_tools')).toBeInTheDocument()

    // Click on preset
    fireEvent.click(screen.getByTestId('product-preset-ai_token'))

    // onChange is called to append the static path; onImageKeysChange is not called (static asset)
    expect(onChange).toHaveBeenCalled()
    expect(onImageKeysChange).not.toHaveBeenCalled()
  })
})
