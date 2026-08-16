# Implement: Catalog / Merch 用户心智与媒体工作流修订

| 字段 | 值 |
| --- | --- |
| 文档 ID | `IMPL-CMI-UX-001` |
| 版本 | `0.2.0` |
| 日期 | `2026-08-16` |
| 状态 | **Frozen for Implementation - all cards Pending** |
| 输入 | [spec.md](./spec.md) · [plan.md](./plan.md) · [task.md](./task.md) |

---

## 1. Agent 启动契约

本 docs-only PR 必须先 squash merge 到 `develop`。实施 Agent 必须从已包含本规格的最新
`origin/develop` 开始，不得在 docs PR 未合并时开工，也不得从：

- `master`；
- 已合并的 `feat/catalog-merch-integration`；
- release 分支；
- 本 docs-only 规格分支；
- 任意 detached staging checkout。

标准启动：

~~~bash
cd /root/projects/MoNexus-new
git fetch origin --prune
git worktree add -b fix/catalog-merch-user-ux \
  /root/projects/worktrees/monexus-catalog-merch-user-ux \
  origin/develop
cd /root/projects/worktrees/monexus-catalog-merch-user-ux
~~~

随后记录：

~~~bash
git status --short --branch
git rev-parse HEAD
SPEC_DOCS_COMMIT="$(
  git log -n1 --format=%H origin/develop -- \
    docs/superpowers/specs/2026-08-16-catalog-merch-user-centered-ux
)"
test -n "$SPEC_DOCS_COMMIT"
git merge-base --is-ancestor "$SPEC_DOCS_COMMIT" HEAD
node --version
npm --version
~~~

以上 `test` 或 ancestor 检查任一非零即停止；不得用当前 docs 分支 SHA 手填替代。

要求 Node `20.19.5`、npm 10；若 shell 默认不是 Node 20，使用仓库既有 nvm 路径，
不得升级 lockfile 来规避运行时差异。

---

## 2. 分支、提交与 PR 规范

| 项 | 规则 |
| --- | --- |
| base | `develop` |
| branch | `fix/catalog-merch-user-ux` |
| worktree | `/root/projects/worktrees/monexus-catalog-merch-user-ux` |
| merge | PR -> develop，Squash merge |
| required check | `CI OK` |
| PR label | `run-e2e`（触及 XBoard 管理端关键旅程） |
| 禁止 | `[skip ci]`、直推 develop/master、force push、生产部署 |

提交前始终检查：

~~~bash
git status --short
git diff --check
git diff --stat
~~~

工作树可能存在用户或其他 Agent 改动。不得 reset/checkout/revert 非本任务改动；若影响目标文件，
必须先读懂并兼容，而不是覆盖。

---

## 3. 环境与数据安全

### 3.1 安装

~~~bash
npm ci
npm --prefix server ci
~~~

使用仓库既有 lockfile，不更新依赖，除非 Owner 单独批准。

### 3.2 数据库

- 只允许 disposable local PostgreSQL。
- 推荐复用 catalog-ops dbguard/runner，不手工指向共享默认开发库。
- 禁止使用 production/staging URL、`prisma db push` 或修改既有 migration。
- 测试结束必须清理 database、fixture、临时文件和后台进程。

### 3.3 上传与对象

- 单元/集成测试使用 memory/fake storage 和 StoredObject fixture。
- E2E 上传使用仓库 fixture 图片和测试 bucket/provider。
- 不上传到生产对象存储，不提交生成对象、URL、credentials 或 screenshot 中的 secret。

---

## 4. 文件所有权与热点锁

本任务默认单 Implementation Owner。以下文件修改期间视为整文件锁，不允许另一个 Agent
同时编辑不同区域：

~~~text
src/pages/StorePage.tsx
src/pages/AdminPage.tsx
src/pages/MerchantDashboardPage.tsx
src/pages/merchant/ProductCreateWizard.tsx
src/components/catalog/AdminCategoryManager.tsx
src/components/catalog/AdminFakaImportPreview.tsx
server/src/modules/admin/service.ts
server/src/modules/catalog/categoryService.ts
~~~

子代理可搜索/核验，但不得写代码。需要并行实施时，Owner 必须按 Task 切分完全不重叠的
文件，并明确每个 worker 的 ownership；宿主文件仍串行。

Must Not Touch：

~~~text
server/prisma/schema.prisma
server/prisma/migrations/**
.github/workflows/compose-production-deploy.yml
deploy/vps/**
订单/PointLog/Settlement 持久状态机
Campaign billing/refund 状态机
Identity/notification realtime 非相关实现
~~~

---

## 5. 实施卡与 Entry/Exit Gate

### Card A - Contracts

Entry：规格 docs commit 是 HEAD 祖先，工作树 clean。

Exit：T-UX-001 红测/类型完成；无宿主行为变化。

### Card B - Media domain

Entry：Card A；测试 storage provider 可生成 absolute public URL。

Exit：T-UX-002；server targeted tests PASS；无 migration diff。

### Card C - Cover UX

Entry：Card B；Category 和 XBoard 新 DTO 可用。

Exit：T-UX-003/004；component + server + XBoard targeted tests PASS。

### Card D - Store feed

Entry：Card A；feed pure tests PASS。

Exit：T-UX-005/006；StorePage tests PASS；无 empty shelf 文案。

### Card E - Copy projection

Entry：Card A；映射表测试 PASS。

Exit：T-UX-007/008；目标 static scan 和组件测试 PASS。

### Card F - Final gate

Entry：Cards B-E 全部 PASS，工作树无未解释文件。

Exit：T-UX-009/010，PR 创建且 CI/isolated catalog-ops 全绿。

每张 Card 完成后立即在下方 Evidence Ledger 填一行，不得最后批量补写。

---

## 6. 验证命令

### 6.1 开发中 targeted

前端目标测试使用根脚本实际 CLI；如实施选择了规格允许的替代文件位置，只替换不存在的文件名，
不得删除对应行为覆盖：

~~~bash
npm test -- \
  src/components/merchandising/storeFeed.test.ts \
  src/components/catalog/CategoryCoverField.test.tsx \
  src/components/catalog/catalogIssueMessages.test.ts
~~~

服务端目标测试必须显式使用 disposable CMI database。下面命令从 canonical `server/.env`
取得连接模板，经 dbguard 创建/确认/删除唯一 allowlisted DB；禁止把 URL 打印到日志：

~~~bash
cd /root/projects/worktrees/monexus-catalog-merch-user-ux
set +x
DBGUARD="$PWD/scripts/cmi/dbguard.sh"
bash "$DBGUARD" create
URL_FILE="$(bash "$DBGUARD" make-url-file)"
cleanup() {
  rm -f "$URL_FILE"
  bash "$DBGUARD" drop
}
trap cleanup EXIT

(cd server && \
  DATABASE_URL="$(cat "$URL_FILE")" ./node_modules/.bin/prisma migrate deploy \
    --schema prisma/schema.prisma >/dev/null && \
  TEST_DATABASE_URL="$(cat "$URL_FILE")" \
  DATABASE_URL="$(cat "$URL_FILE")" \
  REDIS_ENABLED=false REDIS_REQUIRED=false \
  ./node_modules/.bin/vitest run --config vitest.config.ts \
    src/modules/catalog/platformMedia.test.ts \
    src/modules/catalog/categoryService.test.ts \
    src/modules/catalog/fakaPreviewConfirm.test.ts)
~~~

`cleanup` 必须执行成功。新 `platformMedia.test.ts` 还必须加入
`scripts/verify-catalog-ops-backend.sh` 的 `TEST_FILES`，使最终后端 runner 覆盖它。

### 6.2 Quick gate

~~~bash
cd /root/projects/worktrees/monexus-catalog-merch-user-ux
npm run verify:quick
git diff --check
~~~

提交功能改动并保持工作树 clean 后运行完整后端隔离门：

~~~bash
bash scripts/verify-catalog-ops-backend.sh
~~~

### 6.3 Catalog-ops E2E

~~~bash
bash scripts/verify-catalog-ops-e2e.sh
~~~

必须使用其独立 PostgreSQL/ports/fixture 生命周期。不得把四个 catalog-ops spec 加回共享
默认 Playwright DB。

### 6.4 静态用户文案 Gate

~~~bash
rg -n \
  '暂无推广内容|暂无精选内容|分色展示|不是扣了两笔|默认封面（平台资源路径）|capacity_limit|null=不限' \
  src/pages src/components
~~~

期望生产 UI 零命中；测试中专门断言旧文案不存在可保留，但应使用更窄扫描说明。

媒体旧逻辑检查：

~~~bash
rg -n "startsWith\('/uploads/'\)|COVER_INVALID.*issue.message" \
  server/src/modules src/components/catalog
~~~

所有命中必须解释：集中安全 helper 内的格式检查允许；Category/XBoard 复制判断和 UI 直出不允许。

### 6.5 CI

- PR -> develop 必须加 `run-e2e`。
- required `CI OK` 必须 PASS。
- catalog-ops integration Playwright job 必须 PASS。
- push -> develop 合并后全量集成门仍需观察，不以 PR 局部成功代替。

---

## 7. Evidence Ledger

实施 Agent 按卡实时填写：

| 日期 | HEAD | Card/Task | 命令 | 结果 | Artifact/备注 |
| --- | --- | --- | --- | --- | --- |
| 2026-08-16 | 5fc4454 | A / T-UX-001 | `npm test -- storeFeed.test.ts catalogIssueMessages.test.ts settlementCopy.test.ts` | exit 0; 31/31 tests | Node v20.19.5/npm 10.8.2; pure feed/media/copy contracts frozen; commit 5fc4454 |
| 2026-08-16 | a263ea0 | B / T-UX-002 | `bash scripts/verify-catalog-ops-backend.sh` | exit 0; 7/7 gates; 25 test files PASS | CMI disposable DB (monexus_test_catalog_merch_integration) migrated+cleaned; server tsc exit 0; commit a263ea0 |
| Pending | Pending | C / T-UX-003/004 | Pending | Pending | Pending |
| Pending | Pending | D / T-UX-005/006 | Pending | Pending | Pending |
| Pending | Pending | E / T-UX-007/008 | Pending | Pending | Pending |
| Pending | Pending | F / T-UX-009/010 | Pending | Pending | Pending |

证据必须含：exit code、测试文件/测试数、Node/npm、脱敏 DB 名、E2E ports、fixture cleanup、
PR/run URL。不得只写“tested”或“CI green”。

---

## 8. PR 描述模板

~~~markdown
## Scope
- unified store product feed
- category/XBoard cover upload workflow
- user-facing copy and stable-code projection

## Frozen decisions
- SPEC-CMI-UX-001 v0.2.0
- no schema/migration/state-machine changes

## Evidence
- AC-UX-001~008: <tests>
- AC-UX-009~017: <tests>
- AC-UX-018~022: <tests>
- catalog-ops E2E: <run/count>
- CI OK: <run>

## Safety
- StoredObject/public bucket/MIME/auth unchanged
- no production/staging data or deployment
- legacy request/read compatibility uses centralized resolver

## Deferred / Follow-up
- <explicit list or None>
~~~

---

## 9. Blocked 模板

~~~text
Blocked task/card:
HEAD and origin/develop:
Repeated blocker evidence:
Exact file/symbol/API:
Frozen decision affected:
Why a safe in-scope implementation is impossible:
Options with trade-offs:
Files changed so far:
Tests already run:
~~~

不得因任务复杂、测试耗时或希望顺手重构而标 Blocked。

---

## 10. Reviewer 交接

实施完成交回 Review Agent 时，必须提供：

1. PR URL 和最终 HEAD；
2. `git diff origin/develop...HEAD --stat`；
3. 每个 AC 对应 test file/断言；
4. 新旧 Category/XBoard request/response 示例；
5. Store feed 12 槽示例和 dedupe/failure 示例；
6. desktop/mobile 截图，含有候选和无候选两种状态；
7. 稳定码/用户消息映射表实际实现位置；
8. 所有测试命令、exit code、计数和 CI run；
9. 已知风险、未完成项、是否新增兼容层；
10. 明确声明未触及 schema/migration/production。
