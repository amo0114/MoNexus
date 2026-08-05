import { test, expect, type Page, type Route } from '@playwright/test'
import { SEED_ACCOUNTS, loginAs } from './helpers'

/**
 * SPEC-LEADERBOARD-001 阶段 C（C.1）：排行榜页 UI 状态矩阵。
 *
 * 惯例同 registration-mail-operations.spec.ts（C16）：真实 loginAs 登录，
 * /api/leaderboard 用精确 pathname mock 铺出各状态；真实聚合/窗口/鉴权语义
 * 已由 server/src/__tests__/leaderboard.test.ts 的 23 个 Vitest 用例覆盖。
 */

const LEADERBOARD_PATH = '/api/leaderboard'

function pathIs(path: string) {
  return (url: URL) => url.pathname === path
}

type Scope = 'total' | 'month' | 'week'

type MockRow = { rank: number; displayName: string; points: number; isMe?: boolean; prevRank?: number | null }

const PERIOD: Record<Scope, { periodKey: string; periodLabel: string }> = {
  total: { periodKey: 'ALL', periodLabel: '全部' },
  month: { periodKey: 'M2026-08', periodLabel: '2026年8月' },
  week: { periodKey: 'W2026-07-27', periodLabel: '07-27 ~ 08-02' },
}

function payload(
  scope: Scope,
  top: MockRow[],
  opts: {
    me?: { rank: number; points: number; prevRank?: number | null } | null
    updatedAt?: string | null
    dataThrough?: string | null
  } = {}
) {
  return {
    scope,
    ...PERIOD[scope],
    dataThrough: opts.dataThrough === undefined ? '2026-07-31' : opts.dataThrough,
    updatedAt: opts.updatedAt === undefined ? '2026-07-31T16:05:00.000Z' : opts.updatedAt,
    top: top.map((row) => ({ isMe: false, ...row })),
    me: opts.me === undefined ? null : opts.me,
  }
}

function rows(count: number, prefix = '选手'): MockRow[] {
  return Array.from({ length: count }, (_, i) => ({
    rank: i + 1,
    displayName: `${prefix}${i + 1}`,
    points: 1000 - i * 50,
  }))
}

/** 逐 scope 供给响应体；记录实际请求过的 scope 供断言。 */
async function mockLeaderboard(
  page: Page,
  bodies: Partial<Record<Scope, unknown>>,
  requested?: string[]
) {
  await page.route(pathIs(LEADERBOARD_PATH), async (route: Route) => {
    const scope = new URL(route.request().url()).searchParams.get('scope') ?? 'total'
    requested?.push(scope)
    const body = bodies[scope as Scope]
    if (!body) {
      await route.fulfill({ status: 500, json: { error: { code: 'INTERNAL_SERVER_ERROR', message: '无该 scope 的 mock' } } })
      return
    }
    await route.fulfill({ json: body })
  })
}

async function openLeaderboard(page: Page) {
  await page.goto('/leaderboard')
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
}

test.describe('积分排行榜页', () => {
  test('三榜切换：颁奖台 2-1-3 布局、行列表、吸底「我的排名」', async ({ page }) => {
    const requested: string[] = []
    await loginAs(page, SEED_ACCOUNTS.user)
    await mockLeaderboard(
      page,
      {
        total: payload(
          'total',
          rows(10).map((row) =>
            row.rank === 1
              ? { ...row, prevRank: 3 } // ↑2
              : row.rank === 4
                ? { ...row, prevRank: 4 } // 持平
                : row.rank === 5
                  ? { ...row, prevRank: null } // 新入榜
                  : row
          ),
          { me: { rank: 57, points: 80, prevRank: 60 } }
        ),
        week: payload('week', rows(6, '周选手'), { me: { rank: 4, points: 120 } }),
      },
      requested
    )
    await openLeaderboard(page)

    // 颁奖台三席可见；第一名居中垫高（y 更小）、DOM 顺序 2-1-3（x 递增为 2 < 1 < 3）
    const podium = page.getByTestId('leaderboard-podium')
    await expect(podium).toBeVisible()
    await expect(page.getByTestId('leaderboard-podium-1')).toContainText('选手1')
    const box1 = (await page.getByTestId('leaderboard-podium-1').boundingBox())!
    const box2 = (await page.getByTestId('leaderboard-podium-2').boundingBox())!
    const box3 = (await page.getByTestId('leaderboard-podium-3').boundingBox())!
    expect(box1.y).toBeLessThan(box2.y)
    expect(box1.y).toBeLessThan(box3.y)
    expect(box2.x).toBeLessThan(box1.x)
    expect(box1.x).toBeLessThan(box3.x)

    // 第 4 名起为行列表：10 - 3 = 7 行
    await expect(page.getByTestId('leaderboard-row')).toHaveCount(7)

    // 名次变化徽标：第 4 名持平「–」、第 5 名新入榜「新」（P3-1）
    const rowList = page.getByTestId('leaderboard-row')
    await expect(rowList.nth(0).getByTestId('rank-delta')).toHaveAttribute('data-delta', '0')
    await expect(rowList.nth(1).getByTestId('rank-delta')).toHaveAttribute('data-delta', 'new')

    // 移动端吸底条含「距上榜线」激励行（N1）
    await expect(page.getByTestId('leaderboard-me')).toContainText('距上榜线')
    await expect(page.getByText('数据截至 2026-07-31 · 每日更新')).toBeVisible()

    // 桌面（≥lg）「我的排名」驻左栏卡片；吸底浮条仅 <lg 生效
    const meCard = page.getByTestId('leaderboard-me-card')
    await expect(meCard).toBeVisible()
    await expect(meCard).toContainText('第 57 名')
    await expect(meCard).toContainText('80 分')
    // me 带了 prevRank=60 → 上升 3 位
    await expect(meCard.getByTestId('rank-delta')).toHaveAttribute('data-delta', '+3')

    // 切到本周榜：发出 scope=week 请求、期标签与榜首随之更新
    await page.getByTestId('leaderboard-tab-week').click()
    await expect(page.getByTestId('leaderboard-podium-1')).toContainText('周选手1')
    // exact 匹配头部期间徽标——左栏说明卡的「本期区间：…。」带前后缀不会命中
    await expect(page.getByText('07-27 ~ 08-02', { exact: true })).toBeVisible()
    expect(requested).toContain('week')
  })

  test('自己在榜内：行高亮标注「我」，吸底条随行进入视口而隐藏', async ({ page }) => {
    // 吸底浮条仅 <lg（1024px）生效，桌面端信息驻左栏卡片——用窄视口验证联动
    await page.setViewportSize({ width: 900, height: 800 })
    await loginAs(page, SEED_ACCOUNTS.user)
    const top = rows(8)
    top[4] = { ...top[4], displayName: '就是我', isMe: true }
    await mockLeaderboard(page, {
      total: payload('total', top, { me: { rank: 5, points: 800 } }),
    })
    await openLeaderboard(page)

    const myRow = page.getByTestId('leaderboard-row').filter({ hasText: '就是我' })
    await expect(myRow).toHaveAttribute('data-me', 'true')
    await expect(myRow).toContainText('我')
    // 1280×720 下第 5 名恰落在吸底条遮盖区（IO 视口按 -88px 收缩，遮盖区内
    // 不算「看得见」——这是产品语义）。把行滚到视口中央构造真可见场景，
    // IntersectionObserver 通知后吸底条转入隐藏态。
    await myRow.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await expect(page.getByTestId('leaderboard-me')).toHaveAttribute('data-hidden', 'true', {
      timeout: 5_000,
    })
  })

  test('不足三人时保留完整 2-1-3 颁奖台，并标出第三名虚位', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await mockLeaderboard(page, {
      total: payload('total', rows(2), { me: null }),
    })
    await openLeaderboard(page)

    const first = page.getByTestId('leaderboard-podium-1')
    const second = page.getByTestId('leaderboard-podium-2')
    const third = page.getByTestId('leaderboard-podium-3')
    await expect(first).toContainText('选手1')
    await expect(second).toContainText('选手2')
    await expect(third).toHaveAttribute('data-vacant', 'true')
    await expect(third).toContainText('虚位以待')

    const box1 = (await first.boundingBox())!
    const box2 = (await second.boundingBox())!
    const box3 = (await third.boundingBox())!
    expect(box2.x).toBeLessThan(box1.x)
    expect(box1.x).toBeLessThan(box3.x)
    expect(box1.y).toBeLessThan(box3.y)
  })

  test('两种空态文案可区分：新周期首日 vs 首刷空窗', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await mockLeaderboard(page, {
      total: payload('total', rows(3)),
      // 有 updatedAt（同批次总榜兜底）但无人上榜 = 新周期首日
      week: payload('week', [], { updatedAt: '2026-08-02T16:05:00.000Z', dataThrough: '2026-08-02' }),
      // updatedAt 为 null = 系统尚无任何快照（C12 首刷空窗）
      month: payload('month', [], { updatedAt: null, dataThrough: null }),
    })
    await openLeaderboard(page)

    await page.getByTestId('leaderboard-tab-week').click()
    await expect(page.getByTestId('leaderboard-empty')).toContainText('新的一周刚开始')

    await page.getByTestId('leaderboard-tab-month').click()
    await expect(page.getByTestId('leaderboard-empty')).toContainText('榜单正在生成中')
  })

  test('接口失败：错误态 + 重试按钮恢复', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    // 恒失败而非「第一次失败」：dev 下 React.StrictMode 让挂载 effect 双跑、
    // 发出两个请求（首个被 mounted flag 丢弃），一次性 mock 会被它消耗掉。
    await page.route(pathIs(LEADERBOARD_PATH), async (route: Route) => {
      await route.fulfill({ status: 500, json: { error: { code: 'INTERNAL_SERVER_ERROR', message: '崩了' } } })
    })
    await openLeaderboard(page)
    await expect(page.getByTestId('leaderboard-error')).toBeVisible()

    // 换成成功 mock 后点「重试」应恢复
    await page.unroute(pathIs(LEADERBOARD_PATH))
    await mockLeaderboard(page, { total: payload('total', rows(4)) })
    await page.getByRole('button', { name: '重试' }).click()
    await expect(page.getByTestId('leaderboard-podium')).toBeVisible()
    await expect(page.getByTestId('leaderboard-error')).toHaveCount(0)
  })
})

test.describe('移动端 @375px', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true })

  test('底部页签「排行」直达；吸底条完整避让 Tab Bar', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await mockLeaderboard(page, {
      total: payload('total', rows(10), { me: { rank: 57, points: 80 } }),
    })
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
    })

    await page.getByTestId('tab-bar-leaderboard').click()
    await expect(page).toHaveURL(/\/leaderboard$/)
    await expect(page.getByTestId('leaderboard-podium')).toBeVisible()

    // 吸底条与 Tab Bar 均可见且互不重叠（条底 ≤ Tab Bar 顶）
    const meBox = (await page.getByTestId('leaderboard-me').boundingBox())!
    const tabBox = (await page.getByTestId('bottom-tab-bar').boundingBox())!
    expect(meBox.y + meBox.height).toBeLessThanOrEqual(tabBox.y + 1)

    // 375px 无横向溢出（验收 7）
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })
})
