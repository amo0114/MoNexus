import { act, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HumanVerificationWidget from './HumanVerificationWidget'
import type { HumanVerificationHandle } from './humanVerificationTypes'
import { HUMAN_VERIFICATION_SOLVE_TIMEOUT_MS } from './humanVerificationTypes'

const getHumanChallenge = vi.fn()

vi.mock('../../api/auth', () => ({
  getHumanChallenge: (...args: unknown[]) => getHumanChallenge(...args),
}))

vi.mock('altcha', () => ({}))
vi.mock('altcha/i18n/zh-cn', () => ({}))

class FakeAltchaWidget extends HTMLElement {
  verifyCalls = 0
  resetCalls = 0

  async verify() {
    this.verifyCalls += 1
    this.dispatchEvent(new CustomEvent('statechange', {
      detail: { state: 'verified', payload: `altcha-proof-${this.verifyCalls}` },
    }))
  }

  reset() {
    this.resetCalls += 1
    this.dispatchEvent(new CustomEvent('statechange', { detail: { state: 'unverified' } }))
  }

  expireOnce() {
    this.dispatchEvent(new CustomEvent('statechange', { detail: { state: 'expired' } }))
  }
}

const challenge = {
  algorithm: 'SHA-256',
  challenge: 'abc',
  maxnumber: 1000,
  salt: 'salt?action=register&nonce=aa&version=1&expires=1',
  signature: 'sig',
}

describe('HumanVerificationWidget', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', class {})
    if (!customElements.get('altcha-widget')) {
      customElements.define('altcha-widget', FakeAltchaWidget)
    }
    getHumanChallenge.mockReset()
    getHumanChallenge.mockResolvedValue(challenge)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('solves a same-origin challenge and returns a one-time in-memory proof', async () => {
    const ref = createRef<HumanVerificationHandle>()
    const onReadyChange = vi.fn()
    render(
      <HumanVerificationWidget
        ref={ref}
        action="register"
        descriptor={{ provider: 'altcha', challengeUrl: '/api/auth/human-challenge?action=register' }}
        onReadyChange={onReadyChange}
      />,
    )

    await waitFor(() => expect(getHumanChallenge).toHaveBeenCalledWith('register'))
    await waitFor(() => expect(onReadyChange).toHaveBeenCalledWith(true))

    const proof = await ref.current!.requestProof()
    expect(proof).toEqual({ provider: 'altcha', payload: 'altcha-proof-1' })
    expect(JSON.stringify(proof)).not.toContain('challengeUrl')
  })

  it('refreshes the challenge once after expiry', async () => {
    const { container } = render(
      <HumanVerificationWidget
        action="register"
        descriptor={{ provider: 'altcha', challengeUrl: '/api/auth/human-challenge?action=register' }}
      />,
    )

    await waitFor(() => expect(getHumanChallenge).toHaveBeenCalledTimes(1))
    const widget = container.querySelector('altcha-widget') as FakeAltchaWidget
    expect(widget).toBeTruthy()
    act(() => {
      widget.expireOnce()
    })
    await waitFor(() => expect(getHumanChallenge).toHaveBeenCalledTimes(2))
  })

  it('surfaces a 20s timeout instead of loading forever', async () => {
    vi.useFakeTimers()
    getHumanChallenge.mockImplementation(() => new Promise(() => undefined))
    render(
      <HumanVerificationWidget
        action="forgot_password"
        descriptor={{ provider: 'altcha', challengeUrl: '/api/auth/human-challenge?action=forgot_password' }}
      />,
    )

    await act(async () => {
      vi.advanceTimersByTime(HUMAN_VERIFICATION_SOLVE_TIMEOUT_MS)
    })
    expect(screen.getByText(/安全验证超时或暂不可用/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('re-solves after reset so a new in-memory proof is ready', async () => {
    const ref = createRef<HumanVerificationHandle>()
    const onReadyChange = vi.fn()
    render(
      <HumanVerificationWidget
        ref={ref}
        action="register"
        descriptor={{ provider: 'altcha', challengeUrl: '/api/auth/human-challenge?action=register' }}
        onReadyChange={onReadyChange}
      />,
    )
    await waitFor(() => expect(onReadyChange).toHaveBeenCalledWith(true))
    const firstProof = await ref.current!.requestProof()
    expect(firstProof.payload).toBe('altcha-proof-1')

    onReadyChange.mockClear()
    act(() => {
      ref.current!.reset()
    })
    const widget = document.querySelector('altcha-widget') as FakeAltchaWidget
    expect(widget.resetCalls).toBeGreaterThan(0)
    await waitFor(() => expect(onReadyChange).toHaveBeenCalledWith(true))
    expect(widget.verifyCalls).toBeGreaterThan(1)

    const secondProof = await ref.current!.requestProof()
    expect(secondProof).toEqual({ provider: 'altcha', payload: 'altcha-proof-2' })
    expect(secondProof.payload).not.toBe(firstProof.payload)
  })

  it('renders the turnstile adapter only from a turnstile descriptor', async () => {
    render(
      <HumanVerificationWidget
        action="register"
        descriptor={{ provider: 'turnstile', siteKey: 'public-test-site-key' }}
      />,
    )
    expect(getHumanChallenge).not.toHaveBeenCalled()
    expect(await screen.findByText(/正在加载安全验证/)).toBeInTheDocument()
  })

  it('shows an explicit unsupported message without Worker/WebCrypto', async () => {
    vi.stubGlobal('Worker', undefined)
    render(
      <HumanVerificationWidget
        action="register"
        descriptor={{ provider: 'altcha', challengeUrl: '/api/auth/human-challenge?action=register' }}
      />,
    )
    expect(await screen.findByText(/当前浏览器不支持安全验证/)).toBeInTheDocument()
    expect(getHumanChallenge).not.toHaveBeenCalled()
  })
})
