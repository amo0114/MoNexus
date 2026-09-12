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
})
