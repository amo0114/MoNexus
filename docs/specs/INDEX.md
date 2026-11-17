# 规格索引（存量文档分类）

> 建立于 2026-11-17（基线 `origin/develop@3b6f1e0`），归属：工程规范治理（[`docs/agent-workflow.md`](../agent-workflow.md) §2）。
> 本索引**只登记、不改写**存量文档：所有文档原位保留，正文未改动。新需求用 `openspec/changes/` 管理。

## 分类规则

| 结论 | 含义 | 判定依据（仅限可核对证据，不凭模型判断） |
|---|---|---|
| `CURRENT` | 当前有效，可作为实施依据 | 被代码 / 测试 / CI 脚本直接读取，或是仓库现行流程文档 |
| `HISTORICAL` | 仅作背景，不得据此实施 | 位于目录 README 已声明为归档的目录 |
| `NEEDS_REVIEW` | 待核实（不是历史文档） | 其余全部。"自述状态"只摘录文档自己写的状态，可能已过时 |

- `NEEDS_REVIEW` 不等于废弃：改动涉及该能力时必须阅读并对照代码核实；不得以此为由删除、移动或忽略文档中的约束；冲突交 Owner 决定。业务硬约束一律以 [`AGENTS.md`](../../AGENTS.md) 为准。
- 能力首次整理进 `openspec/specs/<capability>/` 时，按 [`agent-workflow.md`](../agent-workflow.md) §2 的"基线 change"流程执行，并在文末"去向登记"中**按章节**写明被取代的范围；未登记的章节保持原分类。
- 下表"佐证"中的合并记录来自 `git log origin/develop --merges`，只证明有相关代码合入，不证明文档与实现一致。

## CURRENT

| 文档 | 佐证 |
|---|---|
| [`docs/testing-policy.md`](../testing-policy.md)、[`docs/branching-and-ci.md`](../branching-and-ci.md) | 现行流程文档，被 `AGENTS.md` 引用 |
| `server/src/modules/*/README.md`（14 个） | 模块契约，随代码维护 |
| [`docs/superpowers/specs/monexus-api-openapi.json`](../superpowers/specs/monexus-api-openapi.json) | `scripts/check-architecture.mjs` 读取（CI architecture job） |
| [`docs/api/governance-v1/`](../api/governance-v1/) | 前端 `src/test/governanceFixtures.ts` 等与 `server/src/__tests__/governance-v1.test.ts` 读取 |

## 进行中或状态需确认的任务规格（NEEDS_REVIEW，优先确认）

本轮工作**不改变**以下任务的范围、契约或实施责任。

| 文档 | 自述状态 | 佐证 / 冲突 |
|---|---|---|
| [`docs/implementation/2026-11-12-backend-governance-implementation-plan.md`](../implementation/2026-11-12-backend-governance-implementation-plan.md)（含 `.docx`）、[`backend-governance-v1.frontend-handoff.md`](backend-governance-v1.frontend-handoff.md)、[`docs/verification/backend-governance-v1/`](../verification/backend-governance-v1/)、[`docs/operations/backend-governance-v1.md`](../operations/backend-governance-v1.md) | "方案已批准，后端实施与验证中"；责任：后端 Codex 主代理，前端另行指定 | #349、#350 已合入 develop，release #351（26411cc）已合入；自述状态未更新 |
| [`docs/implementation/2026-11-10-commerce-accounting-settlement-closure-plan.md`](../implementation/2026-11-10-commerce-accounting-settlement-closure-plan.md) | "评审稿 v1.0" | #342 已合入 develop |
| [`recharge-payment-platform-v1.md`](recharge-payment-platform-v1.md)、[`.plan.md`](recharge-payment-platform-v1.plan.md) | "Ready for implementation" | 规格 2026-11-13 仍有修改 |
| [`runtime-settings-phase2.md`](runtime-settings-phase2.md) | "2A/2B/2C 已实现…尚未部署" | #357 已合入 develop |
| [`product-guest-visibility-ai-moderation.md`](product-guest-visibility-ai-moderation.md) | "修订设计，尚未实施" | — |
| [`order-notification-system/`](order-notification-system/) | `2026-10-03-r1-r2-release-preparation.md`："implementation-started" | — |
| [`points-value-policy-phase-1.md`](points-value-policy-phase-1.md)（含 `.docx`）、[`points-real-value-alignment.md`](points-real-value-alignment.md)（含 `.docx`）、[`value-policy-activation-controls.md`](value-policy-activation-controls.md)、[`value-policy-d02-backtest.md`](value-policy-d02-backtest.md) | "Implemented — Production Activation Blocked by D-02/D-03" | 决策记录见 `docs/operations/value-policy-*` |
| [`pr130-review-remediation.plan.md`](pr130-review-remediation.plan.md) / [`-report.md`](pr130-review-remediation-report.md) | 计划"待实施"；报告"实施完成，待审核" | 两份自述互相不一致 |

## docs/specs 其余文档（NEEDS_REVIEW）

| 主题 | 文档 | 自述状态 |
|---|---|---|
| 商品模型与结账 | [`product-model-and-checkout.md`](product-model-and-checkout.md) | "已确认方向，分阶段实施；本文档是各阶段的唯一真相来源" |
| 商品内容/发布/交付 v2 | [`product-commerce-v2/`](product-commerce-v2/)（spec、plan、ui-redesign.plan、templates.json、ui-preview.html） | 无 |
| 用户留存 v1 | [`user-engagement-v1.md`](user-engagement-v1.md)、[`.plan.md`](user-engagement-v1.plan.md) | 无（#334、#336 已合入） |
| 注册开关与邮件 | [`registration-gate-and-mail-operations.md`](registration-gate-and-mail-operations.md)、[`.plan.md`](registration-gate-and-mail-operations.plan.md) | 2026-11-13 扩展说明 |
| catalog/products 解耦 | [`catalog-products-decoupling.plan.md`](catalog-products-decoupling.plan.md) | 无 |
| AI | [`ai-foundation.md`](ai-foundation.md)、[`.plan.md`](ai-foundation.plan.md)、[`ai-product-content-copilot.md`](ai-product-content-copilot.md)、[`.plan.md`](ai-product-content-copilot.plan.md)、[`ai-product-draft-assistant.md`](ai-product-draft-assistant.md) | 无 |
| 商家经营 Agent | [`merchant-operations-agent-v1.md`](merchant-operations-agent-v1.md)、[`.plan.md`](merchant-operations-agent-v1.plan.md)、[`-verification.md`](merchant-operations-agent-v1-verification.md) | 无 |
| 商家工作台 | [`merchant-workbench-v1.md`](merchant-workbench-v1.md)、[`.plan.md`](merchant-workbench-v1.plan.md)、`merchant-workbench-pr{1,2,3}-verification.md` | plan："已实现，本地单测/构建/浏览器冒烟通过" |
| 商家店铺页 | [`merchant-storefront.plan.md`](merchant-storefront.plan.md)、[`assets/`](assets/) | 无 |
| 推荐 | [`product-detail-recommendations.plan.md`](product-detail-recommendations.plan.md)、[`public-product-availability-and-recommendation-quality.plan.md`](public-product-availability-and-recommendation-quality.plan.md)、[`recommendation-events.plan.md`](recommendation-events.plan.md)、[`recommendation-local-quality.plan.md`](recommendation-local-quality.plan.md) | 无 |
| 商品视频 | [`product-showcase-video.md`](product-showcase-video.md)、[`product-video-processing.md`](product-video-processing.md) | showcase："已在独立 worktree 完成本地实现…" |
| 交付揭示 / 团队特权商品 | [`delivery-reveal.plan.md`](delivery-reveal.plan.md)、[`team-privilege-goods.plan.md`](team-privilege-goods.plan.md) | 无 |
| 性能与 QQ/Xboard | [`2026-10-25-performance-and-qq-xboard/`](2026-10-25-performance-and-qq-xboard/) | README："P1/P2、B0–B4 已实现…" |
| 积分排行榜 | [`points-leaderboard.md`](points-leaderboard.md)、[`.plan.md`](points-leaderboard.plan.md) | 无 |
| 邀请码 | [`invite-code-normalization.md`](invite-code-normalization.md)、[`.plan.md`](invite-code-normalization.plan.md) | 无 |
| 法律页面 | [`legal-pages-and-consent.md`](legal-pages-and-consent.md) | 无 |
| 对象存储控制台 | [`object-storage-provider-console.md`](object-storage-provider-console.md)、[`.plan.md`](object-storage-provider-console.plan.md) | 无 |
| 移动端打磨 | [`mobile-ui-polish.md`](mobile-ui-polish.md) | "T1–T7 已实施并验收" |
| CMI QA 收尾材料 | `cmi-c5a-verdicts.md`、`cmi-c5b-evidence.md`、`cmi-c6-pr-description.md`、`cmi-owner-handoff.md`、`cmi-perf-compat-evidence.md`、`cmi-qa-closeout.plan.md`、`cmi-qa-evidence-map.md`、`cmi-release-rehearsal.md` | rehearsal："PASS for the staging-only rehearsal" |

## docs/superpowers/specs（NEEDS_REVIEW）

均为早期 Spec-Driven 套件（README/spec/plan/task/implement/checklist），自述状态多为 "Frozen for Implementation"，冻结状态不代表实施已完成或仍然有效。

| 文档 | 自述状态 |
|---|---|
| `2026-04-30-monexus-product-prd.md` | "Living — 实施进度快照已纳入" |
| `2026-04-27-postgresql-auth-security-design.md`、`2026-04-29-monexus-merchant-settlement-contract.md`、`2026-07-24-portable-backup-restore-design.md` | 无 |
| `2026-06-11-delivery-methods-design.md`、`2026-06-12-product-reviews-design.md` | "已评审通过" |
| `2026-07-23-m3-order-lifecycle-closure/` | spec："Draft for Implementation"；plan："Ready" |
| `2026-07-27-m3-identity-security-hardening/` | implement："I-00 至 I-05 Done (local)；I-06 In Progress" |
| `2026-08-01-registration-abuse-prevention/` | "Feature implementation, full CI and isolated staging rehearsal complete…" |
| `2026-08-05-transactional-email-templates/` | README："本地完成；待 PR → develop" |
| `2026-08-09-catalog-merch-identity-parallel-contract.md`、`2026-08-09-catalog-operations/`、`2026-08-09-identity-profile-sync/`、`2026-08-09-merchandising-governance/`、`2026-08-13-cmi-qa-rescope-v012.md`、`2026-08-16-catalog-merch-user-centered-ux/`、`2026-08-17-admin-platform-product-publication/` | "Frozen for Implementation"（部分 checklist 写"all … Pending"） |
| `2026-08-09-order-notification-realtime/` | "Frozen for Implementation — 本地实施任务完成…" |
| `docs/superpowers/2026-04-28-postgresql-auth-security-review-and-local-manual.md` | 无 |

## HISTORICAL

| 目录 | 声明来源 |
|---|---|
| [`docs/archive/`](../archive/) | `docs/archive/README.md`："kept for archaeology and decision context only" |
| [`docs/superpowers/archive/`](../superpowers/archive/)、[`docs/superpowers/plans/`](../superpowers/plans/)（仅跳转说明） | `docs/superpowers/archive/README.md`："do not implement from them" |

## 其他目录（非规格，不作实施依据）

| 目录 | 性质 |
|---|---|
| `docs/reviews/` | 审查报告与修复记录（时间点结论） |
| `docs/verification/` | 验证证据 |
| `docs/refactoring/` | 重构快照与交付记录 |
| `docs/operations/` | 运维手册与决策记录；部署/运维操作以其中当前手册为准，但仍需 Owner 授权执行 |
| `docs/api/`（governance-v1 以外） | API 说明，`NEEDS_REVIEW` |

## 去向登记

| 存量文档 | 被取代的章节 | OpenSpec 能力 | 基线 change（已归档） | 生效（合入 develop 的提交） |
|---|---|---|---|---|
| [`2026-10-25-performance-and-qq-xboard/performance-plan.md`](2026-10-25-performance-and-qq-xboard/performance-plan.md) | §2.1 中"在页面内容处设置 `Suspense`，fallback 使用页面对应的稳定骨架"一条（该节其余条目不变） | `web-route-loading` | `2026-11-17-baseline-route-loading-states` | 待合入（分支 `fix/route-loading-skeletons`） |
| [`product-commerce-v2/spec.md`](product-commerce-v2/spec.md) | §10.2 表中"首次加载""需要登录"两行（其余各行不变，含"数据请求失败"） | `web-route-loading` | 同上 | 同上 |
