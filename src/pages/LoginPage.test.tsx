import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { PASSWORD_MIN_LENGTH, PASSWORD_RULE_HINT } from '../lib/passwordPolicy'

const { getRegistrationStatus } = vi.hoisted(() => ({
  getRegistrationStatus: vi.fn(),
}))

vi.mock('../api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/auth')>()
  return {
    ...actual,
    getRegistrationStatus,
  }
})

import LoginPage from './LoginPage'

describe('LoginPage password input', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getRegistrationStatus.mockResolvedValue({
      registrationEnabled: true,
      registrationAvailable: true,
      inviteRequired: false,
      challenge: null,
      legalRequirement: null,
    })
  })

  it('uses a neutral password label without exposing length policy on login', async () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(getRegistrationStatus).toHaveBeenCalledTimes(1))

    const input = screen.getByLabelText('密码')
    expect(input).toHaveAttribute('placeholder', '密码')
    expect(input).toHaveAttribute('autocomplete', 'current-password')
    expect(input).toBeRequired()
    expect(input).not.toHaveAttribute('minlength')
    expect(input).not.toHaveAttribute('aria-describedby')
    expect(screen.queryByText(/至少 6 位/)).toBeNull()
    expect(screen.queryByText(PASSWORD_RULE_HINT)).toBeNull()
  })

  it('enforces minimum length and associates the rule hint on registration', async () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(getRegistrationStatus).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: '没有账号？立即注册' }))

    const input = screen.getByLabelText('密码')
    expect(input).toHaveAttribute('placeholder', '密码')
    expect(input).toHaveAttribute('autocomplete', 'new-password')
    expect(input).toHaveAttribute('minlength', String(PASSWORD_MIN_LENGTH))
    expect(input).toHaveAttribute('aria-describedby', 'register-password-hint')
    expect(screen.getByText(PASSWORD_RULE_HINT)).toHaveAttribute('id', 'register-password-hint')
  })
})
