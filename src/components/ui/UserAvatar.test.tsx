import { render, fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import UserAvatar from './UserAvatar'
import { AVATAR_PRESETS } from '../../lib/avatarPresets'

describe('UserAvatar', () => {
  it('falls back on a broken image and loads the next selected URL', () => {
    const a = AVATAR_PRESETS[0]
    const { container, rerender } = render(<UserAvatar url={a.url} name="明月" size={44} />)
    expect(container.querySelector('img')).toHaveAttribute('sizes', '44px')
    expect(container.querySelector('img')).toHaveAttribute('srcset', expect.stringContaining('96w'))
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('明')).toBeInTheDocument()
    rerender(<UserAvatar url="https://files.example/avatar.jpg" name="明月" />)
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://files.example/avatar.jpg')
    expect(container.querySelector('img')).not.toHaveAttribute('srcset')
  })

  it('assigns a deterministic Three Kingdoms preset avatar when url is null/empty', () => {
    const { container: c1 } = render(<UserAvatar name="merchant" size={40} />)
    const img1 = c1.querySelector('img')
    expect(img1).not.toBeNull()
    const src1 = img1?.getAttribute('src')
    expect(src1).toContain('/assets/avatars/three-kingdoms/v2.3/')

    // Same name consistently gets the exact same avatar
    const { container: c2 } = render(<UserAvatar name="merchant" size={40} />)
    const img2 = c2.querySelector('img')
    expect(img2?.getAttribute('src')).toBe(src1)

    // Different name gets an avatar
    const { container: c3 } = render(<UserAvatar name="alice" size={40} />)
    const img3 = c3.querySelector('img')
    expect(img3).not.toBeNull()
    expect(img3?.getAttribute('src')).toContain('/assets/avatars/three-kingdoms/v2.3/')
  })

  it('can be opted out with disableDefaultPreset to show letter initial', () => {
    const { container } = render(<UserAvatar name="George" size={40} disableDefaultPreset />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('G')).toBeInTheDocument()
  })
})
