# 前端架构评审（软件工程视角）

- 基线：`origin/develop@4b098c8`（= 生产 `sha-4b098c8`）
- 范围：仓库根 `src/`（React 18 + Vite + Zustand + Axios）。后端另行评审。
- 框架：L1–L6 六层。本轮以 **L2 架构与设计、L3 代码实现** 为主，L4 质量保障为辅；L1、L5 只记录顺带发现的问题，不做系统审查。
- 性质：只做评审，不改代码。所有数字都可以用 `evidence/` 里的脚本复现（见文末）。

## 0. 结论摘要

| 层 | 结论 | 一句话 |
|---|---|---|
| L1 正确性 | 抽查发现 1 项 | 时间显示没有统一时区（F-06） |
| **L2 架构与设计** | **有债** | 按技术类型分目录，领域逻辑分散或放错位置；会话缓存失效写成了反向依赖；`appStore` 职责过多 |
| **L3 代码实现** | **有债，但集中在热点** | 整体重复率只有 0.51%、TS strict、没有 `ts-ignore`；问题集中在 6–7 个巨型组件，它们恰好也是改动最频繁的文件 |
| L4 质量保障 | 基本健康 | 共 240 个测试文件；但改动最多的 `Layout`、`ProfilePage` 没有测试 |
| L6 工程治理 | **需治理** | 前端没有 lint，也没有架构门禁，现有的好结构缺少防腐机制 |

**最值得投入的三件事**（按"收益 / 成本"排序）：

1. **补上防腐门禁**（F-07）：引入最小 ESLint（只开 `react-hooks` 规则），并把现有的 `architecture-rules` 扩展到前端，加 3 条规则。约 1 天工作量，作用是阻止下面这些问题继续扩大。
2. **改热点文件时顺手拆分**（F-01）：从商品详情页的下单流程开始拆。它是全仓库改动最多的文件，近 6 个月 44 次提交，圈复杂度 103。
3. **解开会话缓存的反向依赖**（F-03）：一次小重构，就能消除全仓唯一的循环依赖，也消除 store 对 pages 的依赖。

## 1. 基线数据

| 项 | 值 |
|---|---|
| 生产代码 | 478 个文件 / 92k 行（另有 38 个 CSS 文件共 7.7k 行） |
| 测试代码 | 240 个测试文件 / 46k 行 |
| 目录分布（行数） | components 61k、pages 14k、api 7.7k、types 2.5k、stores 1.6k、hooks 1.3k、utils 1.2k、realtime 1.0k |
| 文件规模 | 超过 300 行的 99 个，超过 500 行的 39 个，超过 800 行的 9 个 |
| 函数规模 | 长度 ≥150 行的 139 个，圈复杂度 ≥30 的 50 个 |
| 文件级循环依赖 | 1 个（5 个文件，见 F-03） |
| 重复代码 | 626 / 123k 行（0.51%），35 处克隆（jscpd，min-tokens 70） |
| 类型逃逸 | `any` 82、`as` 258、`!` 81、`@ts-ignore` 0 |
| 近 6 个月 | 239 个提交改动了前端生产代码；每个提交改动文件数中位数 4，p90 为 17 |

### 1.1 热点：既复杂、又经常改

| 文件 | 行数 | 最大函数（行 / 圈复杂度） | useState / useEffect | 6 个月提交数 | 同名测试 |
|---|---|---|---|---|---|
| `pages/ProductDetailPage.tsx` | 908 | 833 / 103 | 21 / 8 | **44** | 5 |
| `pages/MerchantDashboardPage.tsx` | 993 | 879 / 32 | **41** / 6 | 35 | 1 |
| `components/Layout.tsx` | 899 | 855 / **125** | 13 / 15 | 33 | **0** |
| `components/OrderDetailModal.tsx` | 839 | 683 / 101 | 6 / 1 | 33 | 1 |
| `pages/ProfilePage.tsx` | 680 | 588 / 48 | 11 / 3 | 33 | **0** |
| `pages/StorePage.tsx` | 939 | 858 / 46 | 9 / 14 | 31 | 5 |
| `components/PurchaseModal.tsx` | — | 504 / 62 | — | 23 | 2 |

改动次数最多的 7 个文件里有 6 个同时是最复杂的组件。按修改成本算，**前端大部分工程债集中在这 7 个文件里**。其余大文件（管理后台的各类表单）改动少，优先级低。

### 1.2 健康项（保持即可）

- **重复率很低**：0.51%。最大的克隆在 `merchandising/packageManager` 的 Create/Edit 两个对话框之间（71 行）。
- **API 层纪律好**：只有 6 处在 `src/api/` 之外直接调用 client。3 处 `fetch()` 分别用于 SSE 流和埋点上报，属于合理例外。`api/error.ts` 被 112 个文件引用，错误文案处理是统一的。
- **Zustand 使用规范**：167 处都用 selector 订阅，0 处整体订阅，不存在无谓的全局重渲染。
- **类型系统**：`strict` 已开，没有 `@ts-ignore`。
- **目录分层大体正确**：没有 `utils`/`lib` 引用组件；pages 之间只有父页面引用自己的子目录。

## 2. 发现

分级说明：P1 = 正在持续产生修改成本，应排期处理；P2 = 结构性债，按触达顺序处理；P3 = 记录，等有机会再做。"成本"是估计的改造工作量。

### F-01（P1 · L3/L2）业务流程编排写在热点页面组件里

**证据**
- `ProductDetailPage` 主函数 833 行，下单流程（`ProductDetailPage.tsx:330-420` 一带）在一个回调里同时处理以下事情：
  - 幂等键；
  - 会话作用域校验（`isSameSession`）；
  - 页面访问序号（`detailVisitRef`）防止串单；
  - 移动端灵动岛提示；
  - 更新积分余额；
  - 刷新订单角标；
  - 设置成功态；
  - 重新拉取详情。
- 这段逻辑本身写得很谨慎，并发和会话问题都考虑到了。但它只能连同整个页面一起渲染来测试，也无法复用。
- `Layout` 主函数 855 行，圈复杂度 125，有 15 个 effect，混合了导航、滚动压缩、搜索、公告中心、法律链接加载、5 种灵动岛、签到、通知未读、实时通知桥接等职责（见 `Layout.tsx:1-200` 的 import 和 state 列表）。改其中任何一项，都要在这 855 行里定位。
- `MerchantDashboardPage` 有 41 个 `useState`。

**影响**：这是修改成本最高的位置。一个需求改到热点文件时，评审、回归和冲突的成本都按文件规模放大；`Layout` 改动很频繁，却没有同名测试。

**建议**（不做一次性重写，在下次改到这些文件时顺手拆）
1. PDP：先把下单流程抽成 `useProductCheckout()`（输入商品、规格和会话，输出 `submit` 和状态），再拆出详情加载和评价分页两个 hook。这样 PDP、PurchaseModal、`api/orders` 这组经常一起改的代码（见 F-02）就有了独立的测试面。
2. `Layout`：拆成外壳布局、`IslandHost`（集中管理 5 种灵动岛的开关与排队）、`HeaderNav` 三部分。灵动岛的状态和 effect 占了大部分复杂度。
3. 大表单（`MerchantDashboardPage`、`ProductEditPage`）：把相关的 `useState` 合并成 `useReducer` 或一个表单状态对象。

**成本**：PDP 下单 hook 约 1 天；`Layout` 拆分约 1–2 天，需要 run-e2e。

### F-02（P2 · L2）按技术类型分目录，领域逻辑分散或放错位置

**证据**
- 下单领域在 4 个目录之间高频一起改（近 6 个月同一提交中共同修改的次数）：
  - `api/orders.ts` 与 `ProductDetailPage`：11 次；
  - `PurchaseModal` 与 `ProductDetailPage`：10 次；
  - `OrderDetailModal` 与 `SuccessModal`：8 次；
  - `OrderDetailModal` 与 `types/order.ts`：7 次。
- **充值领域逻辑放在了页面目录下**：`pages/recharge/money.ts`（金额精度与格式化）和 `pages/recharge/status.ts`（状态枚举、文案、色调）被 8 个管理端组件引用，共 13 条 components → pages 的依赖。`api/recharge.ts` 和 `utils/adminRechargeDisplay.ts` 也反过来从 pages 引入类型。
- `components/` 根目录堆了 35 个文件，跨领域互相引用：admin → catalog 14 处，catalog ↔ merchant 双向共 13 处。

**影响**：改一个领域要跨 4–5 个目录；放在 pages 下的领域模块会被误当成"页面私有"，修改时容易漏掉管理端的使用方。

**建议**
1. 立即可做（低风险）：把 `pages/recharge/{money,status,pricePolicyPreview}.ts` 移到 `src/domain/recharge/`（纯函数，不含 React），并修正 13 处引用。
2. 约定新代码的落点：领域纯逻辑放 `src/domain/<领域>/`，跨页面的业务组件放 `components/<领域>/`。**不做全仓迁移**，只在改到某个领域时迁移该领域。
3. 下单领域随 F-01 的 `useProductCheckout` 一起沉淀到 `src/domain/orders/`。

**成本**：第 1 项约 0.5 天。

### F-03（P2 · L2）会话变更时的缓存失效写成了反向依赖，形成循环

**证据**
- 全仓唯一的文件级运行时循环：`auth/sessionStorageSync` → `api/authRefresh` → `api/client` → `api/registry` → `stores/authStore` → 回到 `auth/sessionStorageSync`。
- `stores/authStore.ts:4-5` 直接 import 了 `pages/storePageCache` 和 `api/registry`，在会话变更时逐个清缓存。`clearStorePageCache()` 在 `authStore` 的 3 个切换入口里各调用一次。
- 已有的注册式钩子 `registerIdentityScopedMetadataCleanup` 只有**一个槽位**，而 `appStore`（registry 快照）和 `useCheckin`（签到快照，c960219 于 2026-11-23 加入）都向它注册，后加载的会覆盖先加载的。身份切换时，其中一方的清理会被静默跳过：要么 registry 快照残留登录视角的受限分类（SPEC-CATALOG-VIS-001 §3.5），要么签到快照残留上一位用户的状态。实施时已用测试复现。

**影响**：store 必须知道所有缓存，每新增一种按会话隔离的缓存都要改 `authStore` 或 `sessionStorageSync`，漏改就会跨账号串数据（`registry.cacheIsolation.test.ts` 正是为这类问题加的测试）。循环依赖还会让模块初始化顺序变得脆弱。

**建议**：`authStore` 暴露一个 `onAuthSessionChange(listener)` 订阅接口（或者复用已有的 `broadcastAuthSessionChange` 通道），由各个缓存模块自己注册失效逻辑。这样 store 不再 import pages 或 registry，循环也就解开了。现有的缓存隔离测试可以直接作为回归保护。

**成本**：约 0.5 天。属于 auth/session 改动，需要 run-e2e。

### F-04（P2 · L2）`appStore` 职责过多

**证据**：`stores/appStore.ts` 共 524 行，被 137 个文件引用（全仓最高）。它同时承载以下几类状态：

| 类别 | 包含的状态 |
|---|---|
| UI 反馈 | toast、灵动岛队列与暂停、modalDepth、tabbar |
| 功能页状态 | 商店搜索和分类、签到弹窗、积分历史弹窗 |
| 服务端派生状态 | 配置 registry、订单角标计数、通知未读数、实时流状态 |

**影响**：订阅都用了 selector，所以没有性能问题，问题在内聚性。任何一类状态的修改都会触及一个被 137 个文件引用的模块；测试也需要 mock 整个 store。

**建议**：按上表拆成 `feedbackStore`、`storeSearchStore`、`serverCountersStore` 等 slice，原来的 `useAppStore` 导出保留一段过渡期。改到哪一类就拆哪一类，不集中重构。

**成本**：每个 slice 约 0.5 天。

### F-05（P2 · L3）服务端数据请求没有统一抽象，样板代码各写各的

**证据**
- 59 个文件手写 `setLoading(true)`；34 个文件用 `let cancelled` 防止过期请求写入 state；12 个用 `AbortController`；34 个文件各自处理 `authEpoch` / `AuthSessionChangedError` 的会话作用域。
- 已经有 3 个局部抽象（`useCursorList`、`useShopProducts`、`useProductRecommendations`），但"是否可重试"的判断在后两个 hook 里是一样的代码，分别写了一遍（`useShopProducts.ts:27-33`、`useProductRecommendations.ts:24-25`）。

**影响**：正确性靠每个作者都记得处理取消和会话作用域（PDP 里专门写了注释说明请求会重叠，必须防范这类竞态）。新页面很容易漏掉，而且这类 bug 只在快速切换页面或切换账号时才会出现。

**建议**（需要 Owner 决定方向）
- 方案 A：自建一个最小的 `useAsyncResource(key, loader)`，内置取消、会话作用域和重试分类，供新代码使用。不新增依赖。
- 方案 B：引入 TanStack Query。这是行业标准，自带缓存、去重和重试，但会话作用域需要通过 query key 和失效逻辑接入。它会改变数据层的写法，属于新增依赖。
- 倾向 A：现有代码最难的部分正是会话作用域，A 可以直接复用现有语义。等页面的缓存需求变多时，再评估 B。

### F-06（P2 · L1/一致性）时间显示没有统一时区和格式化入口

**证据**：69 个文件里共有 135 处 `toLocale*String(`，只有约 7 个文件显式指定了 `timeZone: 'Asia/Shanghai'`。`formatDateTime` 有 3 个实现，签名各不相同（`utils/governance.ts:198`、`merchandising/campaignManager/dateFormat.ts:9`，以及 `merchandising/promotionCopy.ts:89` 的 `formatDate`）。

**影响**：后端的业务日按 Asia/Shanghai 计算（AGENTS.md 硬约束），而前端大部分时间按浏览器时区显示。浏览器不在 +0800 的用户（海外用户、时区设置不同的设备、UTC 下运行的 E2E）会看到与业务日不一致的日期，比如签到日期或"今天"的订单。如果用户全部在 +0800，实际影响较小。

**建议**：新建 `src/utils/datetime.ts`，固定 Asia/Shanghai，提供 `formatDate`、`formatDateTime`、`formatTime`；仿照 `styles/tailwindVarOpacity.test.ts` 的守卫测试模式，禁止新增未指定时区的 `toLocale*String`，存量逐步迁移。

**成本**：工具函数加守卫约 0.5 天；存量迁移可以用 codemod 一次完成，约 0.5–1 天。

### F-07（P2 · L6）前端没有 lint 和架构门禁

**证据**
- 仓库里没有 ESLint 和 Prettier 配置，前端 CI 只跑 `npm test` 和 `npm run build`（`.github/workflows/ci.yml:238-241`）。
- 但代码里有 13 处 `// eslint-disable-next-line react-hooks/exhaustive-deps`，抑制的是一个根本没在运行的检查。也就是说，hook 依赖数组从来没有被检查过。
- `scripts/architecture-rules.mjs` 只覆盖 `server/src/`。
- `check:bundle-budget` 脚本存在，但不在 CI 里。（实施时核实：阈值是 2026-08 定的"全部资源 gzip 150 KiB"，当前实际 1263 KiB，口径早已失效，不能直接接入 CI。）

**影响**：上面"健康项"里的分层纪律目前全靠自觉。F-02/F-03 这类反向依赖会在没有任何报警的情况下继续增加；hook 依赖遗漏是 React 里最常见的 bug 来源之一。

**建议**
1. 引入最小 ESLint：只启用 `react-hooks/rules-of-hooks`（error）和 `exhaustive-deps`（warn），不启用风格类规则，避免大面积改动。现有 13 处抑制注释会因此真正生效。
2. 在 `architecture-rules` 里增加 3 条前端规则：
   - `api/`、`stores/`、`lib/`、`utils/`、`components/` 不得 import `pages/`；
   - 只有 `src/api/` 可以 import `api/client`，现有 6 处作为白名单；
   - 前端不得新增循环依赖。现有那 1 个循环先列入白名单，F-03 修复后移除。
3. ~~把 `check:bundle-budget` 加入前端 CI job。~~ 口径失效（见上），需要先重新定义预算口径（例如只算入口 chunk），本轮不做。

**成本**：约 1 天。新增 ESLint 及插件这两个 devDependency 需要 Owner 同意。

### F-08（P3 · L2/契约）前后端类型靠手工同步，存放位置也没有约定

**证据**
- `src/types/*.ts` 手工镜像后端响应结构。`types/merchant.ts` 近 6 个月改了 27 次，`types/governance.ts` 有 65 个导出。
- 另一部分类型定义在 `src/api/*.ts` 里，比如 `api/admin.ts` 有 32 个类型，放哪里没有规则。
- 运行时响应校验只在少数 api 模块里手写，比如 `isValidAdminProductOffer` 的圈复杂度是 62。
- OpenAPI 契约只覆盖了订单的 2 个接口。

**影响**：后端字段变化时，只有 E2E 或线上才能发现前端没同步。

**建议**：先定一条约定，"接口响应类型放在对应的 `api/<module>.ts`，跨模块共享的领域类型放 `types/`"，新代码遵守即可。是否基于 OpenAPI 生成类型属于长期方向，由 Owner 决定，本轮不建议投入。

### F-09（P3 · L3）管理端大表单与少量重复

**证据**
- 多个管理端组件有 20 个以上 `useState`：`ProductEditPage` 33、`AdminProductPanel` 26、`AdminUserTable` 24、`AdminEntitlementManager` 24。
- `packageManager` 的 `CreatePackageDialog` 和 `EditPackageDialog` 之间有 3 段重复，分别为 71、57、45 行，是全仓最大的克隆。

**建议**：这些文件改动少，下次改到时再合并状态、抽出共用表单。不单独排期。

### L4 补充：测试结构

- 测试和源码放在同一目录，覆盖面较好：pages 有 39 个测试文件对应 59 个页面文件，realtime 7/8，stores 7/6。
- 缺口：超过 400 行的 67 个文件中，有 24 个没有同名测试，其中就包括热点 `Layout` 和 `ProfilePage`。
- 240 个测试文件里有 114 个用 `vi.mock` mock 整个模块。这意味着测试和模块结构绑得比较紧，做 F-02、F-04 这类迁移时需要同步改测试。拆分时优先选不需要改 mock 的路径，比如保留原导出、逐步过渡。

## 3. 建议路线

| 批次 | 内容 | 预估 | 备注 |
|---|---|---|---|
| 1 防腐 | F-07 ESLint（hooks 规则）+ 3 条前端架构规则 | 1 天 | 先做，后面各项才不会边修边坏 |
| 1 小重构 | F-03 解开循环；F-02 第 1 项迁移充值领域模块；F-06 时间工具函数 + 守卫测试 | 1.5 天 | 风险低，F-03 需要 run-e2e |
| 2 改到时再做 | F-01 PDP 下单 hook → `Layout` 拆分；F-04 按 slice 拆 `appStore` | 跟随需求 | 每次 PR 只拆一块 |
| 待 Owner 决定 | F-05 数据请求抽象（A 自建 / B TanStack Query）；F-08 类型生成 | — | — |

第 1 批可以合成一个分支、一个 PR，按 commit 拆分。

## 4. 复现方式

```bash
# 在仓库根目录（需要已安装 node_modules，以便加载 typescript）
E=docs/reviews/2026-11-24-frontend-architecture-review/evidence; OUT=$(mktemp -d)
node $E/fe-metrics.cjs "$PWD" $OUT/fe.json && node $E/fe-analyze.cjs $OUT
npx -y jscpd@4.0.5 src --pattern "**/*.{ts,tsx}" --ignore "**/*.test.*,**/__tests__/**,src/test/**,**/*.fixtures.ts" --min-tokens 70
git log --since=2026-05-24 --no-merges --name-only -- src   # 改动热点与共变分析的数据来源
```

`evidence/fe-report.txt` 是本次基线的完整输出。下一轮评审时用同样的脚本复跑，对比文件规模、循环、热点三项是否在改善。

## 5. 第 1 批实施记录（分支 `chore/frontend-architecture-batch1`）

| 项 | 做了什么 |
|---|---|
| F-07 | 新增 `eslint.config.js`，只开 `rules-of-hooks`（error）和 `exhaustive-deps`（warn）；`npm run lint` 用 `--max-warnings 71` 锁住存量，只许减不许增；前端 CI job 加 lint 步骤。删掉 1 处无效的 disable 注释。`architecture-rules` 新增 FE-01（只有 pages 和 app 根可以 import pages）、FE-02（直接用 `api/client` 限现有 6 个文件）、FE-03（日期显示必须指定时区或走 `utils/datetime`），前端也纳入了循环检测 |
| F-03 | 注册钩子从单槽位改为集合，`storePageCache` 和 `registry` 各自注册清理；`authStore` 不再 import pages 和 api。修复了上面的覆盖 bug，并加了回归测试（修复前失败、修复后通过）。前端文件级循环从 1 降到 0 |
| F-02① | `money`、`status`、`pricePolicyPreview`、`paymentActions` 连同测试从 `pages/recharge/` 移到 `src/domain/recharge/`；components、api、utils 对 pages 的依赖降为 0 |
| F-06 | 新增 `src/utils/datetime.ts`（固定 Asia/Shanghai），迁移约 55 处日期显示，合并 7 个重复的格式化函数。管理端 5 处"（本地时间）"标签改为"（北京时间）"。对 +0800 用户显示不变 |

验证：`npm run lint`、`npm test`（240 个文件 / 1958 个用例）、`npm run build`、`npm run test:architecture`（18 项）、`npm run check:architecture`、`npm run e2e:mobile-island`（15 项）全部通过；另在 `TZ=America/Los_Angeles` 下跑了受影响的 70 个测试文件，全部通过。主 E2E 套件需要测试库，没有在本机跑，PR 需要带 `run-e2e`。

### 5.1 hook 依赖警告排查（71 条）

逐条看过，**没有发现会导致错误行为的遗漏依赖**：

| 类别 | 条数 | 结论 |
|---|---|---|
| cleanup 中读取 `xxxRef.current`（请求序号计数器） | 18 | 误报：cleanup 本来就要读最新序号来作废在途请求；规则针对的是 DOM ref |
| effect 调用组件内函数（`load` / `fetchX` / `reload`）而未列入依赖 | 32 | 安全：effect 闭包每次渲染重建，调用的是当次渲染的函数；不随这些函数重跑是有意设计 |
| 以 `x?.id` 等原始值作依赖、在 effect 内读取对象本身 | 13 | 有意：按身份或主键触发，避免对象引用变化时重复执行（例如切换账号才重置表单） |
| 每次渲染生成新的空数组或对象，使 memo 或 effect 依赖失效 | 6 | 4 条已修（改用模块级空数组常量，`useAnnouncements` 2 条、`ProductDetailDesktop`、`AdminOfferManagerModal`）；`RechargeCheckout` 的 `parsed` 2 条只造成多余执行，不改 |
| 多余依赖（`location.key`、`currentSessionKey`） | 2 | 有意：用于在导航或会话变化时触发重新加载 |

lint 棘轮从 71 降到 67。剩下的警告保留为 warn，不批量加 disable 注释：注释的维护成本高于收益，而棘轮已经能阻止新增。

### 5.2 F-01 第一步：商品详情页下单流程

下单流程（购买弹窗、会话与路由作用域、下单提交与错误分类、成功态、移动端灵动岛、下单后刷新详情）原样迁入 `src/pages/productDetail/useProductCheckout.ts`，沿用 `pages/merchant/productCreation/useProductCreation.ts` 的页面私有 hook 模式。`ProductDetailPage.tsx` 从 908 行降到 690 行。公开详情请求收进 `api/catalog.ts` 的 `getPublicProductDetail`，PDP 因此移出 FE-02 白名单。行为不变：PDP 现有 5 个测试文件、全量单测与移动端 E2E 均通过。`Layout` 拆分留待下一步。

## 6. 本轮没有覆盖的内容

- 运行时性能（首屏、包体积、渲染）：之前的 P1/P2 骨架屏和外壳几何专项已经做过，本轮没有重新测量。
- 无障碍、样式体系（38 个 CSS 文件和 Tailwind 混用）、移动端交互一致性。
- 安全（XSS / DOMPurify 使用面、token 存储）：属于 L1，建议并入后端评审的安全部分，或者单独做一轮。
- 测试有效性（变异测试或覆盖率）：只统计了测试结构，没有度量覆盖率。
