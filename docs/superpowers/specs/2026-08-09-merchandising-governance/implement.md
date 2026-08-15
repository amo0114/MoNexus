# Implement Protocol: 热卖、推广与平台身份展示

| 字段 | 值 |
| --- | --- |
| 文档 ID | IMPL-MERCH-001 |
| 版本 | 0.1.2 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation — all cards Pending** |
| 输入 | [spec.md](./spec.md) · [plan.md](./plan.md) · [task.md](./task.md) · [checklist.md](./checklist.md) |

---

## 1. 入口Gate

- [ ] IMPL-MERCH-ENTRY-001：O-MERCH-01~12、Catalog依赖和PAR-CMI已批准/Frozen；各自六件套内部版本/状态/基线一致，PAR 已记录批准版本。
- [ ] IMPL-MERCH-ENTRY-002：六件套、产品基础设计、points/order/refund现状已完整阅读。
- [ ] IMPL-MERCH-ENTRY-003：Freeze base `D`、docs-only `S`、v0.1.1 docs-only amendment `A_CMI`（父 `S`）、通知delta和shared hotspots已记录，`S^=D`、`A_CMI^=S`。
- [ ] IMPL-MERCH-ENTRY-004：Foundation schema tip `F0` 包含 spec 5 全部 models/constraints 并通过 F0 schema Gate；共同基线 `F`（可等于 `B_CAT`）通过全量 Gate，且 `S→A_CMI→F0→B_CAT→F` 各 ancestor 命令为 exit 0。
- [ ] IMPL-MERCH-ENTRY-005：活动卡worktree/DB/ports/owner唯一。
- [ ] IMPL-MERCH-ENTRY-006：Point测试只使用专用fixture账户/DB，无生产余额。
- [ ] IMPL-MERCH-ENTRY-007：Merch lane 未持有宿主/Store/products/schema/migration 文件锁；CMI 卡另已记录 `H/M_CMI` 与整文件移交。
- [ ] IMPL-MERCH-ENTRY-008：Asset卡已完整读取api-image SKILL；未读取/打印secret。
- [ ] IMPL-MERCH-ENTRY-009：没有法币/第三方支付/真实推广授权。
- [ ] IMPL-MERCH-ENTRY-010：当前卡Owned/Must Not Touch/DoD/rollback已复制。

任一失败不得实施。

---

## 2. Worktree/DB/端口

使用PAR-CMI：

- Merch BE：`monexus-merchandising-backend`、DB `monexus_test_merch_be`、3123；
- Merch FE/Assets：`monexus-merchandising-frontend`、DB `monexus_test_merch_fe`、3124/5194；
- Cross integration：`monexus-catalog-merch-integration`、DB `monexus_test_catalog_merch_integration`、3126/5196。

Merch BE/FE/Assets 必须从共同基线 `F` 分叉；`S/A_CMI/F0/B_CAT` 必须是 `F` 祖先；Merch 不参与 `B_CAT`。Cross integration 只能从 `M_CMI` 开始，且 `F`、Catalog/Merch lane tips、host release `H` 均须为其祖先。禁止使用默认DB、通知DB/ports、真实Xboard/账户。Playwright reuse=false/strictPort。只清理活动卡PID/临时目录。

---

## 3. Ownership

### Merch BE可写

- `server/src/modules/merchandising/**`
- 本卡明确锁定的points helper最小区域
- 专用tests/scripts

### Merch FE/Asset可写

- `src/components/merchandising/**`
- `src/api/merchandising.ts`、`src/types/merchandising.ts`
- 独立页面/测试与design concept目录

### CMI Integration Owner独占

- `server/src/modules/products/**`
- `src/pages/StorePage.tsx`
- `src/pages/AdminPage.tsx`、`src/pages/MerchantDashboardPage.tsx`（仅 `H` 后接收整文件锁，不存在 mount 区域锁）
- cron/main最小接线

T-CAT-INT-001 与 T-MERCH-INT-001 必须由该同一 Owner/Worktree 串行完成。

### isHot 跨规格唯一 Owner

- `server/src/modules/merchant/schema.ts`、`service.ts` 的 isHot 拒写：Catalog Backend Owner；
- `src/pages/merchant/ProductCreateWizard.tsx`、`src/components/merchant/MerchantProductFormModal.tsx` 的 toggle/payload 删除：Catalog Frontend Owner；
- `server/src/modules/products/**` 的 legacy sort/cursor/public DTO 删除：CMI Integration Owner；
- Merch Agent 只交付 T-MERCH-X-001 contract fixture/test，不编辑上述共享文件。

### F0 Foundation schema 独占（Foundation Owner）

- schema/migrations/shared contract定义，包括 Run terminal fields/status checks/single-running/run-timeout config、run-snapshot FK、Campaign/PointLog/adjustment关系、Campaign create/adjustment 的 idempotency key+canonical payload hash/checks/唯一约束与 scheduled/active/paused partial unique

Merch 不参与 `B_CAT`；Merch schema 仍 `F0` 落地；Merch 只消费最终共同基线 `F`。
### 禁止

- notification worktree/files、Layout/appStore/auth middleware；
- Order/Settlement状态机/退款库存；
- production env/DB/point account；
- Image provider root配置文件写入；
- provider SDK/runtime image调用。

---

## 4. 三色权限

**Green**：Owned模块、专用真实PG/fixture、unit/component/E2E、脱敏metrics/log、证据。

**Yellow**：D/MERCH/REQ/AC、销量口径、积分扣退、套餐承诺、disclosure/禁词、schema delta、新依赖、宿主/shared file、真实asset reference、rebase语义冲突。

**Red**：真实扣款/推广、法币词或接口、重复/手工改PointLog、隐藏推广标识、恢复legacy isHot、把AI废稿上线、commit secret、破坏性Git/他人资源。

---

## 5. Implement cards

| 卡 | Task | 状态 | Gate |
| --- | --- | --- | --- |
| I-MERCH-001 | T-MERCH-DOC-001 + T-FND-001（F0）review | Pending | Frozen `S`/`A_CMI`；`S→A_CMI→F0→B_CAT→F` ancestry |
| I-MERCH-002 | T-MERCH-BE-001 ranking lifecycle | Pending | lock/run/fallback tests |
| I-MERCH-003 | T-MERCH-BE-002 compute/projection | Pending | window/rank/cursor fixtures |
| I-MERCH-004 | T-MERCH-X-001 isHot contract | Pending | shared-owner handoff fixture |
| I-MERCH-005 | T-MERCH-BE-003 packages/campaign | Pending | status/auth/snapshot/create-idempotency tests |
| I-MERCH-006 | T-MERCH-BE-004 billing/lifecycle/public | Pending | real-PG charge/refund/adjustment-idempotency/concurrency |
| I-MERCH-007 | T-MERCH-BE-005 editorial/entitlement | Pending | identity/expiry tests |
| I-MERCH-008 | T-MERCH-FE-001 badge/shelves | Pending | component/a11y/disclosure |
| I-MERCH-009 | T-MERCH-FE-002、T-MERCH-FE-003 merchant/admin | Pending | UI state/E2E contracts |
| I-MERCH-010 | T-MERCH-INT-001 | Pending | `M_CMI` + `H` + whole-file host handoff |
| I-MERCH-011 | T-MERCH-ASSET-001 | Pending | Image2 metadata/review/runtime asset |
| I-MERCH-012 | T-MERCH-QA-001 | Pending | ranking/performance |
| I-MERCH-013 | T-MERCH-QA-002 | Pending | points/security/concurrency |
| I-MERCH-014 | T-MERCH-QA-003 | Pending | browser/assets/regression/release |

I-MERCH-002、005、008、009、011可在 `F` 后并行；I-MERCH-010 与 Catalog I-CAT-012 由同一 CMI Owner 串行，是唯一共享集成点；QA-012/013可并行，014最后。

活动卡模板沿用Catalog格式，额外记录：

~~~text
Ranking run/config fixture:
Point account fixture IDs (not balances/secrets in logs):
Campaign clock:
Asset model/size/hash/review (asset card only):
Shared integration handoff commits:
Frozen D/S/F ancestry evidence:
Catalog host release H / M_CMI / whole-file lock owner:
~~~

---

## 6. 专项纪律

### 6.1 Ranking

- 使用数据库时间和半开区间；
- SQL/spy证明不读isHot/sales；
- completed切换与snapshot写入原子；
- running 使用短事务持久化；失败用独立事务收尾，硬退出 stale running 按 DB 时间回收；
- advisory lock和失败恢复用两个独立Node/PG连接测试；
- cursor固定run，不能在客户端偷偷改页。

### 6.2 Points

- 条件debit与Campaign/PointLog/AdminLog同transaction；
- 每个测试前后断言balance、point logs、campaign fields；
- retry/approve/cancel/refund使用状态CAS和真实并发；
- create/adjustment 共享 Spec §11 canonicalizer，冻结 SHA-256 向量必须逐字节通过；
- 测试输出不得打印完整余额历史/用户email；
- 不修改Order point ledger理由/语义。

### 6.3 Disclosure/identity

- sponsored文字在DOM可见，不能仅aria/tooltip；
- partner tooltip固定不担保；
- repo禁词扫描：平台认证/官方认证/平台担保/质量保证（合法规格引用可allowlist）；
- unknown code隐藏，不回退“认证”。

### 6.4 Image2

Asset卡调用示意（实施时从SKILL路径运行，命令不得含key）：

~~~bash
python /root/.codex/skills/api-image/scripts/generate_image.py \
  --model gpt-image-2 \
  --prompt-file <approved-prompt-file> \
  --image <project-brand-reference> \
  --image-role "project color and card style reference" \
  --size 2048x2048 \
  --quality high \
  --background opaque \
  --n 1 \
  --out <concept-output>
~~~

- 运行前读取当前Codex root config/auth，只传给脚本，不打印；
- 任何输入图都标role；
- 检查输出再保存review；
- gpt-image-2不请求transparent/input-fidelity；
- runtime文本不用AI栅格文字；
- 产物未review不得进public。

---

## 7. 验证命令

目标脚本由QA卡创建；不存在不能skip。

~~~bash
npm run check:runtime
npm run build
cd server && npm run build

bash scripts/verify-merchandising-ranking.sh
bash scripts/verify-merchandising-points.sh
npx playwright test --config playwright.merchandising.config.ts e2e/merchandising-*.spec.ts
bash scripts/verify-merchandising-assets.sh
bash scripts/verify-merchandising.sh
git diff --check
~~~

回归至少：points、orders/refund、admin settlements/query、products list/cache/cursor/public fields、merchant create/update、Catalog suite、notification build/tests。

---

## 8. Evidence

| 时间 | HEAD/F0/B_CAT/F | I/T | REQ/AC/CHK | 命令 | 结果 | Artifact |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-08-15 | `c690025` / `70517f7` / `8c2800e` / `8c2800e` | C5b | `CHK-MERCH-FINAL-001/004`; merch integration | `DATABASE_URL=<CMI> bash scripts/verify-catalog-ops-backend.sh` | PASS, 7/7 gates; build and catalog/merch suite; CMI DB/log cleanup passed | Backend runner output |
| 2026-08-15 | `c690025` / `70517f7` / `8c2800e` / `8c2800e` | C5b | Server-wide regression | `TEST_DATABASE_URL=<CMI> DATABASE_URL=<CMI> REDIS_ENABLED=false REDIS_REQUIRED=false API_RATE_LIMIT_MAX=3000 npm test` (Node 20) | PASS, 154 files / 1420 tests; exit 0; Vitest 3185.36s (wall 3187.90s); CMI DB dropped afterward | `/tmp/cmi-server-full-final.log` (private runner log) |
| 2026-08-15 | `c690025` / `70517f7` / `8c2800e` / `8c2800e` | C5b | `AC-MERCH-016~020/023~024/028~029` | `bash scripts/verify-catalog-ops-e2e.sh` | PASS, merchandising smoke 3/3 inside full 30/30 run; disclosure, no organic double-count, active timeline | Catalog-ops Playwright runner |
| 2026-08-15 | `c690025` / `70517f7` / `8c2800e` / `8c2800e` | C5b | Root/frontend regression | `npm test` | PASS on immediate full rerun, 49 files / 450 tests | Vitest stdout |
| 2026-08-15 | `c690025` / `70517f7` / `8c2800e` / `8c2800e` | C5b | `CHK-MERCH-PAR-001` | PAR ancestor/ownership audit | Catalog/Merch lane tips and `H→M_CMI` exit 0; the pre-closure Identity probe was exit 1 and is superseded by the closure row below | SHA matrix: `docs/specs/cmi-c5b-evidence.md` |
| 2026-08-15 | `c690025` / `70517f7` / `8c2800e` / `8c2800e` | C5b | `PAR-GATE-006/011` | `git merge-base --is-ancestor f586efd dc9fb306`; `git merge-base --is-ancestor 2bf77c1 dc9fb306`; `git merge-base --is-ancestor dc9fb306 50b774c`; `git merge-base --is-ancestor 50b774c 0d9f7ce` | PASS, all four exit 0; Identity raw-writer closure `0d9f7ce` is parented by Layout handoff `50b774c`; Identity logic 56/56 and build green | `docs/specs/cmi-c5b-evidence.md`; Identity lane `fix/identity-profile-layout-integration` |
| 2026-08-15 | `c690025` / `70517f7` / `8c2800e` / `8c2800e` | C5b | `PAR-GATE-011` | `git merge-base --is-ancestor 0d9f7ce 560d00c` | PASS (exit 0); Identity docs-only evidence handoff `560d00c` retains the raw-writer closure parent | Identity lane `fix/identity-profile-layout-integration`; `docs/specs/cmi-c5b-evidence.md` |
| 2026-08-15 | `c690025` / `685d23b` / `495d1a0` / `e279c72` / `70517f7` / `8c2800e` / `8c2800e` | C5b | `G-MERCH-PR-004/005/006` | `PATH=/root/.nvm/versions/node/v20.19.5/bin:$PATH bash scripts/verify-merchandising.sh` | PASS for build/contracts and ranking/points/asset regression: ranking 2 files/55, points 4 server files/56 + 3 UI files/91, asset gallery 3/3; Image2 delivery remains Deferred | `docs/specs/cmi-c5b-evidence.md`; dedicated runners `685d23b`, `495d1a0`, `e279c72` |
| 2026-08-15 | `ae4c483` (docs-only; code ancestor `c690025`) | C5b | `G-MERCH-PR-007/008` | Root security/public-field suite (8 files/117 tests, exit 0); server split security runs (pure 3 files/33 tests, 45.26s; DB-backed 5 files/53 tests, each exit 0); `docs/specs/cmi-qa-evidence-map.md` refresh | Partial evidence recorded; public/DTO/ownership rows are indexed, but merch admin MFA, log/trace redaction, metrics/cron and other audit gaps remain; G-MERCH-PR-007/008 stay Pending | `docs/specs/cmi-c5b-evidence.md`; `docs/specs/cmi-qa-evidence-map.md` |
| 2026-08-15 | `b078153` (docs-only; code ancestor `c690025`) | C5b | `CHK-MERCH-FND-002` / `G-MERCH-PR-003` | Production-source `isHot` scan; serial Node 20 CMI runs for `admin-query` (17), admin/merchant `product-is-hot` (7+6), ranking projection (30), products integration (5) | Static scan PASS; five serial files 65/65 tests exit 0 and each CMI DB cleaned. Independent true-count→false-count cleanup fixture/artifact still missing, so both remain Pending; initial concurrent batch's `40P01` deadlock is excluded | `docs/specs/cmi-c5b-evidence.md`; CMI dbguard cleanup |

证据含exit/test count/duration/DB/ports/clock/fixture revision；ranking报告含行数、窗口、P50/P95；points含净变化断言但不泄露真实余额；assets含prompt/model/hash/reviewer，不含provider secret。

---

## 9. PR Gates

| Gate | 要求 | 状态 |
| --- | --- | --- |
| G-MERCH-PR-001 | Specs/PAR Frozen、P0 Tasks/CHK全Done | Pending |
| G-MERCH-PR-002 | `D/S/A_CMI/F0/B_CAT/F/H/M_CMI`、ancestor命令、delta与host整文件锁移交完整 | Pending |
| G-MERCH-PR-003 | migrations/status/drift与legacy isHot cleanup通过 | Pending |
| G-MERCH-PR-004 | backend/frontend build及contracts通过 | Passed |
| G-MERCH-PR-005 | ranking/points真实PG、100并发及Campaign create/adjustment幂等契约通过 | Passed |
| G-MERCH-PR-006 | browser/disclosure/a11y/visual/assets通过 | Pending |
| G-MERCH-PR-007 | AC-MERCH-001~029当前HEAD证据齐全 | Pending |
| G-MERCH-PR-008 | points/PII/secret/禁词/public field审计通过 | Pending |
| G-MERCH-PR-009 | 性能/bundle/cache/rollout/rollback通过 | Pending |
| G-MERCH-PR-010 | points/orders/products/admin/notification回归与PR交接完整 | Pending |

---

### C5b 状态（2026-08-15）

Merch browser/backend, server-wide, and Identity closure evidence are green. The
cross-spec `N + C_ID → M_ID → Layout → raw-writer closure` chain is proven by
the ancestor matrix in `docs/specs/cmi-c5b-evidence.md`. Merch PR gates remain
Pending until Owner review and the remaining release/performance/PR evidence are
recorded; this branch is not yet declared ready to merge.

## 10. Blocked模板

~~~text
Blocked card:
HEAD/F0/B_CAT/F:
Exact evidence:
Frozen decision / money semantics affected:
Shared file owner:
Safe alternatives:
Recommended choice:
Data/points/customer disclosure impact:
Work safely completed:
~~~

---

## 11. 完成交接

~~~text
Outcome / branch / HEAD / Foundation（F0/B_CAT/F）:
Spec version / tasks / commits:
Ranking run/retention/performance:
Promotion point charge/refund result:
Disclosure/identity/禁词 result:
Image2 concepts and approved runtime assets:
Security/public projection:
Regression/rollout/rollback:
Known limitations (no fiat/CPM/CPC):
PR Gate status / CMI Integration Owner:
~~~

### 修订记录

| 版本 | 日期 | 状态 | 说明 |
| --- | --- | --- | --- |
| 0.1.0 | 2026-08-09 | Frozen for Implementation | Owner 批准：自然热卖、积分推广、精选/自营/合作权益、Image2 资产治理 |
| 0.1.1 | 2026-08-09 | Frozen for Implementation | Owner 批准唯一修订：CMI Foundation DAG 改为 S→A_CMI→F0→B_CAT→F；Merch 只消费最终 F、不参与 B_CAT；I-MERCH-001 引用 F0 schema tip |
| 0.1.2 | 2026-08-13 | Frozen for Implementation | Owner 批准 QA 收口修订（AMD-CMI-012）：证据规则对齐 testing-policy；QA 卡收敛；T-MERCH-ASSET-001 拆出本次交付 |
