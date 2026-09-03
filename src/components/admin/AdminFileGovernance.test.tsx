import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import AdminFileGovernance from './AdminFileGovernance'
import { useAppStore } from '../../stores/appStore'

const mocks = vi.hoisted(() => ({
  listFiles: vi.fn(),
  listGrants: vi.fn(),
  revokeFile: vi.fn(),
}))

vi.mock('../../api/adminFiles', () => ({
  listAdminDeliveryFiles: mocks.listFiles,
  listAdminFileGrants: mocks.listGrants,
  revokeAdminDeliveryFile: mocks.revokeFile,
}))

const filesFixture = [
  {
    id: 10,
    fileName: 'alpha.zip',
    size: 1048576,
    mimeType: 'application/zip',
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    status: 'active',
    merchantId: 1,
    merchant: { name: '商家A' },
    refCounts: { offers: 1, deliveryRecords: 2 },
    createdAt: '2026-09-01T00:00:00.000Z',
  },
  {
    id: 20,
    fileName: 'beta.zip',
    size: 2097152,
    mimeType: 'application/zip',
    sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
    status: 'active',
    merchantId: 2,
    merchant: { name: '商家B' },
    refCounts: { offers: 2, deliveryRecords: 1 },
    createdAt: '2026-09-02T00:00:00.000Z',
  },
]

describe('AdminFileGovernance race condition & consistency protection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [] })
    mocks.listFiles.mockResolvedValue({ items: filesFixture, total: 2 })
  })

  it('prevents file grants from leaking across files when older request resolves late', async () => {
    let resolveFile1Grants: ((data: any) => void) | undefined

    mocks.listGrants.mockImplementation((fileId: number) => {
      if (fileId === 10) {
        return new Promise((resolve) => {
          resolveFile1Grants = resolve
        })
      }
      if (fileId === 20) {
        return Promise.resolve({
          items: [
            {
              id: 201,
              fileId: 20,
              userId: 2,
              user: { id: 2, email: 'target-file20-user@test.com' },
              orderId: 2002,
              createdAt: '2026-09-02T10:00:00.000Z',
            },
          ],
          total: 1,
        })
      }
      return Promise.resolve({ items: [], total: 0 })
    })

    render(<AdminFileGovernance />)
    expect(await screen.findByText('alpha.zip')).toBeInTheDocument()

    const viewGrantsBtns = screen.getAllByRole('button', { name: '查看流水' })

    // Expand file 10 first (in-flight, unresolved)
    fireEvent.click(viewGrantsBtns[0])
    expect(mocks.listGrants).toHaveBeenCalledWith(10, expect.any(Object))

    // Rapidly expand file 20 (resolves immediately)
    fireEvent.click(viewGrantsBtns[1])
    expect(mocks.listGrants).toHaveBeenCalledWith(20, expect.any(Object))

    // File 20's grant should be displayed
    expect(await screen.findByText('订单 #2002')).toBeInTheDocument()

    // File 10 resolves afterwards with its own grant
    resolveFile1Grants?.({
      items: [
        {
          id: 101,
          fileId: 10,
          userId: 1,
          orderId: 1001,
          outcome: 'granted',
          role: 'customer',
          createdAt: '2026-09-01T10:00:00.000Z',
        },
      ],
      total: 1,
    })

    // Allow any pending promises to run
    await waitFor(() => {
      expect(screen.getByText('订单 #2002')).toBeInTheDocument()
    })

    // Stale grant from file 10 MUST NOT leak into file 20's panel
    expect(screen.queryByText('订单 #1001')).not.toBeInTheDocument()
  })

  it('drops in-flight file grants when expanded file is collapsed', async () => {
    let resolveGrants: ((data: any) => void) | undefined
    mocks.listGrants.mockImplementation(() => new Promise((resolve) => { resolveGrants = resolve }))

    render(<AdminFileGovernance />)
    expect(await screen.findByText('alpha.zip')).toBeInTheDocument()

    const viewGrantsBtn = screen.getAllByRole('button', { name: '查看流水' })[0]
    fireEvent.click(viewGrantsBtn)

    // Collapse file 10 before response arrives
    fireEvent.click(screen.getByRole('button', { name: '收起流水' }))
    expect(screen.queryByText('收起流水')).not.toBeInTheDocument()

    // Late response returns
    resolveGrants?.({
      items: [
        {
          id: 101,
          fileId: 10,
          userId: 1,
          user: { id: 1, email: 'collapsed-file-user@test.com' },
          orderId: 1001,
          createdAt: '2026-09-01T10:00:00.000Z',
        },
      ],
      total: 1,
    })

    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText('collapsed-file-user@test.com')).not.toBeInTheDocument()
  })
})
