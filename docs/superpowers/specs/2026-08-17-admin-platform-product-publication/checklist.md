# Checklist: 管理员平台商品发布闭环

| 字段 | 值 |
| --- | --- |
| 文档 ID | `CHK-ADMIN-PUB-001` |
| 输入 | [spec.md](./spec.md) · [plan.md](./plan.md) · [task.md](./task.md) · [implement.md](./implement.md) |
| 状态 | **Frozen for Implementation** |

## 1. Owner Freeze Gate

- [x] README 的 `O-APUB-01..09` 已逐项批准。
- [x] README/spec/plan/task/implement/checklist 状态均改为 `Frozen for Implementation`。
- [x] docs-only PR 已 Squash merge 到 `develop`（#141 → `873952d`）。
- [x] 实施分支从包含 specs commit 的最新 `origin/develop` 创建（`fix/admin-platform-product-publication` @ `873952d`）。

任一未满足，不得开始生产代码。

## 2. P0 功能

- [x] `P0-01` XBoard confirm 仍创建 draft，不自动 publish。
- [x] `P0-02` 导入成功后立即打开/进入 readiness 检查。
- [x] `P0-03` readiness 失败不回滚、不重复 confirm、不丢草稿。
- [x] `P0-04` Admin 商品列表展示草稿/已发布/已下架。
- [x] `P0-05` 只有 `merchantId=null` 展示管理员发布动作。
- [x] `P0-06` draft/inactive 发布前每次 GET admin readiness。
- [x] `P0-07` ready 才能发布；POST 只走 admin publish。
- [x] `P0-08` 422/409/网络失败不伪造成功并可重试。
- [x] `P0-09` active 平台商品有确认式下架；取消零请求。
- [x] `P0-10` 同商品快速双击只有一个 in-flight 写请求。
- [x] `P0-11` 成功后重新读取服务端列表状态。
- [x] `P0-12` 页面不显示稳定码、field、raw Product/Offer/merchant/SKU ID。

## 3. P0 安全与边界

- [x] `SEC-01` 未修改 admin authenticate/active/admin/MFA middleware。
- [x] `SEC-02` 未调用 merchant readiness/publish/unpublish 路径。
- [x] `SEC-03` 客户端未直接提交或伪造 Product status。
- [x] `SEC-04` 未修改 XBoard HMAC/sourceHash/idempotency/capacity/sanitizer。
- [x] `SEC-05` 未修改 schema/migration/storage/订单/库存/营销契约。
- [x] `SEC-06` 测试未连接 production/staging 或真实 XBoard。
- [x] `SEC-07` 日志、fixture、截图和提交无 secret/库存内容。
- [x] `SEC-08` 没有声称 publish/unpublish 已有 actor audit；`DEBT-APUB-001` 保留。

## 4. P0 UX 与可访问性

- [x] `UX-01` 导入成功明确为“已保存为草稿”，不是“已发布”。
- [x] `UX-02` 主动作是“发布到商城”，次动作是“稍后处理”。
- [x] `UX-03` 状态不只依赖颜色。
- [x] `UX-04` readiness issue 使用中文业务文案和规格名称。
- [x] `UX-05` loading/error/retry/disabled 均有明确状态。
- [x] `UX-06` Dialog 可键盘操作并有标题/关闭动作。
- [x] `UX-07` 360px 和桌面均无重叠、截断或布局跳动。
- [x] `UX-08` 下架确认说明商城隐藏但订单/资源保留。

## 5. 验收标准证据索引

| AC | 状态 | 证据 |
| --- | --- | --- |
| AC-APUB-001 | PASS | `AdminPage.products.test.tsx` handoff；`e2e/catalog-xboard-import.spec.ts` confirm 后仍为 draft 并打开发布检查 |
| AC-APUB-002 | PASS | `AdminProductPublicationDialog.test.tsx` loading 阶段 `publish` 未调用；XBoard E2E `publishRequestCount === 0` 直到点击发布 |
| AC-APUB-003 | PASS | `AdminPage.products.test.tsx` 草稿/已发布/已下架/状态未知 |
| AC-APUB-004 | PASS | `AdminPage.products.test.tsx` 商家行仅“由商家管理” |
| AC-APUB-005 | PASS | Dialog + AdminPage host：open 时 `GET /admin/products/:id/readiness` |
| AC-APUB-006 | PASS | Dialog + host + XBoard E2E：仅 `POST /admin/products/:id/publish`，成功后列表为已发布 |
| AC-APUB-007 | PASS | Checklist/Dialog 无稳定码/raw ID；冲突 CTA 改为“打开已导入商品的发布检查”，组件测试断言不含 `#55` |
| AC-APUB-008 | PASS | Dialog 422 测试：对话框保留、issues 刷新、无成功 toast |
| AC-APUB-009 | PASS | Dialog later + host handoff：不调用 publish，列表仍有发布入口 |
| AC-APUB-010 | PASS | `AdminPage.products.test.tsx` `window.confirm=false` 时 `unpublish` 零调用 |
| AC-APUB-011 | PASS | 确认下架后 reload 为已下架；toast 不含删除订单/资源 |
| AC-APUB-012 | PASS | inactive 行“重新上架”打开同一 readiness 对话框，不直接写 active |
| AC-APUB-013 | PASS | Dialog publish 双击 + AdminPage unpublish 双击均为单请求 |
| AC-APUB-014 | PASS | Dialog readiness 网络失败：草稿保留，可重试/稍后处理 |
| AC-APUB-015 | PASS | `admin.catalog.test.ts` 四条路径；`rg` 管理员文件零命中 merchant publish/readiness |
| AC-APUB-016 | PASS | `e2e/catalog-xboard-import.spec.ts` `assertAdminProductRowReadable` 在 360x800 与 1280x800 断言名称/状态/操作不重叠且行宽不超出视口 |
| AC-APUB-017 | PASS | `e2e/catalog-xboard-import.spec.ts`：导入 draft → readiness → publish active → `GET /api/products/:id` 200 → 商城卡片可见 |
| AC-APUB-018 | PASS | 定向前端 43、catalog-ops 后端 26 files/281、catalog-ops E2E 31、`verify:quick` 全绿。官方 `verify-catalog-ops-backend.sh` 仍锁在 CMI 旧分支名，已用同一 TEST_FILES + dbguard 等价执行 |

## 6. Test Gate

- [x] API adapter unit tests PASS。
- [x] Publication checklist unit tests PASS。
- [x] Admin publication dialog component tests PASS。
- [x] AdminPage product workflow tests PASS。
- [x] Admin publication route characterization PASS。
- [x] Existing merchant publication tests PASS。
- [x] Catalog-ops backend runner PASS（等价 TEST_FILES + dbguard；官方脚本 Gate 0 分支锁未改）。
- [x] Catalog-ops E2E runner PASS，包含 XBoard draft -> publish。
- [x] `npm run verify:quick` PASS。
- [x] `git diff --check` PASS。
- [x] PR `run-e2e` label 已添加，`CI OK` PASS。

## 7. PR Gate

- [x] PR 目标为 `develop`，不是 master。
- [x] 变更仅限 task Owned 文件和证据文档。
- [x] 无 lockfile、migration、workflow 或生成物漂移。
- [x] PR 描述逐项映射 AC 和测试证据。
- [x] 所有 P0/SEC/Test Gate 为 PASS。
- [x] 所有 Pending/Failed 已清零，或 Owner 书面降级为后续范围。
- [ ] Squash merge；禁止 `[skip ci]`、force push、直推或生产部署。

任一 P0、SEC 或 Test Gate 为 Pending/Failed，不得宣称 ready-to-merge。

## 8. Evidence Ledger

```text
Date: 2026-08-17
HEAD: 022a857c70ee3f758a1b2984ae72990efcd73755
Card/AC: T-APUB-001..006 / AC-APUB-001..018 + review refresh concurrency
Command:
  npx tsc -b
  npm test -- src/pages/AdminPage.products.test.tsx src/pages/AdminPage.test.tsx
Exit code: 0 / 0
Result (file/count):
  AdminPage host 11 passed (includes unpublish lock-until-refresh and stale reload)
  tsc -b passed
Node/npm: v20.19.5 / 10.8.2
Disposable DB name (redacted prefix only): n/a for this follow-up
E2E ports/fixture: prior XBoard 360/1280 geometry remains in catalog-xboard-import.spec.ts
Cleanup: n/a
PR URL: https://github.com/amo0114/MoNexus/pull/142
CI run URL: https://github.com/amo0114/MoNexus/actions/runs/32000100722 (green on 5d2a052; this commit supersedes)
Notes:
  Review follow-up: unpublish busy lasts through list refresh; reloadProducts uses latest-request guard; retry disabled while reloading.
  Previous implementation HEAD 5d2a052. DEBT-APUB-001 remains open.
```
