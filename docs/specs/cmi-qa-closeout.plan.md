# CMI 收口执行计划(cmi-qa-closeout)

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-08-13 |
| 分支 | `feat/catalog-merch-integration`(worktree `/root/projects/worktrees/monexus-catalog-merch-integration`) |
| 权威规格 | [AMD-CMI-012](../superpowers/specs/2026-08-13-cmi-qa-rescope-v012.md) + Catalog/Merch 六件套 v0.1.2 |
| 协调者 | Claude(spec/评审/commit) |
| 实施 | pi agent(`pi -p --thinking max`,非交互后台,逐卡 `--session-id`) |

## 现状快照(2026-08-13)

- 相对 develop 82 提交:基线链 `S→A_CMI→F0→B_CAT→F`、四条 lane 合并、CMI 集成接线全部完成;三个 catalog e2e spec(5536 行)已绿。
- merge-base 停在 develop@da38dd0(PR #128);develop 已前进至 #130/#132/#133/#134(realtime 修复、CI 3-shard、testing-policy)。
- 剩余工作 = QA 收口(按 v0.1.2 裁剪)+ merge develop + 证据采集 + PR。

## 执行协议

1. 派发命令模板(工作目录必须是本 worktree):
   `cd /root/projects/worktrees/monexus-catalog-merch-integration && pi -p --thinking max --session-id <card-id> @docs/specs/cmi-qa-closeout.plan.md "Execute card <ID> from the attached plan. Work autonomously to completion, then print the final report."`
2. **串行派发**(共享 worktree/DB;e2e 栈固定端口 API 3105 / Vite 5180 / Xboard fixture 3106,以 `playwright.catalog-ops.config.ts` 为准);同一时间只有一张卡在跑。
3. pi **不得 commit / push**;改动留在工作区,协调者 review 后提交。
4. 禁止 rebase / force push / reset --hard;develop 合入只用 merge。
5. 返修:同 `--session-id` 追加指令复用上下文。
6. 卡序:C2 → C2b → C3 → C4 → C5 → C6(C1 已完成)。

## 卡片

### C1 — xboard WIP 处置(已完成,协调者)

未提交的 cover helper 重构无消费者,对应场景("无封面不可 confirm")按 v0.1.2 下沉服务端;已 `git stash`(`wip: xboard cover helper refactor (superseded by v0.1.2 QA rescope)`)。该场景转入 C3 候选缺口。

### C2 — merch 冒烟 e2e(pi,session `cmi-c2-smoke`)

Dispatch text (English, verbatim):

> Execute task card T-MERCH-QA-003 v0.1.2. Create exactly ONE new Playwright spec `e2e/merchandising-smoke.spec.ts` in this worktree and make it pass.
>
> Read first (in this order): `docs/superpowers/specs/2026-08-13-cmi-qa-rescope-v012.md` (§2, §3.5 define scope and evidence rules), `docs/superpowers/specs/2026-08-09-merchandising-governance/task.md` (T-MERCH-QA-003 card), `playwright.catalog-ops.config.ts` (fixed ports 3126/5196, database guard), `e2e/catalog-product-lifecycle.spec.ts` and `e2e/helpers.ts` (repo e2e conventions), `scripts/verify-catalog-ops-backend.sh` and `scripts/cmi/dbguard.sh` (how env/DB are set up), and the merchandising server module + `src/components/merchandising/*` to learn real testids/APIs.
>
> Scenario (single deterministic happy path, ≤400 lines, `test.describe.serial`): admin creates a promotion package → merchant requests a campaign for their own active product → admin approves (points charged) → campaign reaches `active` (schedule it so it is active immediately upon approval if the domain allows; otherwise use a legitimate service/API seam — NEVER a raw DB UPDATE to force status; DB seeding is allowed only for fixture inputs, following the existing catalog e2e seeding pattern) → load the Store page once and assert: sponsored shelf shows the product with per-item "推广" text disclosure; organic list does not double-count the sponsored item; badge order and editorial/partner marks only as far as the seeded state guarantees deterministically → merchant campaign panel shows `active` timeline state.
>
> Constraints: register the new spec in `playwright.catalog-ops.config.ts` testMatch. Do NOT modify any production code under `src/` or `server/src/`, any other spec, schema/migrations, docs, or notification/Layout/appStore files. No `page.waitForTimeout`; use response/testid waits like the catalog specs. Reuse existing helpers; add new helpers only inside the new spec file or `e2e/support/`. Do not duplicate assertions already covered by `src/components/merchandising/*.test.tsx` or `src/pages/StorePage.cmi.test.tsx` (spot-check them).
>
> Verify: run the new spec via the catalog-ops config (same env pattern the verify scripts use; `CATALOG_OPS_DATABASE_URL` must point at `monexus_test_catalog_merch_integration`; Node 20). Then run the full catalog-ops Playwright suite once to prove no cross-spec pollution. Do NOT commit.
>
> Final report: files changed, exact commands you ran with pass/fail counts, any deviation from this card with reasons, and anything you discovered that looks like a product bug (report only — do not fix).

**C2 结果(2026-08-13,协调者记录)**:`e2e/merchandising-smoke.spec.ts`(224 行,3 用例)+ config 注册以 `d6ce4d5` 提交;协调者在全新 DB 上独立复跑 **3/3 全绿(13.8s)**。pi 会话在打印最终报告前被截断,交付以磁盘状态与协调者复跑为准。冒烟发现的 chargedPoints 契约缺陷 → C2b。

### C2b — merchant DTO chargedPoints 投影修复(pi,session `cmi-c2b-chargedpoints`)

**协调者裁决**:SPEC-MERCH-001 §7.5 的"不返回 chargedPoints"仅约束公开 sponsored 端点;§5.4 数据模型与前端冻结契约(`src/types/merchandising.ts` `PromotionCampaignDTO`:"charged/refunded points are the merchant's own ledger")要求 merchant 自己的活动 DTO 携带 `chargedPoints/refundedPoints`。BE `toMerchantCampaignDto` 过度适用公开排除规则导致商家时间线显示"已扣 0 积分"(实扣 100)。修复归 BE 侧,按原 Owner 卡语义提交(`fix(merch): ...`)。

Dispatch text (English, verbatim):

> Fix a confirmed cross-lane DTO contract defect (coordinator adjudication above).
>
> **Change (minimal)**: in `server/src/modules/merchandising/promotions/dto.ts`, add `chargedPoints: number` and `refundedPoints: number` to `MerchantCampaignDto` and populate them in `toMerchantCampaignDto` from the row; deduplicate the `AdminCampaignDto` re-declaration if it becomes redundant (the admin DTO's emitted shape must remain byte-identical). Do NOT add any other field to the merchant DTO (no reviewer/reason/keys/hashes/point-log ids). Do NOT touch `publicSponsored.ts`, `billing.ts` logic, schema/migrations, or FE components.
>
> **FE parser**: inspect `src/api/merchandising.ts` — if the merchant campaign parser defaults missing `chargedPoints`/`refundedPoints` to 0, tighten to require finite integers (contract now guaranteed); if it already requires them, change nothing.
>
> **Tests**: update `server/src/modules/merchandising/__tests__/promotions-dto-state.test.ts`: assert an approved campaign's merchant DTO carries `chargedPoints === pricePointsSnapshot`; assert refund adjustment reflects in `refundedPoints`; keep/extend the merchant-DTO field allowlist assertion (still no reviewer/internal/key/hash fields). Confirm the public sponsored surface still never returns `chargedPoints` (cite the existing test that proves it in your report; add a one-line assertion only if none exists).
>
> **Verify**: run the merchandising server test files (see `scripts/verify-catalog-ops-backend.sh` for the env pattern; database must be `monexus_test_catalog_merch_integration`) and any FE unit test covering the parser (`npm test -- <file>` at repo root). Do NOT commit.
>
> **Report**: files changed, commands + results, and the public-surface non-leak evidence reference.

### C3 — 集成测试覆盖审计 + 缺口补齐(pi,session `cmi-c3-gaps`)

Dispatch text (English, verbatim):

> Execute task cards T-CAT-QA-002, T-MERCH-QA-001, T-MERCH-QA-002 (all v0.1.2 — evidence audit, NOT new harnesses). Read `docs/superpowers/specs/2026-08-13-cmi-qa-rescope-v012.md` §2–§4 first, then the three cards in the two task.md files.
>
> Work: build the evidence map `docs/specs/cmi-qa-evidence-map.md` — for every CHK item in `docs/superpowers/specs/2026-08-09-catalog-operations/checklist.md` sections 3–8 and `docs/superpowers/specs/2026-08-09-merchandising-governance/checklist.md` sections 2–6, list the concrete evidence reference (test file + test case name) or mark `GAP`/`Deferred (AMD-CMI-012 §3.6)`/`P1` per the amendment's §4 remapping. Search the real test files — do not guess; a CHK maps to a test only if an assertion actually proves it.
>
> For each `GAP`, add a targeted server integration test (Vitest under `server/src`, real PG, following the module's existing test file style). Budget: catalog gaps unbounded but each test minimal; merch gaps ≤3 test cases total. Known candidate gap to verify first: "Xboard confirm is rejected when the category has no default cover and no uploaded cover" (422, zero writes) — check whether an existing server test already proves this before writing one. Additionally create `scripts/verify-catalog-ops-e2e.sh` codifying the verified runner sequence from this plan's appendix (附:catalog-ops e2e 运行序列): dbguard DB lifecycle, seed:force env block, fixture server start with trap-based cleanup, playwright run, non-zero exit on any failure; secret-safe (never echo the database URL or credentials). Allowed files: new test files, `docs/specs/cmi-qa-evidence-map.md`, `scripts/verify-catalog-ops-e2e.sh`. Do NOT touch production code, schema/migrations, or existing e2e specs.
>
> Verify: run the affected server test files (`server` dir, Vitest; TEST_DATABASE_URL → `monexus_test_catalog_merch_integration`, `REDIS_ENABLED=false`, rate limit raised per repo convention — check existing verify scripts and `server/package.json`). Do NOT commit.
>
> Final report: evidence-map stats (covered/gap/deferred counts per checklist), new tests added with their run results, and any CHK you could not map with certainty (list them explicitly — do not silently mark covered).

### C4 — merge origin/develop + 工具链融合(pi,session `cmi-c4-merge`)

Dispatch text (English, verbatim):

> Merge the latest `origin/develop` into this branch (`git fetch` then `git merge origin/develop`). NEVER rebase, never force-push, never reset --hard. Expected conflict surface: `server/prisma/schema.prisma` (realtime models from PR #130/#133 vs CMI models — keep both; CMI models were added by the F0 foundation commit and must not change), `package.json`/`package-lock.json` both root and `server/` (PR #134 added `verify:quick`, CI sharding scripts, frontend unit gate — keep both sides), root `vitest.config.ts` (this branch added one; #134 may have its own frontend test config — unify without losing either), `.github/workflows/ci.yml` (3-shard backend + parallel e2e from #134 is authoritative; integrate, do not revert).
>
> After merge: `npm install` in root and `server/` (Node 20), `npx prisma generate` in `server/`, `npx prisma migrate deploy` against the CMI test database `monexus_test_catalog_merch_integration` (resolve migration ordering if realtime added migrations — never edit committed migrations; if deploy fails on the disposable test DB, recreating that DB from scratch is allowed, but touch ONLY `monexus_test_catalog_merch_integration`).
>
> CI integration decision (implement option A; fall back to B only with written justification): the three `catalog-*.spec.ts` specs and `merchandising-smoke.spec.ts` currently run only under `playwright.catalog-ops.config.ts` (dedicated env/fixture server). Under the default `playwright.config.ts` they would fail in CI (`npm run e2e`) because the Xboard fixture server and seeds are missing. Option A: make them runnable under the default config — port the Xboard fixture server into the default config's webServer list (or a global setup) and make the seeds target the default test DB, so CI covers them natively. Option B: add them to the default config's `testIgnore` and register a separate CI job using the catalog-ops config, keeping total e2e wall-clock parallel per PR #134's structure.
>
> Verify: root `npm test`, `server` tests (full run, 3-shard script if present), `npm run e2e` for the affected specs (or the option-B job path), plus `npm run verify:quick` if it landed from #134. Do NOT commit (leave the merge uncommitted only if conflicts remain unresolved — otherwise complete the merge commit locally since an unfinished merge blocks the tree; this is the ONE allowed commit, message `merge(cmi): integrate develop <sha>`; everything else stays uncommitted).
>
> Final report: conflicts and how each was resolved, dependency/prisma actions taken, CI integration option chosen with evidence it runs, full test results.

### C5 — 最终 Gate + 证据回填(协调者主导,pi 跑长命令)

在 C4 后的 HEAD 上按一条命令序列采集:foundation/backend verify 脚本 → server 全量 → 根测试 → catalog-ops e2e 全量(含冒烟)→ PAR Gate ancestor 命令。把 evidence-map 内容折入两份 checklist.md 勾选与 implement.md Evidence Ledger;PAR-GATE-001~011 逐条记录。文档由协调者书写。

### C6 — PR(协调者)

按 `docs/branching-and-ci.md`:PR → develop,打 `run-e2e` 标签(触及关键旅程与横切面),PR 描述含 v0.1.2 修订说明、Deferred 清单(ASSET/P1 性能)、evidence 摘要。

## Review 要点(协调者逐卡执行)

- C2:场景是否确定性(无 sleep/竞态)、断言是否越权复制组件测试、行数与场景数是否守约、有无触碰禁区文件。
- C3:evidence 引用抽查 ≥10 条(打开测试文件核对断言确实证明该 CHK)、GAP 测试是否最小、有无顺手改生产代码。
- C4:`git log --merges -1` 与冲突文件逐个 diff、schema 双侧模型齐全、migrations 未被改写、CI 选项落地证据。
- 全程:`git diff --stat` 边界核对 + secret 扫描(无 key/object key/credential 入库)。

## 附:catalog-ops e2e 运行序列(2026-08-13 协调者实测可复现)

```bash
cd /root/projects/worktrees/monexus-catalog-merch-integration
export PATH="/root/.nvm/versions/node/v20.19.5/bin:$PATH"     # Node 20
export E2E_ADMIN_MFA_TOTP_SECRET='<32位 A-Z2-7 Base32>'
bash scripts/cmi/dbguard.sh drop && bash scripts/cmi/dbguard.sh create
URL_FILE=$(bash scripts/cmi/dbguard.sh make-url-file)
export CATALOG_OPS_DATABASE_URL="$(cat "$URL_FILE")"; rm -f "$URL_FILE"
( cd server \
  && DATABASE_URL="$CATALOG_OPS_DATABASE_URL" npx prisma migrate deploy \
  && NODE_ENV=test DATABASE_URL="$CATALOG_OPS_DATABASE_URL" \
     FRONTEND_ORIGIN='http://127.0.0.1:5180' COOKIE_SECURE=false API_RATE_LIMIT_MAX=3000 \
     JWT_SECRET='catalog-ops-e2e-jwt-secret-at-least-32-characters' \
     MFA_ENCRYPTION_KEY='BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=' \
     E2E_ADMIN_MFA_TOTP_SECRET="$E2E_ADMIN_MFA_TOTP_SECRET" \
     REDIS_ENABLED=false REDIS_REQUIRED=false \
     NOTIFICATION_ENABLED=false NOTIFICATION_EMAIL_ENABLED=false \
     FAKA_BRIDGE_URL='http://127.0.0.1:3106/order-paid' \
     FAKA_BRIDGE_STATUS_URL='http://127.0.0.1:3106/order-status' \
     FAKA_BRIDGE_REVOKE_URL='http://127.0.0.1:3106/order-revoke' \
     FAKA_BRIDGE_SECRET='catalog-ops-e2e-faka-bridge-secret-0123456789abcdef' \
     FAKA_BRIDGE_ALLOW_INSECURE_TARGETS=true STORAGE_UI_CONFIG_ENABLED=false \
     npm run db:seed:force )
node scripts/cmi/xboard-fixture-server.mjs --port 3106 \
  --secret 'catalog-ops-e2e-faka-bridge-secret-0123456789abcdef' >/tmp/cmi-fixture.log 2>&1 &
npx playwright test --config playwright.catalog-ops.config.ts   # 或指定单个 spec
# 结束后 kill fixture 进程
```

坑位记录(实测踩过):
1. seed 必须用 `db:seed:force`——`server/src/prisma/e2eSeedGuard.ts` 只在 `--force-reset` + `NODE_ENV=test` + 白名单库(`/monexus_test`、`/monexus_test_catalog_merch_integration`)下允许种入 admin TOTP 因子。
2. seed 进程会加载 server 配置 zod,缺 `FRONTEND_ORIGIN` 等必填 env 时报 `[Config] Invalid environment variables`;且该失败路径 **exit 0**(健壮性缺陷,C3 审计时列观察项),必须镜像 `playwright.catalog-ops.config.ts` 的 `apiWebServerEnv` 传参。
3. e2e 依赖手起 Xboard fixture server(3106);config 注释"started by the verify runner",但 verify runner 脚本尚不存在——C3 顺带产出 `scripts/verify-catalog-ops-e2e.sh` 固化本序列。
4. 冒烟 spec 需全新 DB:placement partial unique 会让上一轮遗留的 active campaign 与新一轮申请冲突。
