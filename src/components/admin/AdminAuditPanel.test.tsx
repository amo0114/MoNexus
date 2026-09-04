import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import AdminAuditPanel from './AdminAuditPanel'
import * as adminAuditApi from '../../api/adminAudit'
import { useAppStore } from '../../stores/appStore'

vi.mock('../../api/adminAudit', () => ({
  listAdminAudit: vi.fn(),
}))

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: any) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('AdminAuditPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [] })
  })

  it('renders TableSkeleton during initial load and does not prematurely show EmptyState', async () => {
    const deferred = createDeferred<any>()
    vi.mocked(adminAuditApi.listAdminAudit).mockReturnValueOnce(deferred.promise)

    render(<AdminAuditPanel active={true} />)

    // Skeleton is rendered, table and empty state are not visible yet
    expect(screen.queryByTestId('admin-audit-table')).not.toBeInTheDocument()
    expect(screen.queryByText('暂无审计记录')).not.toBeInTheDocument()

    deferred.resolve({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    })

    expect(await screen.findByText('暂无审计记录')).toBeInTheDocument()
  })

  it('renders known action and targetType with Chinese labels and tones, without metadata column or detail', async () => {
    vi.mocked(adminAuditApi.listAdminAudit).mockResolvedValueOnce({
      items: [
        {
          id: 1,
          adminId: 10,
          adminEmail: 'admin@test.local',
          action: '封禁用户',
          targetType: 'user',
          targetId: 888,
          createdAt: '2026-09-04T12:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    render(<AdminAuditPanel active={true} />)

    const table = await screen.findByTestId('admin-audit-table')
    expect(within(table).getByText('封禁用户')).toBeInTheDocument()
    expect(within(table).getByText('用户')).toBeInTheDocument()
    expect(within(table).getByText('#888')).toBeInTheDocument()
    expect(within(table).getByText('U10')).toBeInTheDocument()
    expect(within(table).getByText('(admin@test.local)')).toBeInTheDocument()

    // Does NOT render "元数据" column
    expect(screen.queryByText('元数据')).not.toBeInTheDocument()
  })

  it('safely degrades unknown action/targetType without exposing internal raw codes in DOM', async () => {
    vi.mocked(adminAuditApi.listAdminAudit).mockResolvedValueOnce({
      items: [
        {
          id: 2,
          adminId: 12,
          adminEmail: 'sec@test.local',
          action: 'internal_secret_action_v2',
          targetType: 'internal_secret_target_entity',
          targetId: null,
          createdAt: '2026-09-04T12:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    render(<AdminAuditPanel active={true} />)

    const table = await screen.findByTestId('admin-audit-table')

    // Falls back to safe localized Chinese labels
    expect(within(table).getByText('其他操作')).toBeInTheDocument()
    expect(within(table).getByText('其他对象')).toBeInTheDocument()

    // Raw internal strings MUST NOT leak into the DOM
    expect(screen.queryByText('internal_secret_action_v2')).not.toBeInTheDocument()
    expect(screen.queryByText('internal_secret_target_entity')).not.toBeInTheDocument()
  })

  it('renders "无特定对象" when targetType is null and does not fake a targetId', async () => {
    vi.mocked(adminAuditApi.listAdminAudit).mockResolvedValueOnce({
      items: [
        {
          id: 3,
          adminId: 1,
          adminEmail: 'root@test.local',
          action: '更新系统配置',
          targetType: null,
          targetId: null,
          createdAt: '2026-09-04T12:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    render(<AdminAuditPanel active={true} />)

    const table = await screen.findByTestId('admin-audit-table')
    expect(within(table).getByText('更新系统配置')).toBeInTheDocument()
    expect(within(table).getByText('无特定对象')).toBeInTheDocument()
    expect(within(table).queryByText('#')).not.toBeInTheDocument()
  })

  it('blocks API call and sets aria-invalid/aria-describedby when adminId is invalid', async () => {
    vi.mocked(adminAuditApi.listAdminAudit).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    })

    render(<AdminAuditPanel active={true} />)
    await waitFor(() => expect(adminAuditApi.listAdminAudit).toHaveBeenCalledTimes(1))
    vi.mocked(adminAuditApi.listAdminAudit).mockClear()

    const adminIdInput = screen.getByLabelText('管理员ID')
    const searchBtn = screen.getByTestId('admin-audit-search-btn')

    // Test non-positive integer
    fireEvent.change(adminIdInput, { target: { value: '0' } })
    fireEvent.click(searchBtn)

    expect(adminAuditApi.listAdminAudit).not.toHaveBeenCalled()
    expect(adminIdInput).toHaveAttribute('aria-invalid', 'true')
    expect(adminIdInput).toHaveAttribute('aria-describedby', 'admin-audit-id-error')
    expect(screen.getByTestId('admin-audit-id-error')).toHaveTextContent('管理员 ID 必须为有效的正整数')

    // Editing clears error
    fireEvent.change(adminIdInput, { target: { value: '12' } })
    expect(adminIdInput).toHaveAttribute('aria-invalid', 'false')
    expect(screen.queryByTestId('admin-audit-id-error')).not.toBeInTheDocument()
  })

  it('blocks API call and sets aria-invalid/aria-describedby when fromDate > toDate', async () => {
    vi.mocked(adminAuditApi.listAdminAudit).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    })

    render(<AdminAuditPanel active={true} />)
    await waitFor(() => expect(adminAuditApi.listAdminAudit).toHaveBeenCalledTimes(1))
    vi.mocked(adminAuditApi.listAdminAudit).mockClear()

    const fromInput = screen.getByLabelText('开始日期')
    const toInput = screen.getByLabelText('结束日期')
    const searchBtn = screen.getByTestId('admin-audit-search-btn')

    fireEvent.change(fromInput, { target: { value: '2026-05-10' } })
    fireEvent.change(toInput, { target: { value: '2026-05-05' } })
    fireEvent.click(searchBtn)

    expect(adminAuditApi.listAdminAudit).not.toHaveBeenCalled()
    expect(fromInput).toHaveAttribute('aria-invalid', 'true')
    expect(toInput).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByTestId('admin-audit-date-error')).toHaveTextContent('开始日期不能晚于结束日期')

    // Changing either date clears error
    fireEvent.change(toInput, { target: { value: '2026-05-12' } })
    expect(fromInput).toHaveAttribute('aria-invalid', 'false')
    expect(toInput).toHaveAttribute('aria-invalid', 'false')
    expect(screen.queryByTestId('admin-audit-date-error')).not.toBeInTheDocument()
  })

  it('search applies snapshot, resets to page 1, and fires exactly one request', async () => {
    vi.mocked(adminAuditApi.listAdminAudit).mockResolvedValue({
      items: [
        {
          id: 1,
          adminId: 88,
          adminEmail: 'admin88@test.local',
          action: '封禁用户',
          targetType: 'user',
          targetId: 9,
          createdAt: '2026-09-04T12:00:00.000Z',
        },
      ],
      total: 25,
      page: 1,
      pageSize: 20,
    })

    render(<AdminAuditPanel active={true} />)
    await waitFor(() => expect(adminAuditApi.listAdminAudit).toHaveBeenCalledWith({ page: 1, pageSize: 20 }))

    // Paginate to page 2
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(adminAuditApi.listAdminAudit).toHaveBeenCalledWith({ page: 2, pageSize: 20 }))

    vi.mocked(adminAuditApi.listAdminAudit).mockClear()

    // Modify filters
    fireEvent.change(screen.getByLabelText('管理员ID'), { target: { value: '88' } })
    fireEvent.change(screen.getByLabelText('操作动作'), { target: { value: '封禁用户' } })
    fireEvent.change(screen.getByLabelText('目标对象'), { target: { value: 'user' } })
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-05-01' } })
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-05-31' } })

    // No request fired yet
    expect(adminAuditApi.listAdminAudit).not.toHaveBeenCalled()

    // Click search
    fireEvent.click(screen.getByTestId('admin-audit-search-btn'))

    expect(adminAuditApi.listAdminAudit).toHaveBeenCalledTimes(1)
    expect(adminAuditApi.listAdminAudit).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      adminId: 88,
      action: '封禁用户',
      targetType: 'user',
      fromDate: '2026-05-01',
      toDate: '2026-05-31',
    })
  })

  it('reset clears all filters, resets to page 1, and fires exactly one request', async () => {
    vi.mocked(adminAuditApi.listAdminAudit).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    })

    render(<AdminAuditPanel active={true} />)
    await waitFor(() => expect(adminAuditApi.listAdminAudit).toHaveBeenCalledTimes(1))
    vi.mocked(adminAuditApi.listAdminAudit).mockClear()

    const adminIdInput = screen.getByLabelText('管理员ID')
    const actionSelect = screen.getByLabelText('操作动作')
    const targetSelect = screen.getByLabelText('目标对象')
    const fromInput = screen.getByLabelText('开始日期')
    const toInput = screen.getByLabelText('结束日期')

    fireEvent.change(adminIdInput, { target: { value: '99' } })
    fireEvent.change(actionSelect, { target: { value: '更新分类' } })
    fireEvent.change(targetSelect, { target: { value: 'productCategory' } })
    fireEvent.change(fromInput, { target: { value: '2026-06-01' } })
    fireEvent.change(toInput, { target: { value: '2026-06-10' } })

    fireEvent.click(screen.getByTestId('admin-audit-reset-btn'))

    expect(adminAuditApi.listAdminAudit).toHaveBeenCalledTimes(1)
    expect(adminAuditApi.listAdminAudit).toHaveBeenCalledWith({ page: 1, pageSize: 20 })

    expect(adminIdInput).toHaveValue('')
    expect(actionSelect).toHaveValue('')
    expect(targetSelect).toHaveValue('')
    expect(fromInput).toHaveValue('')
    expect(toInput).toHaveValue('')
  })

  it('pagination carries applied filters snapshot', async () => {
    vi.mocked(adminAuditApi.listAdminAudit).mockResolvedValue({
      items: [
        {
          id: 1,
          adminId: 77,
          adminEmail: 'a@test.local',
          action: '增加积分',
          targetType: 'user',
          targetId: 1,
          createdAt: '2026-09-04T12:00:00.000Z',
        },
      ],
      total: 45,
      page: 1,
      pageSize: 20,
    })

    render(<AdminAuditPanel active={true} />)
    await waitFor(() => expect(adminAuditApi.listAdminAudit).toHaveBeenCalledTimes(1))

    // Set filter and search
    fireEvent.change(screen.getByLabelText('管理员ID'), { target: { value: '77' } })
    fireEvent.click(screen.getByTestId('admin-audit-search-btn'))
    await waitFor(() =>
      expect(adminAuditApi.listAdminAudit).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 20,
        adminId: 77,
      })
    )

    // Modify input without clicking search (draft only)
    fireEvent.change(screen.getByLabelText('管理员ID'), { target: { value: '999' } })

    // Click next page
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() =>
      expect(adminAuditApi.listAdminAudit).toHaveBeenLastCalledWith({
        page: 2,
        pageSize: 20,
        adminId: 77, // uses applied filter snapshot (77), NOT draft (999)
      })
    )
  })

  it('slow older request does not overwrite faster newer request', async () => {
    let resolveSlow: any
    vi.mocked(adminAuditApi.listAdminAudit).mockImplementation((query) => {
      if (query?.adminId === 10) {
        return new Promise((res) => {
          resolveSlow = res
        })
      }
      return Promise.resolve({
        items: [
          {
            id: 99,
            adminId: 20,
            adminEmail: 'fast@test.local',
            action: '解封用户',
            targetType: 'user',
            targetId: 2,
            createdAt: '2026-09-04T12:00:00.000Z',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      })
    })

    render(<AdminAuditPanel active={true} />)

    // Trigger slow search (adminId: 10)
    fireEvent.change(screen.getByLabelText('管理员ID'), { target: { value: '10' } })
    fireEvent.click(screen.getByTestId('admin-audit-search-btn'))

    // Trigger fast search (adminId: 20)
    fireEvent.change(screen.getByLabelText('管理员ID'), { target: { value: '20' } })
    fireEvent.click(screen.getByTestId('admin-audit-search-btn'))

    // Fast search renders
    const table = await screen.findByTestId('admin-audit-table')
    expect(within(table).getByText('解封用户')).toBeInTheDocument()

    // Slow search resolves afterwards
    resolveSlow?.({
      items: [
        {
          id: 1,
          adminId: 10,
          adminEmail: 'slow@test.local',
          action: '封禁用户',
          targetType: 'user',
          targetId: 1,
          createdAt: '2026-09-04T12:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    await new Promise((r) => setTimeout(r, 20))

    // Fast search remains, slow search is ignored
    expect(within(table).getByText('解封用户')).toBeInTheDocument()
    expect(within(table).queryByText('封禁用户')).not.toBeInTheDocument()
  })

  it('inactive panel ignores late responses without side effects', async () => {
    const deferred = createDeferred<any>()
    vi.mocked(adminAuditApi.listAdminAudit).mockReturnValueOnce(deferred.promise)

    const { rerender } = render(<AdminAuditPanel active={true} />)

    // Deactivate panel
    rerender(<AdminAuditPanel active={false} />)

    // Settle promise with rejection
    deferred.reject(new Error('late error'))
    await new Promise((r) => setTimeout(r, 20))

    expect(useAppStore.getState().toasts).toHaveLength(0)
  })

  it('renders ErrorState with retry button on initial load failure and recovers on retry', async () => {
    vi.mocked(adminAuditApi.listAdminAudit).mockRejectedValueOnce(new Error('网络连接异常'))

    render(<AdminAuditPanel active={true} />)

    expect(await screen.findByText('网络连接异常')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()

    // Mock recovery response
    vi.mocked(adminAuditApi.listAdminAudit).mockResolvedValueOnce({
      items: [
        {
          id: 1,
          adminId: 1,
          adminEmail: 'root@test.local',
          action: '创建分类',
          targetType: 'productCategory',
          targetId: 5,
          createdAt: '2026-09-04T12:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    const table = await screen.findByTestId('admin-audit-table')
    expect(within(table).getByText('创建分类')).toBeInTheDocument()
    expect(screen.queryByText('网络连接异常')).not.toBeInTheDocument()
  })

  it('preserves existing table data and shows toast error on refresh failure', async () => {
    vi.mocked(adminAuditApi.listAdminAudit).mockResolvedValueOnce({
      items: [
        {
          id: 1,
          adminId: 1,
          adminEmail: 'root@test.local',
          action: '创建商品',
          targetType: 'product',
          targetId: 10,
          createdAt: '2026-09-04T12:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    render(<AdminAuditPanel active={true} />)
    const table = await screen.findByTestId('admin-audit-table')
    expect(within(table).getByText('创建商品')).toBeInTheDocument()

    // Subsequent search fails
    vi.mocked(adminAuditApi.listAdminAudit).mockRejectedValueOnce(new Error('刷新失败'))

    fireEvent.click(screen.getByTestId('admin-audit-search-btn'))

    await waitFor(() => {
      expect(useAppStore.getState().toasts.some((t) => t.message === '刷新失败')).toBe(true)
    })

    // Existing row is still visible
    expect(within(table).getByText('创建商品')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
  })

  it('never renders sensitive payloads, raw tokens, passwords, emails, or detail/metadata into DOM even if present in raw items', async () => {
    const sensitiveRecord = {
      id: 999,
      adminId: 10,
      adminEmail: 'legit-admin@test.local',
      action: '创建商品',
      targetType: 'product',
      targetId: 888,
      createdAt: '2026-09-04T12:00:00.000Z',
      // Injected sensitive data
      detail: 'SENSITIVE_LONG_DETAIL_LOG_BODY_CONTENT_WITH_SECRET_INTERNAL_KEY_999888',
      metadata: {
        rawToken: 'secret-bearer-token-xyz-123456',
        userPasswordHash: 'sha256$super_secret_password_hash_val',
        leakedEmail: 'victim-sensitive-leaked@example.com',
        privateKey: 'BEGIN PRIVATE KEY-----MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC',
      },
    }

    vi.mocked(adminAuditApi.listAdminAudit).mockResolvedValueOnce({
      items: [sensitiveRecord as unknown as adminAuditApi.AdminAuditItem],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    const { container } = render(<AdminAuditPanel active={true} />)

    const table = await screen.findByTestId('admin-audit-table')
    expect(within(table).getByText('创建商品')).toBeInTheDocument()
    expect(within(table).getByText('商品')).toBeInTheDocument()
    expect(within(table).getByText('#888')).toBeInTheDocument()
    expect(within(table).getByText('U10')).toBeInTheDocument()
    expect(within(table).getByText('(legit-admin@test.local)')).toBeInTheDocument()

    // Explicit assertion: None of the sensitive values enter the DOM tree
    const domHtml = container.innerHTML
    expect(domHtml).not.toContain('SENSITIVE_LONG_DETAIL_LOG_BODY_CONTENT')
    expect(domHtml).not.toContain('SECRET_INTERNAL_KEY_999888')
    expect(domHtml).not.toContain('secret-bearer-token-xyz-123456')
    expect(domHtml).not.toContain('super_secret_password_hash_val')
    expect(domHtml).not.toContain('victim-sensitive-leaked@example.com')
    expect(domHtml).not.toContain('BEGIN PRIVATE KEY')

    // Explicit assertion: Raw field names do not enter the DOM tree or headers
    expect(domHtml).not.toContain('rawToken')
    expect(domHtml).not.toContain('userPasswordHash')
    expect(domHtml).not.toContain('privateKey')
    expect(screen.queryByText('元数据')).not.toBeInTheDocument()
    expect(screen.queryByText('详情')).not.toBeInTheDocument()
    expect(screen.queryByText('detail')).not.toBeInTheDocument()
    expect(screen.queryByText('metadata')).not.toBeInTheDocument()
  })

  it('safely drops in-flight responses when unmounted before late resolve or reject', async () => {
    let resolveFirst!: (val: adminAuditApi.AdminAuditListResponse) => void
    vi.mocked(adminAuditApi.listAdminAudit).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve
      }),
    )

    const { unmount: unmountFirst } = render(<AdminAuditPanel active={true} />)
    expect(screen.queryByTestId('admin-audit-table')).not.toBeInTheDocument()

    // Unmount before response arrives
    unmountFirst()

    // Late resolve should not trigger React state updates or errors on unmounted component
    resolveFirst({
      items: [
        {
          id: 1,
          adminId: 1,
          adminEmail: 'root@test.local',
          action: '创建商品',
          targetType: 'product',
          targetId: 10,
          createdAt: '2026-09-04T12:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    await new Promise((r) => setTimeout(r, 20))
    expect(useAppStore.getState().toasts).toHaveLength(0)

    // Late reject after unmount
    let rejectSecond!: (err: Error) => void
    vi.mocked(adminAuditApi.listAdminAudit).mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectSecond = reject
      }),
    )

    const { unmount: unmountSecond } = render(<AdminAuditPanel active={true} />)
    expect(screen.queryByTestId('admin-audit-table')).not.toBeInTheDocument()

    unmountSecond()

    // Late reject should be completely ignored (no toast emitted)
    rejectSecond(new Error('Late network disconnect after unmount'))

    await new Promise((r) => setTimeout(r, 20))
    expect(useAppStore.getState().toasts).toHaveLength(0)
  })
})
