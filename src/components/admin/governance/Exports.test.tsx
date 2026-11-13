import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportButton, ExportJobList, compactFilters } from './Exports'
import * as governanceApi from '../../../api/governance'
import { useCapabilitiesStore } from '../../../stores/adminCapabilities'
import { useAuthStore } from '../../../stores/authStore'
import { fx, networkError } from '../../../test/governanceFixtures'
import type { GVExportJob } from '../../../types/governance'

vi.mock('../../../api/governance', () => ({
  getAdminCapabilities: vi.fn(),
  createExport: vi.fn(),
  listExports: vi.fn(),
  getExport: vi.fn(),
  requestExportDownload: vi.fn(),
}))

const api = vi.mocked(governanceApi)
const page = (items: GVExportJob[]) => ({ items, pageInfo: { nextCursor: null, hasNextPage: false }, asOf: '2026-11-12T08:00:00.000Z' })

function jobsWithDistinctIds(): GVExportJob[] {
  return fx.exports().map((j, i) => ({
    ...j,
    id: `00000000-0000-4000-8000-00000000010${i}`,
    // Keep the succeeded fixture downloadable regardless of the wall clock.
    expiresAt: j.status === 'succeeded' ? '2999-01-01T00:00:00.000Z' : j.expiresAt,
  }))
}

beforeEach(() => {
  vi.resetAllMocks()
  useAuthStore.setState({ user: { id: 1, email: 'a@example.invalid', role: 'admin', status: '正常', points: 0, merchant: null }, sessionId: 's', authEpoch: 1 })
  useCapabilitiesStore.setState({
    identity: '1:s:1',
    state: { status: 'ready', capabilities: { ...fx.capabilitiesOperator(), permissions: ['exports.create', 'users.read', 'orders.read'] } },
  })
})
afterEach(() => vi.useRealTimers())

describe('export job list', () => {
  it('expresses every job state and only offers download for a live succeeded job', async () => {
    api.listExports.mockResolvedValue(page(jobsWithDistinctIds()))
    render(<ExportJobList />)
    const rows = await screen.findAllByTestId(/^export-job-0/)
    const byStatus = Object.fromEntries(rows.map((r) => [r.dataset.status, r]))

    expect(within(byStatus.queued).getByTestId('export-job-status')).toHaveTextContent('排队中')
    expect(within(byStatus.running).getByText('正在上传文件')).toBeInTheDocument()
    expect(within(byStatus.failed).getByText(/超出单次导出上限/)).toBeInTheDocument()
    expect(within(byStatus.expired).getByText(/需要重新发起导出/)).toBeInTheDocument()
    expect(within(byStatus.expired).queryByTestId('export-job-download')).not.toBeInTheDocument()
    expect(within(byStatus.queued).queryByTestId('export-job-download')).not.toBeInTheDocument()
    expect(within(byStatus.succeeded).getByTestId('export-job-download')).toBeInTheDocument()
    // snapshotAt is the worker's materialization time, labelled as such.
    expect(within(byStatus.queued).getByText(/快照 尚未生成/)).toBeInTheDocument()
  })

  it('requests a short-lived URL only on click and never stores it', async () => {
    const succeeded = jobsWithDistinctIds().find((j) => j.status === 'succeeded')!
    api.listExports.mockResolvedValue(page([succeeded]))
    api.requestExportDownload.mockResolvedValue({ url: 'https://storage.example.invalid/signed', expiresAt: '2999-01-01T00:00:00.000Z' })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    render(<ExportJobList />)

    expect(api.requestExportDownload).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByTestId('export-job-download'))
    await waitFor(() => expect(click).toHaveBeenCalled())
    expect(api.requestExportDownload).toHaveBeenCalledWith(succeeded.id)
    expect(setItem.mock.calls.flat().join()).not.toContain('signed')
  })

  it('polls pending jobs until they finish', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const queued = jobsWithDistinctIds().find((j) => j.status === 'queued')!
    api.listExports.mockResolvedValue(page([queued]))
    api.getExport.mockResolvedValue({ ...queued, status: 'succeeded', expiresAt: '2999-01-01T00:00:00.000Z', rowCount: 2, byteSize: 512 })
    render(<ExportJobList />)
    await screen.findByTestId(`export-job-${queued.id}`)
    await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
    await waitFor(() => expect(screen.getByTestId(`export-job-${queued.id}`)).toHaveAttribute('data-status', 'succeeded'))
  })
})

describe('ExportButton', () => {
  it('queues the fixed kind with compacted filters and reuses the key after an unconfirmed attempt', async () => {
    api.createExport.mockRejectedValueOnce(networkError()).mockResolvedValueOnce(jobsWithDistinctIds()[0])
    api.listExports.mockResolvedValue(page([]))
    render(<ExportButton kind="users" filters={{ q: 'abc', role: undefined, accountStatus: 'banned' }} />)

    fireEvent.click(screen.getByTestId('export-button-users'))
    await waitFor(() => expect(api.createExport).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId('export-button-users'))
    await waitFor(() => expect(api.createExport).toHaveBeenCalledTimes(2))

    const [first, second] = api.createExport.mock.calls
    expect(first[0]).toEqual({ kind: 'users', filters: { q: 'abc', accountStatus: 'banned' } })
    expect(second[1]).toBe(first[1])
  })

  it('is hidden without the read permission for that kind', () => {
    render(<ExportButton kind="point_logs" filters={{}} />)
    expect(screen.queryByTestId('export-button-point_logs')).not.toBeInTheDocument()
  })

  it('drops blank filter values', () => {
    expect(compactFilters({ q: '', userId: 3, from: undefined })).toEqual({ userId: 3 })
  })
})
