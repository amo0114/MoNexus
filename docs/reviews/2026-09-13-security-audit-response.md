# 生产安全审计回应与修复（2026-09-13）

对应审计报告：订单关闭未回滚资源（高）、配置项无上限 / 存储凭证密钥未配置（中）、
公开 registry / 下载错误文案 / JWT 文案 / 图片多态文件（低）。

代码基线：`origin/master 789042f`（`server/src` 与本分支起点逐字节一致，已核对）。
每项都先写失败用例再修（TDD），复现用例见下表「回归」列。

## 高危：订单关闭未回滚资源 —— 结论：**不成立**，属语义误读

审计把 `POST /api/orders/:id/close` 理解为「取消订单」。产品语义相反：

- 前端按钮文案是「验收通过 / 结束订单」，确认框写明「确认后订单关闭并结算给商家」（`OrderDetailModal.tsx`）；
- PRD §4.3.1 与 `orders/cron.ts`：`delivered` 超 `autoCloseDays` 未确认 → 自动 `closed` + 正式扣款 + 结算。
- `closeOrder` → `settleHeldOrder` → `consumeHeldPoints`：只减 `frozenBalance`，**不动 `balance`**，写入 `type: 'out'` 流水，结算 `holding → pending`。

按报告步骤（限量人工服务、冻结 100、商家交付、买家关闭、管理员批量结算）实测账目：

| 步骤 | 买家可用 | 买家冻结 | 结算状态 | 规格库存 |
|---|---|---|---|---|
| 初始 | 1000 | 0 | — | 3 |
| 下单 | 900 | 100 | holding | 2 |
| 商家交付 | 900 | 100 | holding | 2 |
| 买家关闭（验收） | **900** | 0 | pending | 2 |
| 管理员批量结算 | 900 | 0 | settled | 2 |

商家 +90、平台佣金 10、买家 −100，守恒。**没有 100 积分退回买家**；`PointLog` 只有 `hold` 与 `out` 两行，没有 `refund`/`release`。
「结算拦截只判 refunded」正确——`closed` 本来就是可结算态（`getSettlementEligibility`）。
「库存应回补」不成立——服务已交付，名额已消耗；只有商家拒单（未交付）才回补（`applyRefundInventoryPolicy`）。

报告中「反复下单并关闭即可耗尽库存」在此语义下等于「反复购买并验收」，每次都实付 100 积分。

**回归**：`server/src/__tests__/order-close-ledger-conservation.test.ts`（两条用例：验收链守恒；拒单链退款 + voided + restock）。任何把 close 改成退款的改动都会让它失败。

## 中危 1：配置项无上限校验 —— 已修

- `lib/systemConfig.ts`：所有 45 个键进入同一张 `RANGE_CONFIG_KEYS` 表（布尔开关固定 0..1）；新增编译期断言，漏配上限的键直接 `tsc` 失败。
- 奖励类（`registerReward`/`checkinReward`/`inviteReward`）上限 `MAX_REWARD_POINTS = 1_000_000`；门槛/密码确认阈值上限 = 积分硬顶 2e9；分页 ≤ 500；Refresh Token ≤ 365 天；下载窗口 ≤ 365 天；低库存阈值 ≤ 1e6。原先散落在 `updateSystemConfig` 里的 8 段 if 全部并入表。
- `GET /admin/config` 新增 `min`/`max` 字段；前端 `AdminConfigPanel` 优先使用服务端区间（旧后端回退本地 meta）。

**回归**：`system-config.test.ts` 新增 3 条（999999999 被拒且旧值保留；每个键都拒绝 INT_MAX；列表下发 min/max）。

## 中危 2：存储凭证加密密钥未配置 —— 已修（部署链路根因）

根因：`docker-compose.prod.yml` 从未透传 `STORAGE_CREDENTIALS_ENC_KEY*`，`.env` 里配了也到不了容器。
服务端写路径本就在生产 fail-closed（`assertUiWritable` → 403），报告推测的「明文存储」不会发生，但状态接口没把原因说清。

- Compose：透传 `STORAGE_CREDENTIALS_ENC_KEY`（必填）、`_VERSION`、`_PREVIOUS`、`_PREVIOUS_VERSION`、`STORAGE_UI_CONFIG_ENABLED`、`STORAGE_CONFIG_SOURCE`、`STORAGE_ENDPOINT_ALLOWLIST`。
- `scripts/check-prod-env.sh`：新增 `require_hex_32`，同时校验 `WEBHOOK_SECRET_ENC_KEY` 与 `STORAGE_CREDENTIALS_ENC_KEY`（格式 + 生产必填 + PREVIOUS 配对）。
- `/admin/storage/status` 新增 `credentialsEncKeyDetail` 与 `runtime.uiWriteBlocked`；前端存储面板在密钥缺失时给出红色告警与设置指引。
- `.env.example` / `.env.staging.example` / `docs/ops-runbook.md` 补齐说明。

**运维动作**：生产 `.env` 增加 `STORAGE_CREDENTIALS_ENC_KEY=$(openssl rand -hex 32)` 后重新 `compose up`。当前生产用环境变量配置存储，该密钥只影响控制台写路径，无存量密文需迁移。

**回归**：`config-production-guards.test.ts`（Compose/preflight 文本断言）、`storage-provider-admin.test.ts`（生产缺密钥 → 状态诊断 + 写入 403 且零落库）。

## 低危 1：`/api/config/registry` 匿名可读 —— 保持现状，说明理由

内容：分类/交付模式/状态枚举的中文标签与色调、会员等级门槛、分页与低库存阈值、两个通知能力开关。
全部是公开商店页（未登录可浏览商品）渲染所需，且商品公开接口本身已暴露分类与交付模式。开关只反映站点是否启用站内通知，不是安全边界。加鉴权会让匿名商店页失去标签。未改动。

## 低危 2：下载接口统一「订单不存在」—— 已修（不削弱防枚举）

`orders/fileAccess.ts`：归属**已确认**（买家本人 / 本单商家 / 管理员）但无文件交付 → 仍 404/`NOT_FOUND`，文案改为「该订单没有可下载的交付文件」。
陌生人与不存在订单仍返回逐字节相同的「订单不存在」，不构成新的存在性探针。

**回归**：`file-delivery-chain.test.ts` 更新用例同时断言两种文案。

## 低危 3：JWT 失败统一「Token 已过期」—— 已修

`middlewares/auth.ts`：`TokenExpiredError` → 「Token 已过期，请重新登录」；篡改/格式错误/密钥不符 → 「登录凭证无效，请重新登录」。
状态码与 `UNAUTHENTICATED` 错误码不变（前端刷新逻辑只看 401）。

**回归**：`auth-jwt-errors.test.ts`。

## 低危 4：图片多态文件（合法头 + 脚本）—— 已修

新增 `lib/imageStructure.ts`：按 PNG（chunk + CRC 到 IEND）/ JPEG（segment + 熵编码段到 EOI）/ GIF（block 到 trailer）/ WebP（RIFF 大小 + chunk 链）走到容器终点，要求文件**恰好**在那里结束。不解码像素、不引入原生依赖。
`uploads/routes.ts` 在 magic-bytes 校验后调用它，尾随字节或截断文件返回 400 `UNSUPPORTED_MEDIA_TYPE`。

附带发现并修正：三处测试共用的 67 字节 `TINY_PNG` 夹具本身 IDAT 长度字段错误（结构上不是合法 PNG），已替换为 Pillow 生成的 70 字节合法夹具（`uploads.test.ts`、`storage-provider-admin.test.ts`）。e2e 里的 base64 PNG 经校验合法，未动。

**回归**：`image-structure.test.ts`（7 种夹具 × 合法/尾随/截断 + 4 条畸形用例）、`uploads.test.ts` 新增 2 条。

## 验证

- `server`：`tsc --noEmit` 通过；全量 vitest 通过（首轮 EXIT=0），触及的 9 个文件 157 条通过。
- 前端：`tsc -b` 通过；`vitest run` 1093/1097 通过，4 条失败集中在 `AdminPage.phase*/products` 四个文件，均为 `STACK_TRACE_ERROR` 超时，单独运行 24/24 通过，与本次改动无关（本次未触碰 AdminPage）。
- `bash scripts/check-prod-env.sh` 对缺失/畸形/占位符三种密钥输入分别给出 ERROR/ERROR/WARN（已实测）。
