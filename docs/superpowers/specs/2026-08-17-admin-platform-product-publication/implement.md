# Implement: 管理员平台商品发布闭环

| 字段 | 值 |
| --- | --- |
| 文档 ID | `IMPL-ADMIN-PUB-001` |
| 输入 | [spec.md](./spec.md) · [plan.md](./plan.md) · [task.md](./task.md) |
| 状态 | **Frozen for Implementation** |

## 1. Agent 启动契约

规格 docs-only PR 必须先 squash merge 到 `develop`。实施 Agent 必须从包含本规格的最新
`origin/develop` 创建新 worktree，不得从 master、release、旧 CMI worktree 或 detached HEAD 开始。

~~~bash
cd /root/projects/MoNexus-new
git fetch origin --prune
git worktree add -b fix/admin-platform-product-publication \
  /root/projects/worktrees/monexus-admin-platform-publication \
  origin/develop
cd /root/projects/worktrees/monexus-admin-platform-publication

git status --short --branch
git rev-parse HEAD
SPEC_DOCS_COMMIT="$(
  git log -n1 --format=%H origin/develop -- \
    docs/superpowers/specs/2026-08-17-admin-platform-product-publication
)"
test -n "$SPEC_DOCS_COMMIT"
git merge-base --is-ancestor "$SPEC_DOCS_COMMIT" HEAD
test "$(sed -n 's/.*状态 | \*\*\(.*\)\*\*.*/\1/p' \
  docs/superpowers/specs/2026-08-17-admin-platform-product-publication/README.md | head -n1)" \
  = "Frozen for Implementation"
node --version
npm --version
~~~

任一检查非零即停止。要求 Node `20.19.5`、npm 10；不得更新 lockfile 规避运行时差异。

## 2. 分支与 PR

| 项 | 规则 |
| --- | --- |
| base | `develop` |
| branch | `fix/admin-platform-product-publication` |
| worktree | `/root/projects/worktrees/monexus-admin-platform-publication` |
| merge | PR -> develop，Squash merge |
| required | `CI OK` |
| label | `run-e2e`（强制，因为改变 XBoard 管理端关键旅程） |
| 禁止 | `[skip ci]`、直推 develop/master、force push、生产部署 |

不要复用已合并的 `fix/catalog-merch-user-ux` 或 release worktree。

## 3. 环境与安全

~~~bash
npm ci
npm --prefix server ci
npm run check:runtime
~~~

- 只允许 disposable local PostgreSQL 和仓库 XBoard fixture。
- 禁止 production/staging DB、`prisma db push`、修改既有 migration。
- 上传测试只用 memory/fake 或测试 bucket；不得写生产对象存储。
- 不打印 credential、database URL、session、MFA secret、externalSku 或库存内容。
- E2E 后清理 DB、fixture、临时文件和本卡启动的进程。

## 4. 提交顺序

建议提交保持可审查：

1. `feat(admin): add platform product publication adapters`
2. `fix(catalog): render publication readiness for users`
3. `feat(admin): close platform product publication workflow`
4. `test(admin): cover xboard draft to publication journey`
5. `docs(admin): record publication gate evidence`

不要为追求提交数拆分同一行为的代码和测试；PR 最终 Squash。

每次提交前：

~~~bash
git status --short
git diff --check
git diff --stat
~~~

## 5. 实施 Gate

### 5.1 定向前端

~~~bash
npm test -- \
  src/api/admin.catalog.test.ts \
  src/components/catalog/ProductPublicationChecklist.test.tsx \
  src/components/catalog/AdminProductPublicationDialog.test.tsx \
  src/components/catalog/AdminCatalogWorkflows.test.tsx \
  src/pages/AdminPage.test.tsx
~~~

如果新建 `AdminPage.products.test.tsx`，把它加入命令。

### 5.2 定向后端

使用仓库 dbguard/disposable DB 运行：

~~~bash
npm --prefix server test -- \
  src/modules/catalog/adminPublicationRoutes.test.ts \
  src/modules/catalog/publicationRoutes.test.ts \
  src/modules/catalog/publicationReadiness.test.ts
~~~

### 5.3 Catalog / XBoard

~~~bash
bash scripts/verify-catalog-ops-backend.sh
bash scripts/verify-catalog-ops-e2e.sh
~~~

专用 E2E runner 固定使用其配置的 API/Vite/XBoard fixture 端口；不得把 fixture 指向真实 XBoard。

### 5.4 仓库 Gate

~~~bash
npm run verify:quick
git diff --check
git status --short
~~~

PR 加 `run-e2e` 后等待 `CI OK`。任何失败必须修复或书面归因；不得删除/放宽断言。

## 6. 静态反模式 Gate

~~~bash
rg -n "/merchant/products/.+(readiness|publish|unpublish)" \
  src/pages/AdminPage.tsx src/components/catalog/AdminProductPublicationDialog.tsx src/api/admin.ts

rg -n "COVER_REQUIRED|CATEGORY_INACTIVE|OFFER_NOT_SELLABLE|EXTERNAL_IDENTITY_INVALID|规格 [0-9]" \
  src/pages/AdminPage.tsx \
  src/components/catalog/AdminProductPublicationDialog.tsx \
  src/components/catalog/ProductPublicationChecklist.tsx
~~~

第一条必须零命中。第二条若命中 switch/data attribute/test fixture 之外的 visible JSX，Gate 失败。

另行检查没有：

- 客户端 `status='active'` 写入；
- import confirm 后自动调用 publish；
- 对 `merchantId!=null` 渲染 admin 发布按钮；
- readiness 失败后重新 confirm XBoard；
- visible Product/Offer raw ID。

## 7. 手工验收

在 desktop 与 360x800 viewport 各验证一次：

1. XBoard confirm 后显示“已导入为草稿”并进入检查。
2. 未点击前 Network 无 publish 请求。
3. ready 后点击发布，列表显示“已发布”，公开商城能找到商品。
4. 导入另一个草稿并选择“稍后处理”，列表能再次打开发布。
5. 下架确认取消时零请求；确认时商品变为“已下架”。
6. 商家商品没有管理员发布/下架动作。
7. 页面无 raw code、field、Offer ID、merchantId、externalSku。
8. 移动端名称、状态、库存和操作不重叠。

## 8. Evidence Ledger 模板

每条证据必须记录：

~~~text
Date:
HEAD:
Card/AC:
Command:
Exit code:
Result (file/count):
Node/npm:
Disposable DB name (redacted prefix only):
E2E ports/fixture:
Cleanup:
PR URL:
CI run URL:
Notes:
~~~

“tested”“all green”或截图单独存在都不是证据。

## 9. 停止条件

出现以下任一项必须停止并报告 Owner：

- 需要修改 Must Not Touch 的生产文件；
- admin API 实际没有 Admin + MFA；
- readiness/publish response 与冻结契约不一致；
- 完成 UI 必须改变 Product/XBoard/schema；
- 真实测试只能连接共享、staging 或 production 数据源；
- 发现并发修改覆盖目标热点文件。
