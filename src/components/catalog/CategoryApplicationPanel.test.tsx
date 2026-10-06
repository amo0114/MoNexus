import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogGovernanceAdapter } from '../../api/catalogGovernance'
import { fixtureApplicationList, fixtureApplications } from '../../api/catalogGovernance.fixtures'
import CategoryApplicationPanel from './CategoryApplicationPanel'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'

function adapter(overrides: Partial<CatalogGovernanceAdapter> = {}): CatalogGovernanceAdapter {
  return {
    listMyApplications: vi.fn().mockResolvedValue(fixtureApplicationList),
    createApplication: vi.fn().mockResolvedValue(fixtureApplications[0]),
    withdrawApplication: vi.fn().mockResolvedValue({ ...fixtureApplications[0], status: 'withdrawn' }),
    ...overrides,
  } as unknown as CatalogGovernanceAdapter
}

describe('CategoryApplicationPanel', () => {
  it('renders status/history, preserves the selected filter and exposes no internal fields', async () => {
    const api = adapter()
    const { container } = render(<CategoryApplicationPanel adapter={api} />)

    expect(await screen.findByTestId('application-row-101')).toHaveAttribute('data-status', 'pending')
    expect(screen.getByTestId('application-resolution-102')).toHaveTextContent('新建分类')
    expect(container).not.toHaveTextContent('reviewedByUserId')

    fireEvent.change(screen.getByTestId('merchant-application-status-filter'), { target: { value: 'approved' } })
    await waitFor(() => expect(api.listMyApplications).toHaveBeenLastCalledWith({
      status: 'approved', page: 1, pageSize: 10,
    }))
  })

  it('validates create input and prevents a second submit while the request is in flight', async () => {
    let resolve!: (value: typeof fixtureApplications[number]) => void
    const pending = new Promise<typeof fixtureApplications[number]>((r) => { resolve = r })
    const createApplication = vi.fn().mockReturnValue(pending)
    const api = adapter({ createApplication })
    render(<CategoryApplicationPanel adapter={api} />)
    await screen.findByTestId('application-row-101')

    fireEvent.click(screen.getByTestId('merchant-application-create'))
    fireEvent.change(screen.getByTestId('application-form-label'), { target: { value: '云工具' } })
    fireEvent.change(screen.getByTestId('application-form-description'), {
      target: { value: '这是一个用于验证分类申请流程的完整描述文本。' },
    })
    const submit = screen.getByTestId('application-form-submit')
    fireEvent.click(submit)
    expect(submit).toBeDisabled()
    fireEvent.click(submit)
    expect(createApplication).toHaveBeenCalledTimes(1)
    expect(createApplication).toHaveBeenCalledWith({
      proposedLabel: '云工具',
      description: '这是一个用于验证分类申请流程的完整描述文本。',
    })
    resolve(fixtureApplications[0])
    await waitFor(() => expect(screen.queryByTestId('application-form-submit')).not.toBeInTheDocument())
  })

})


function mobile() {
  vi.spyOn(window, 'matchMedia').mockImplementation(media => ({ matches: media.includes('767'), media, addEventListener() {}, removeEventListener() {} }) as MediaQueryList)
  useAppStore.setState({ islandNoticeAvailable: true })
}
function fillApplication() {
  fireEvent.click(screen.getByTestId('merchant-application-create'))
  fireEvent.change(screen.getByTestId('application-form-label'), {target:{value:'云工具'}})
  fireEvent.change(screen.getByTestId('application-form-description'), {target:{value:'这是一份完整的分类描述，供平台审核分类申请时进行参考。'}})
}
beforeEach(() => useAppStore.setState({islandNotice:null,islandQueue:[],islandNoticeAvailable:false,modalDepth:0,toasts:[]}))
afterEach(() => vi.restoreAllMocks())

it('shows the server-confirmed application after closing and offers its history', async () => {
  mobile()
  const onViewApplications=vi.fn()
  const api=adapter()
  render(<CategoryApplicationPanel adapter={api} onViewApplications={onViewApplications}/>)
  await screen.findByTestId('application-row-101')
  fillApplication()
  fireEvent.click(screen.getByTestId('application-form-submit'))
  await waitFor(()=>expect(useAppStore.getState().islandNotice?.title).toBe('分类申请已提交'))
  await waitFor(()=>expect(useAppStore.getState().modalDepth).toBe(0))
  const notice=useAppStore.getState().islandNotice!
  expect(notice.subtitle).toContain(fixtureApplications[0].proposedLabel)
  expect(notice.groupKey).toBe('merchant:category-application:101')
  expect(JSON.stringify(notice)).not.toContain('这是一份完整的分类描述')
  act(()=>notice.onAction?.())
  expect(onViewApplications).toHaveBeenCalledOnce()
})

it('requires confirmation for withdrawal and merges the resulting notice for the same application', async () => {
  mobile()
  const api=adapter()
  render(<CategoryApplicationPanel adapter={api}/>)
  await screen.findByTestId('application-row-101')
  useAppStore.getState().triggerIslandActivity({kind:'notification',title:'分类申请已提交',groupKey:'merchant:category-application:101'})
  fireEvent.click(screen.getByTestId('application-withdraw-101'))
  expect(api.withdrawApplication).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
  await waitFor(()=>expect(useAppStore.getState().islandNotice?.title).toBe('分类申请已撤回'))
  expect(useAppStore.getState().islandQueue).toHaveLength(0)
  expect(useAppStore.getState().islandNotice?.subtitle).toContain('已撤回')
})

it('preserves inputs on create failure and never reports withdrawal success after a review conflict', async () => {
  mobile()
  const api=adapter({
    createApplication:vi.fn().mockRejectedValue({response:{data:{error:{code:'CATEGORY_APPLICATION_PENDING_DUPLICATE',message:'重复申请'}}}}),
    withdrawApplication:vi.fn().mockRejectedValue({response:{data:{error:{code:'CATEGORY_APPLICATION_ALREADY_REVIEWED',message:'已审核'}}}}),
  })
  render(<CategoryApplicationPanel adapter={api}/>)
  await screen.findByTestId('application-row-101')
  fillApplication()
  fireEvent.click(screen.getByTestId('application-form-submit'))
  await screen.findByTestId('application-form-error')
  expect(screen.getByTestId('application-form-label')).toHaveValue('云工具')
  expect(useAppStore.getState().islandNotice).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'取消',exact:true}))
  fireEvent.click(screen.getByTestId('application-withdraw-101'))
  fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
  await waitFor(()=>expect(screen.queryByTestId('confirm-dialog-confirm')).toBeNull())
  expect(useAppStore.getState().islandNotice).toBeNull()
  expect(useAppStore.getState().toasts.some(t=>t.message==='该申请已被审核或已撤回，无法撤回')).toBe(true)
})

it('drops a late submission from an ended session', async () => {
  mobile()
  let resolve!: (value: typeof fixtureApplications[number]) => void
  const api=adapter({createApplication:vi.fn().mockImplementation(()=>new Promise(r=>{resolve=r}))})
  render(<CategoryApplicationPanel adapter={api}/>)
  await screen.findByTestId('application-row-101')
  fillApplication()
  fireEvent.click(screen.getByTestId('application-form-submit'))
  act(()=>useAuthStore.setState({authEpoch:useAuthStore.getState().authEpoch+1}))
  await act(async()=>resolve(fixtureApplications[0]))
  expect(useAppStore.getState().islandNotice).toBeNull()
  expect(screen.queryByTestId('application-form-submit')).toBeNull()
})

it('preserves the desktop submission message', async () => {
  render(<CategoryApplicationPanel adapter={adapter()}/>)
  await screen.findByTestId('application-row-101')
  fillApplication()
  fireEvent.click(screen.getByTestId('application-form-submit'))
  await waitFor(()=>expect(useAppStore.getState().toasts.some(t=>t.message==='分类申请已提交，等待平台审核')).toBe(true))
  expect(useAppStore.getState().islandNotice).toBeNull()
})
