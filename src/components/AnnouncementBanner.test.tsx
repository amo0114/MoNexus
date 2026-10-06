import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AnnouncementBanner from './AnnouncementBanner'
import ActionIslandNotice from './ActionIslandNotice'
import { useAppStore } from '../stores/appStore'
import type { PublicAnnouncement } from '../types/admin'
const notice = {id:1,version:1,title:'平台更新',content:'更新详情',presentation:'notice',maxImpressions:3} as PublicAnnouncement
const visible = () => {}
function Host({ suppressed = false }) {
  const item = useAppStore(s=>s.islandNotice)
  return <ActionIslandNotice notice={item} suppressed={suppressed} onVisibleChange={visible}/>
}
const props = () => ({items:[notice],shouldShowNotice:()=>true,recordNoticeImpression:vi.fn(),dismissNotice:vi.fn(),onOpen:vi.fn()})
beforeEach(()=>{
  vi.spyOn(window,'matchMedia').mockImplementation(media=>({matches:media.includes('767'),media,addEventListener(){},removeEventListener(){}}) as MediaQueryList)
  vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}})
  useAppStore.setState({islandNotice:null,islandQueue:[],islandNoticeAvailable:true})
})
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()})
it('counts only a visible impression; opening is not dismissing or acknowledging',()=>{
  const p=props()
  const view=render(<><AnnouncementBanner {...p}/><Host suppressed/></>)
  expect(p.recordNoticeImpression).not.toHaveBeenCalled()
  expect(screen.queryByTestId('announcement-banner')).toBeNull()
  view.rerender(<><AnnouncementBanner {...p}/><Host/></>)
  expect(p.recordNoticeImpression).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button',{name:'查看公告'}))
  expect(p.onOpen).toHaveBeenCalledWith(notice)
  expect(p.dismissNotice).not.toHaveBeenCalled()
})
it('persists explicit dismissal and cancels withdrawn queued notices',()=>{
  const p=props()
  const view=render(<><AnnouncementBanner {...p}/><Host/></>)
  fireEvent.click(screen.getByRole('button',{name:'收起通知'}))
  expect(p.dismissNotice).toHaveBeenCalledWith(notice)
  view.unmount()
  act(()=>{useAppStore.getState().triggerIslandActivity({kind:'order_processing',title:'支付中'})})
  const queued=render(<AnnouncementBanner {...props()}/>)
  expect(useAppStore.getState().islandQueue).toHaveLength(1)
  queued.rerender(<AnnouncementBanner {...props()} items={[]}/>)
  expect(useAppStore.getState().islandQueue).toHaveLength(0)
  expect(useAppStore.getState().islandNotice?.title).toBe('支付中')
})
it('keeps important and required announcements in the banner',()=>{
  const p=props()
  const view=render(<AnnouncementBanner {...p} items={[{...notice,presentation:'important'}]}/>)
  expect(screen.getByTestId('announcement-banner')).toBeInTheDocument()
  view.rerender(<AnnouncementBanner {...p} items={[{...notice,presentation:'acknowledgement_required'}]}/>)
  expect(screen.getByRole('button',{name:'查看并确认'})).toBeInTheDocument()
  expect(useAppStore.getState().islandNotice).toBeNull()
})

it('preserves the desktop banner and counts its impression without creating an island', () => {
  vi.spyOn(window,'matchMedia').mockImplementation(media=>({matches:false,media,addEventListener(){},removeEventListener(){}}) as MediaQueryList)
  const p=props()
  render(<AnnouncementBanner {...p}/>)
  expect(screen.getByTestId('announcement-banner')).toBeInTheDocument()
  expect(p.recordNoticeImpression).toHaveBeenCalledOnce()
  expect(useAppStore.getState().islandNotice).toBeNull()
})
