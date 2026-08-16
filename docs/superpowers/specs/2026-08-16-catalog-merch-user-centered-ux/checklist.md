# Checklist: Catalog / Merch 用户心智与媒体工作流修订

| 字段 | 值 |
| --- | --- |
| 文档 ID | `CHK-CMI-UX-001` |
| 版本 | `0.2.0` |
| 日期 | `2026-08-16` |
| 状态 | **Frozen for Implementation - all checks Pending** |
| 输入 | [spec.md](./spec.md) · [plan.md](./plan.md) · [task.md](./task.md) · [implement.md](./implement.md) |

---

## 1. P0 完成定义

任一 P0 未完成不得宣称 ready for review/merge。

### P0-A 统一商品流

- [ ] `CHK-UX-P0-001` StorePage 不再渲染独立 Sponsored/Editorial shelf。
- [ ] `CHK-UX-P0-002` 无候选时无标题、空态、占位和消费者错误。
- [ ] `CHK-UX-P0-003` 12 槽模板、缺失补位和 sponsored 优先级有纯函数测试。
- [ ] `CHK-UX-P0-004` 两页的 3 候选/无候选/organic 不足场景中，已加载 organic 恰好
  展示一次，当前页余项不丢失，后续 pagination 不重复且 cursor 不改写。
- [ ] `CHK-UX-P0-005` 搜索不注入；分类候选不跨分类。
- [ ] `CHK-UX-P0-006` 推荐 API/hydrate 失败 organic fail-open。
- [ ] `CHK-UX-P0-007` 推广和精选始终文本披露且读屏可感知，不只依赖颜色。

### P0-B 媒体信任与上传

- [ ] `CHK-UX-P0-008` Category/XBoard 使用同一 platform media resolver。
- [ ] `CHK-UX-P0-009` objectKey 是信任锚，客户端 URL 不参与权限判断。
- [ ] `CHK-UX-P0-010` public/active/upload_image registry 校验全部保留。
- [ ] `CHK-UX-P0-011` private/delivery/inactive/missing/wrong-source/provider-mismatch/traversal fail-closed。
- [ ] `CHK-UX-P0-012` absolute production-style CDN 仅映射到配置 public provider + active
  StoredObject 时可 Category save/XBoard confirm。
- [ ] `CHK-UX-P0-013` 无 Prisma schema/migration diff。
- [ ] `CHK-UX-P0-014` legacy cover/request/read 全部使用集中 resolver 且有测试；Category 只
  持久化/读取 canonical URL，不新增或泄露 objectKey。

### P0-C 用户操作闭环

- [ ] `CHK-UX-P0-015` 分类表单无 path/URL 输入。
- [ ] `CHK-UX-P0-016` 上传/预览/替换/移除完整且失败保留表单；Dialog 临时关闭/重开保留
  draft，显式取消/成功后清空。
- [ ] `CHK-UX-P0-017` create active、inactive -> active、active replace/remove 和 legacy
  unresolved 门禁在服务端同一原子写入中检查。
- [ ] `CHK-UX-P0-018` XBoard 本地上传 -> preview -> confirm E2E 通过。
- [ ] `CHK-UX-P0-019` 分类缺封面在 preview 前给出可执行入口。
- [ ] `CHK-UX-P0-020` 默认 DOM 不直出 `COVER_INVALID` 等稳定码。

### P0-D 回归与安全

- [ ] `CHK-UX-P0-021` 上传 authenticate/active/verified/admin、MIME/magic-byte/5MB tests 仍绿。
- [ ] `CHK-UX-P0-022` XBoard idempotency/source hash/sanitize/zero-write tests 仍绿。
- [ ] `CHK-UX-P0-023` catalog-ops integration Playwright 全绿且 fixture cleanup。
- [ ] `CHK-UX-P0-024` PR `CI OK` 全绿，标签 `run-e2e`。
- [ ] `CHK-UX-P0-025` secret/object/path scan 无泄漏。
- [ ] `CHK-UX-P0-026` Category/XBoard 预览使用 SafeImage，URL 受 CSP platform origin 限制。

---

## 2. P1 完成定义

- [ ] `CHK-UX-P1-001` 积分流水使用“入账/待支付/已支付/已返还”。
- [ ] `CHK-UX-P1-002` 不出现“分色展示/不是扣了两笔”。
- [ ] `CHK-UX-P1-003` 买家购买确认说明锁定、完成支付、取消返还。
- [ ] `CHK-UX-P1-004` 商家订单不直出 raw `blockReason`。
- [ ] `CHK-UX-P1-005` `SLA 超时` 替换并显示具体处理截止时间。
- [ ] `CHK-UX-P1-006` `capacity_limit/null=不限` 替换为业务控件/文案。
- [ ] `CHK-UX-P1-007` `平台抽/单总额` 替换为平台服务费/订单金额并显示单位。
- [ ] `CHK-UX-P1-008` Editorial 使用商品搜索选择器，不要求 raw Product ID。
- [ ] `CHK-UX-P1-009` 分类 code/icon/path 不在普通主流程中。
- [ ] `CHK-UX-P1-010` raw ID/code 仅在次要技术详情中可复制。
- [ ] `CHK-UX-P1-011` desktop/mobile 有候选和无候选截图无重叠/空洞。
- [ ] `CHK-UX-P1-012` 上传/标签/error 的键盘、label、aria-live 验证通过。

---

## 3. AC 追溯矩阵

实施 Agent 填写 Evidence 列，不得删除 AC。

| AC | 要求摘要 | 默认证据层 | Evidence |
| --- | --- | --- | --- |
| `AC-UX-001` | 无推荐时只显示普通商品 | StorePage component | Pending |
| `AC-UX-002` | 12 槽顺序 | feed unit | Pending |
| `AC-UX-003` | 缺失/重复/hydrate 补位 | feed unit + component | Pending |
| `AC-UX-004` | 推广披露 | component/a11y | Pending |
| `AC-UX-005` | 精选披露 | component/a11y | Pending |
| `AC-UX-006` | 搜索无注入 | unit + component | Pending |
| `AC-UX-007` | 推荐 500 fail-open | component | Pending |
| `AC-UX-008` | 两页 organic 不丢不重 | feed unit + component | Pending |
| `AC-UX-009` | 分类保存重开且 DTO 不泄漏 | component + server | Pending |
| `AC-UX-010` | XBoard upload-preview-confirm | server + 1 E2E | Pending |
| `AC-UX-011` | absolute CDN/provider registry | server integration | Pending |
| `AC-UX-012` | 分类缺封面提前提示 | component | Pending |
| `AC-UX-013` | 非法媒体零写入 | server integration | Pending |
| `AC-UX-014` | 失败/重开保留 draft | component | Pending |
| `AC-UX-015` | Category 状态原子门禁 | server integration | Pending |
| `AC-UX-016` | 鉴权和上传限制回归 | server integration | Pending |
| `AC-UX-017` | SafeImage/CSP/上传可访问性 | component + security | Pending |
| `AC-UX-018` | 积分流水自然文案 | component | Pending |
| `AC-UX-019` | 购买确认资金语义 | component | Pending |
| `AC-UX-020` | 商家 block/SLA 投影 | unit + component | Pending |
| `AC-UX-021` | admin 内部字段消除 | component + static scan | Pending |
| `AC-UX-022` | 稳定码默认隐藏 | unit + component | Pending |

---

## 4. API/兼容审查

- [ ] 新 `PlatformMediaRef` 请求/响应示例写入 PR。
- [ ] Upload response 精确为 `{key,url}`，客户端直接令 `objectKey=key`。
- [ ] 同时提交新旧 cover 字段时返回明确 400；单独旧字段继续经 legacy resolver 兼容接收。
- [ ] 新 UI 不提交 `defaultCoverUrl` 或 uploaded `imageUrl/images`。
- [ ] Category write 解析 media ref 后只存 `defaultCoverUrl`；read 只返回 canonical URL。
- [ ] XBoard preview/confirm response 不暴露 objectKey/provider/bucket。
- [ ] 旧数据仍能读取和预览，激活/替换/XBoard 使用时重新解析。
- [ ] 旧 API client 兼容路径有截止/注释，不复制安全逻辑。
- [ ] stable code/action 外部语义有测试，不按中文 message substring 分支。
- [ ] public DTO 不泄露 objectKey/provider config。

---

## 5. 测试 Gate

| Gate | 命令/范围 | 状态 | 证据 |
| --- | --- | --- | --- |
| Frontend targeted | `npm test -- <explicit test files>`，feed/cover/issue/copy/StorePage | Pending | Pending |
| Backend targeted | §6.1 dbguard + Vitest explicit files | Pending | Pending |
| Backend isolated | `bash scripts/verify-catalog-ops-backend.sh` | Pending | Pending |
| Quick | `npm run verify:quick` | Pending | Pending |
| Catalog E2E | `bash scripts/verify-catalog-ops-e2e.sh` | Pending | Pending |
| Diff | `git diff --check` | Pending | Pending |
| Static copy | §6.4 forbidden UI text scan | Pending | Pending |
| PR CI | `CI OK` | Pending | Pending |
| PR catalog-ops | isolated Playwright job | Pending | Pending |

若 quick runner 根据 diff 未覆盖某个关键测试，必须显式追加 targeted command；不得把“runner 未选中”
当作通过证据。

---

## 6. PR Gate

- [ ] `G-UX-PR-001` Docs PR 已合入；Branch 从含本规格的最新 `origin/develop` 创建，动态
  `SPEC_DOCS_COMMIT` ancestor 检查通过。
- [ ] `G-UX-PR-002` 只有解释过的 scope 文件，无无关格式化/依赖 churn。
- [ ] `G-UX-PR-003` Spec 冻结决策没有被代码现状反向改写。
- [ ] `G-UX-PR-004` 无 schema/migration/deploy/production diff。
- [ ] `G-UX-PR-005` P0 全部 Done，P1 全部 Done 或明确 Owner-approved follow-up。
- [ ] `G-UX-PR-006` AC-UX-001~022 均有下层证据。
- [ ] `G-UX-PR-007` run-e2e、CI OK、catalog-ops 全绿。
- [ ] `G-UX-PR-008` 上传安全、幂等、零写入失败和 compatibility 全绿。
- [ ] `G-UX-PR-009` PR 描述含截图、命令/计数、风险和回滚。
- [ ] `G-UX-PR-010` Reviewer 可从交接索引复核，不需重新搜索整个代码库。

任一 P0/PR Gate Pending 或 Failed，不得宣称 ready to merge。

---

## 7. Reviewer 核心检查

Reviewer 优先检查以下高风险点：

1. 是否只是把 absolute URL 转相对路径，而没有真正验证 StoredObject；
2. 是否为了修复上传而允许任意 CDN/remote URL；
3. Category 和 XBoard 是否仍复制两套媒体判断；
4. feed 去重是否只覆盖首屏而在下一页重复；
5. 首 12 槽注入是否吞掉当前 cursor 页中已加载但未消费的 organic；
6. 推荐 error 是否错误地控制了 StorePage 主 loading/error；
7. 推广/精选标签是否可能因 CSS/移动端/读屏而消失；
8. Category 是否误加 objectKey 持久字段或在 DTO 泄露它；
9. stable code 是否只是隐藏文本但仍作为面向用户主标题；
10. 文案修改是否偷偷改变了真实资金状态或金额计算；
11. 是否添加了不符合 `docs/testing-policy.md` 的大量纯 UI E2E；
12. 是否触及生产部署、真实 bucket、真实 XBoard 或未授权迁移。

---

## 8. 最终交接清单

- [ ] PR URL / HEAD / base SHA；
- [ ] diff stat 和 owned file 列表；
- [ ] AC evidence matrix；
- [ ] API before/after；
- [ ] feed 示例（完整、缺失、重复、错误）；
- [ ] media trust proof；
- [ ] desktop/mobile screenshots；
- [ ] tests/counts/exit codes/CI URLs；
- [ ] fixture/database/process cleanup；
- [ ] known risks/follow-ups；
- [ ] no migration/no production declaration。
