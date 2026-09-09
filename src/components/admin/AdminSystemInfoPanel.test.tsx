import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as adminBuildInfoApi from '../../api/adminBuildInfo'
import AdminSystemInfoPanel from './AdminSystemInfoPanel'

vi.mock('../../api/adminBuildInfo', () => ({
  getAdminBuildInfo: vi.fn(),
}))

describe('AdminSystemInfoPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders unavailable copy when the artifact is missing', async () => {
    vi.mocked(adminBuildInfoApi.getAdminBuildInfo).mockResolvedValue({
      version: null,
      commit: null,
      builtAt: null,
      environment: 'test',
      releaseTag: null,
      source: 'unavailable',
    })

    render(<AdminSystemInfoPanel />)

    expect(await screen.findByTestId('admin-system-info-unavailable')).toHaveTextContent('构建信息未提供')
    expect(screen.getByTestId('admin-system-info-version')).toHaveTextContent('构建信息未提供')
    expect(screen.getByTestId('admin-system-info-commit')).toHaveTextContent('构建信息未提供')
    expect(screen.getByTestId('admin-system-info-built-at')).toHaveTextContent('构建信息未提供')
    expect(screen.getByTestId('admin-system-info-release-tag')).toHaveTextContent('构建信息未提供')
    expect(screen.getByTestId('admin-system-info-environment')).toHaveTextContent('test')
    expect(screen.queryByTestId('admin-system-info-copy-commit')).not.toBeInTheDocument()
    expect(screen.queryByText('1.0.0')).not.toBeInTheDocument()
  })

  it('renders artifact fields and empty-tag copy when present', async () => {
    vi.mocked(adminBuildInfoApi.getAdminBuildInfo).mockResolvedValue({
      version: '1.2.3-dev.9+sha.0123456',
      commit: '0123456789abcdef0123456789abcdef01234567',
      builtAt: '2026-09-09T08:00:00.000Z',
      environment: 'production',
      releaseTag: null,
      source: 'build_artifact',
    })

    render(<AdminSystemInfoPanel />)

    await waitFor(() => {
      expect(screen.getByTestId('admin-system-info-version')).toHaveTextContent('1.2.3-dev.9+sha.0123456')
    })
    expect(screen.queryByTestId('admin-system-info-unavailable')).not.toBeInTheDocument()
    expect(screen.getByTestId('admin-system-info-commit')).toHaveTextContent('0123456')
    expect(screen.getByTestId('admin-system-info-built-at')).toHaveTextContent('2026-09-09T08:00:00.000Z')
    expect(screen.getByTestId('admin-system-info-release-tag')).toHaveTextContent('未记录标签')
    expect(screen.getByTestId('admin-system-info-copy-commit')).toBeInTheDocument()
  })
})
