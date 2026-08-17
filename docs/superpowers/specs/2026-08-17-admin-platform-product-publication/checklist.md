# Checklist: 管理员平台商品发布闭环

| 字段 | 值 |
| --- | --- |
| 文档 ID | `CHK-ADMIN-PUB-001` |
| 输入 | [spec.md](./spec.md) · [plan.md](./plan.md) · [task.md](./task.md) · [implement.md](./implement.md) |
| 状态 | **Frozen for Implementation** |

## 1. Owner Freeze Gate

- [x] README 的 `O-APUB-01..09` 已逐项批准。
- [x] README/spec/plan/task/implement/checklist 状态均改为 `Frozen for Implementation`。
- [ ] docs-only PR 已 Squash merge 到 `develop`。
- [ ] 实施分支从包含 specs commit 的最新 `origin/develop` 创建。

任一未满足，不得开始生产代码。

## 2. P0 功能

- [ ] `P0-01` XBoard confirm 仍创建 draft，不自动 publish。
- [ ] `P0-02` 导入成功后立即打开/进入 readiness 检查。
- [ ] `P0-03` readiness 失败不回滚、不重复 confirm、不丢草稿。
- [ ] `P0-04` Admin 商品列表展示草稿/已发布/已下架。
- [ ] `P0-05` 只有 `merchantId=null` 展示管理员发布动作。
- [ ] `P0-06` draft/inactive 发布前每次 GET admin readiness。
- [ ] `P0-07` ready 才能发布；POST 只走 admin publish。
- [ ] `P0-08` 422/409/网络失败不伪造成功并可重试。
- [ ] `P0-09` active 平台商品有确认式下架；取消零请求。
- [ ] `P0-10` 同商品快速双击只有一个 in-flight 写请求。
- [ ] `P0-11` 成功后重新读取服务端列表状态。
- [ ] `P0-12` 页面不显示稳定码、field、raw Product/Offer/merchant/SKU ID。

## 3. P0 安全与边界

- [ ] `SEC-01` 未修改 admin authenticate/active/admin/MFA middleware。
- [ ] `SEC-02` 未调用 merchant readiness/publish/unpublish 路径。
- [ ] `SEC-03` 客户端未直接提交或伪造 Product status。
- [ ] `SEC-04` 未修改 XBoard HMAC/sourceHash/idempotency/capacity/sanitizer。
- [ ] `SEC-05` 未修改 schema/migration/storage/订单/库存/营销契约。
- [ ] `SEC-06` 测试未连接 production/staging 或真实 XBoard。
- [ ] `SEC-07` 日志、fixture、截图和提交无 secret/库存内容。
- [ ] `SEC-08` 没有声称 publish/unpublish 已有 actor audit；`DEBT-APUB-001` 保留。

## 4. P0 UX 与可访问性

- [ ] `UX-01` 导入成功明确为“已保存为草稿”，不是“已发布”。
- [ ] `UX-02` 主动作是“发布到商城”，次动作是“稍后处理”。
- [ ] `UX-03` 状态不只依赖颜色。
- [ ] `UX-04` readiness issue 使用中文业务文案和规格名称。
- [ ] `UX-05` loading/error/retry/disabled 均有明确状态。
- [ ] `UX-06` Dialog 可键盘操作并有标题/关闭动作。
- [ ] `UX-07` 360px 和桌面均无重叠、截断或布局跳动。
- [ ] `UX-08` 下架确认说明商城隐藏但订单/资源保留。

## 5. 验收标准证据索引

| AC | 状态 | 证据 |
| --- | --- | --- |
| AC-APUB-001 | Pending | |
| AC-APUB-002 | Pending | |
| AC-APUB-003 | Pending | |
| AC-APUB-004 | Pending | |
| AC-APUB-005 | Pending | |
| AC-APUB-006 | Pending | |
| AC-APUB-007 | Pending | |
| AC-APUB-008 | Pending | |
| AC-APUB-009 | Pending | |
| AC-APUB-010 | Pending | |
| AC-APUB-011 | Pending | |
| AC-APUB-012 | Pending | |
| AC-APUB-013 | Pending | |
| AC-APUB-014 | Pending | |
| AC-APUB-015 | Pending | |
| AC-APUB-016 | Pending | |
| AC-APUB-017 | Pending | |
| AC-APUB-018 | Pending | |

## 6. Test Gate

- [ ] API adapter unit tests PASS。
- [ ] Publication checklist unit tests PASS。
- [ ] Admin publication dialog component tests PASS。
- [ ] AdminPage product workflow tests PASS。
- [ ] Admin publication route characterization PASS。
- [ ] Existing merchant publication tests PASS。
- [ ] Catalog-ops backend runner PASS。
- [ ] Catalog-ops E2E runner PASS，包含 XBoard draft -> publish。
- [ ] `npm run verify:quick` PASS。
- [ ] `git diff --check` PASS。
- [ ] PR `run-e2e` label 已添加，`CI OK` PASS。

## 7. PR Gate

- [ ] PR 目标为 `develop`，不是 master。
- [ ] 变更仅限 task Owned 文件和证据文档。
- [ ] 无 lockfile、migration、workflow 或生成物漂移。
- [ ] PR 描述逐项映射 AC 和测试证据。
- [ ] 所有 P0/SEC/Test Gate 为 PASS。
- [ ] 所有 Pending/Failed 已清零，或 Owner 书面降级为后续范围。
- [ ] Squash merge；禁止 `[skip ci]`、force push、直推或生产部署。

任一 P0、SEC 或 Test Gate 为 Pending/Failed，不得宣称 ready-to-merge。
