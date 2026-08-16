# Tasks: Catalog / Merch 用户心智与媒体工作流修订

| 字段 | 值 |
| --- | --- |
| 文档 ID | `TASK-CMI-UX-001` |
| 版本 | `0.2.0` |
| 日期 | `2026-08-16` |
| 状态 | **Frozen for Implementation** |
| 输入 | [spec.md](./spec.md) · [plan.md](./plan.md) |

---

## 1. 执行规则

- 默认由一个 Implementation Owner 串行完成，子代理只做探索/核验，不并行编辑宿主文件。
- 每张卡先写/更新下层测试，再实现，再执行卡片 Gate。
- 每个 commit 只关闭一个可解释的行为集合；不得提交生成日志、真实上传对象或 `.env`。
- 任一任务要求 schema/migration、任意远程图片抓取或 Campaign/Order 状态机变化时立即 Blocked。
- 所有状态初始为 Pending；只有证据写入 `implement.md` 后才能标 Done。

---

## 2. 任务 DAG

~~~text
T-UX-001 contracts/tests
   |-- T-UX-002 platform media resolver
   |      |-- T-UX-003 category cover UX
   |      `-- T-UX-004 XBoard cover UX
   |
   |-- T-UX-005 store feed composer
   |      `-- T-UX-006 StorePage integration
   |
   `-- T-UX-007 copy/error projection
          `-- T-UX-008 host copy cleanup

T-UX-003 + 004 + 006 + 008 -> T-UX-009 cross-end verification
T-UX-009 -> T-UX-010 PR handoff
~~~

---

## 3. 原子任务

### T-UX-001 - 冻结类型、fixture 与红测

**目标**：先让 `PlatformMediaRef`、feed slots、stable-code projection 成为可编译、可测试契约。

**Owned**：

- `src/types/catalog.ts` 或单一新 platform media type 文件；
- 新 store feed/test；
- 新 issue/copy projection tests；
- 后端新 platform media test skeleton。

**Must Not Touch**：Prisma、migration、StorePage 宿主行为、生产 storage 配置。

**DoD**：

- [ ] 类型没有 `any`；新旧 DTO 兼容形状明确；
- [ ] 12 槽、去重、搜索 bypass 红测存在；
- [ ] absolute CDN / forged object 红测存在；
- [ ] error/copy mapping 红测存在。

### T-UX-002 - 集中 PlatformMedia resolver

**目标**：以 objectKey + StoredObject/provider config 验证并生成 canonical URL。

**Owned**：

- `server/src/modules/catalog/platformMedia*`；
- 最小 storage runtime helper；
- category/admin schema 中媒体 DTO 类型。

**Must Not Touch**：上传鉴权、multer 限制、delivery/private storage、schema/migrations。

**DoD**：

- [ ] public/active/upload_image 通过；
- [ ] absolute CDN 仅在匹配配置 public provider 和 active StoredObject 时通过；
- [ ] missing/inactive/private/delivery/wrong-source/provider-mismatch/traversal 4xx；
- [ ] static `/assets/` allowlist 通过；
- [ ] 客户端 URL 不参与信任决定；
- [ ] legacy Category/XBoard 引用也进入同一 resolver；
- [ ] 日志不泄露 provider credential。

### T-UX-003 - 分类封面上传闭环

**目标**：管理员在分类表单完成上传、预览、替换、移除，不填写路径。

**Owned**：

- `CategoryCoverField*`；
- `AdminCategoryManager.tsx` 相关表单区；
- category API/types/service/controller 最小接入。

**Must Not Touch**：分类 CRUD 其他语义、排序/审核状态机、Product images。

**DoD**：

- [ ] path 输入完全移除；
- [ ] local upload draft 保存 objectKey，服务端只持久化 canonical `defaultCoverUrl`；
- [ ] Category read DTO 不返回 objectKey/provider/bucket；
- [ ] create active、inactive -> active、active replace/remove 状态转换原子门禁；
- [ ] legacy cover 可只读保留/预览，激活/替换/XBoard 使用时重新解析；
- [ ] 上传失败不丢其他输入；
- [ ] keyboard/label/busy/error 可访问。

### T-UX-004 - XBoard 封面闭环和错误投影

**目标**：production-style 上传 URL 场景可 preview/confirm，稳定码不直出。

**Owned**：

- `AdminFakaImportPreview.tsx`；
- admin schema/service 的 cover resolution；
- catalog issue message projection；
- XBoard server/component/E2E tests。

**Must Not Touch**：XBoard provider auth/HMAC、富文本净化、external identity/idempotency。

**DoD**：

- [ ] request 使用 objectKey；
- [ ] 分类默认封面即时预览；
- [ ] 缺封面提供可执行入口；
- [ ] preview/confirm 复验 StoredObject；
- [ ] preview/confirm 响应不暴露 objectKey/provider；
- [ ] `COVER_INVALID` 默认 DOM 不可见；
- [ ] confirm 错误保留套餐/分类/规格/图片状态；
- [ ] Dialog 临时关闭/重开保留 upload draft，显式取消/成功后清空；
- [ ] 零写入失败断言保留。

### T-UX-005 - 统一商品流纯函数

**目标**：实现与 React/网络无关的确定性 feed composer。

**Owned**：`storeFeed.ts` 和 `storeFeed.test.ts`。

**Must Not Touch**：StorePage、后端 ranking/campaign/editorial service。

**DoD**：

- [ ] 严格 `O,O,S,O,O,E,O,O,S,O,O,O`；
- [ ] 缺失补位、重复优先级、seen 去重；
- [ ] 搜索 bypass；
- [ ] organic 少于 12 和候选 hydrate 缺失；
- [ ] 当前页未消费 organic 紧随首 12 槽输出；
- [ ] 两页 3 候选/无候选/organic 不足均不丢项、不重复且 cursor 不改写；
- [ ] 输入不被 mutate；结果排序稳定。

### T-UX-006 - StorePage 混排集成

**目标**：一个商品流代替两个固定 shelf，同时保持搜索/分类/虚拟列表/分页。

**Owned**：

- `StorePage.tsx`（实施期间整文件锁）；
- `StorePage.cmi.test.tsx`；
- 必要的 card metadata/CSS。

**Must Not Touch**：后端 organic cursor、Campaign billing、Editorial lifecycle。

**DoD**：

- [ ] 消费者宿主不渲染 Sponsored/Editorial shelf；
- [ ] 无候选无任何痕迹；
- [ ] 推荐 500/partial hydrate organic fail-open；
- [ ] 卡片披露、读屏和点击行为正确；
- [ ] 分类不串候选；搜索无注入；
- [ ] infinite scroll session 不重复且全部已加载 organic 恰好展示一次；
- [ ] 推广和精选标签均有文本、读屏语义且不只依赖颜色。

### T-UX-007 - 文案和错误 projection

**目标**：集中映射资金、结算、目录错误，避免页面散落 substring 判断。

**Owned**：新 projection helpers/tests。

**Must Not Touch**：PointLog/Settlement 数据语义和后端状态枚举。

**DoD**：

- [ ] §6.1 词汇映射完整；
- [ ] COVER stable code/action 映射完整；
- [ ] raw blockReason allowlist + unknown fallback；
- [ ] unknown stable code 有安全兜底并可观测；
- [ ] 不通过中文 message substring 决策。

### T-UX-008 - 宿主文案与管理员控件清理

**目标**：应用 projection，并把已确认的内部字段移出主交互。

**Owned**：

- `PointsHistorySheet.tsx`；
- `PurchaseModal.tsx`；
- `ProductCreateWizard.tsx`；
- `MerchantDashboardPage.tsx`（整文件锁）；
- `AdminPage.tsx`（整文件锁）；
- `AdminEditorialManager.tsx`。

**Must Not Touch**：页面无关功能、布局重写、API response schema 扩张。

**DoD**：

- [ ] 冻结文案替换完成；
- [ ] SLA/blockReason/capacity/null/平台抽/单总额完成投影；
- [ ] Editorial 使用商品搜索选择器；
- [ ] Category code/icon 进入高级设置；
- [ ] raw ID 仅次要技术详情；
- [ ] 静态 scan 不命中禁止文案。

### T-UX-009 - 跨端验证

**目标**：以 disposable DB 和现有 catalog-ops stack 验证关键旅程。

**Owned**：现有相关 tests/e2e，仅按测试策略增量修改。

**DoD**：

- [ ] root targeted tests PASS；
- [ ] server targeted tests PASS；
- [ ] XBoard 本地上传 E2E PASS；
- [ ] catalog-ops E2E 全套 PASS；
- [ ] upload auth/active/verified/admin、MIME/magic-byte/5MB 回归 PASS；
- [ ] SafeImage/CSP 和 Category 状态转换测试 PASS；
- [ ] `npm run verify:quick` PASS；
- [ ] `git diff --check`、secret/path scan PASS；
- [ ] disposable DB/fixture 清理。

### T-UX-010 - PR 与 review 交接

**目标**：让 Reviewer 能按证据复核，而非重新探索整个 diff。

**DoD**：

- [ ] PR base=`develop`、head=`fix/catalog-merch-user-ux`；
- [ ] label=`run-e2e`；
- [ ] PR 描述列出各 AC -> test file/断言；
- [ ] 说明无 migration、无生产数据、无 production deploy；
- [ ] 截图只用于 UX review，不作为行为唯一证据；
- [ ] CI `CI OK` 和 catalog-ops job PASS；
- [ ] 未完成/Deferred 项明确列出，不静默缩 scope。

---

## 4. 建议提交序列

1. `test(cmi-ux): freeze feed media and copy contracts`
2. `fix(catalog): resolve uploaded covers by registered object`
3. `feat(catalog): add category and xboard cover upload flow`
4. `fix(merch): blend paid and curated exposure into store feed`
5. `fix(ux): project settlement and admin copy for users`
6. `test(cmi-ux): close cross-end cover and store regressions`
7. `docs(cmi-ux): record implementation evidence`

允许在 review 后合并相邻 commit，但禁止一个 commit 同时混入无关重构。

---

## 5. Blocked 条件

- 需要修改 Prisma schema/migration；
- 无法由 StoredObject/provider config 安全生成 canonical public URL；
- 现有 upload response 的 key 无法唯一关联登记对象；
- 资金文案需要改变真实 PointLog/Order/Settlement 状态；
- 生产/真实 XBoard/真实对象存储是唯一可复现环境；
- 发现与本规格冻结槽位或媒体来源直接冲突的新 Owner 决策。

Blocked 时只提交证据和建议，不得用放宽 URL、关闭 registry 或隐藏测试失败绕过。
