<p align="center">
  <img src="./docs/assets/readme/logo.png" alt="MoNexus 标志" width="88" height="88">
</p>

<h1 align="center">MoNexus</h1>

<p align="center">
  <b>内部积分兑换数字商品的平台。</b><br>
  用户获得并消费站内积分；商家供应卡密、订阅链接与数字服务。
</p>

<p align="center">
  <img alt="Node.js 22" src="https://img.shields.io/badge/Node.js-22-339933?style=flat-square&amp;logo=node.js&amp;logoColor=white">
  <img alt="PostgreSQL 16" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white">
  <img alt="License: Private" src="https://img.shields.io/badge/License-Private-lightgrey?style=flat-square">
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <b>简体中文</b> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#架构概览">架构概览</a> ·
  <a href="#生产部署">生产部署</a>
</p>

<p align="center">
  <img src="./docs/assets/readme/store-desktop.webp" alt="MoNexus 商城桌面端" width="100%">
</p>

<table align="center">
  <tr>
    <td width="70%"><img src="./docs/assets/readme/product-desktop.webp" alt="商品详情页" width="100%"></td>
    <td width="30%"><img src="./docs/assets/readme/store-mobile.webp" alt="商城移动端" width="100%"></td>
  </tr>
</table>

<p align="center"><sub>截图使用本地演示数据，商品名称已替换为中性示例。</sub></p>

## 项目简介

MoNexus 是一个 **内部福利 / 积分激励平台**：平台运营方发放积分，商家供应数字商品，用户消费积分兑换。账本金额全部为系统内整数。

| 角色 | 能力 |
| :--- | :--- |
| **普通用户** | 注册登录、签到邀请、浏览商城、兑换商品、查看订单与评价、在功能开启时充值积分 |
| **商家** | 申请入驻、管理商品与库存、履约发货、查看结算 |
| **管理员** | 审核商家、调整积分、配置奖励、批量结算、审计日志、充值/支付运营 |

> [!NOTE]
> **明确不做的边界：** 提现到法币、实物物流、多租户白标 SaaS、原生 App，仅支持 Web 与移动浏览器响应式。
> 用户法币充值已作为独立模块实现（报价、下单、入账、退款、争议、对账；本地/预发使用 Simulator）。生产默认 `RECHARGE_MODE=disabled`，以 Simulator 或 `sandbox` 启动会被拒绝；Stripe、PayPal、微信支付、支付宝等 live 渠道在缺少凭据和商户资质时保持 disabled。

## 功能特性

<table>
  <tr>
    <th width="33%">🛍️ 用户端</th>
    <th width="33%">🏪 商家端</th>
    <th width="33%">🛡️ 管理端</th>
  </tr>
  <tr>
    <td valign="top">
      <ul>
        <li>邮箱注册 / 登录，HttpOnly Cookie 刷新令牌</li>
        <li>邮箱验证与密码重置</li>
        <li>商城搜索、分类、游标分页</li>
        <li>即时库存卡密、固定内容、手动履约服务</li>
        <li>每日签到、邀请码、积分流水</li>
        <li>订单历史、发货内容复制、商品评价</li>
        <li>可选充值（报价 → 支付 → 入账）</li>
      </ul>
    </td>
    <td valign="top">
      <ul>
        <li>自助入驻 + 管理员审核</li>
        <li>商品增删改、批量导入库存、变更日志</li>
        <li>订单、争议处理、手动发货</li>
        <li>数据看板与分润结算（订单创建时快照抽成）</li>
      </ul>
    </td>
    <td valign="top">
      <ul>
        <li>用户 / 商家 / 商品 / 订单 / 结算总览</li>
        <li>商家审核 / 停用，按商家配置抽成</li>
        <li>手动调积分，完整审计</li>
        <li>充值订单、退款、争议与对账</li>
        <li>运行时配置：奖励、会员等级</li>
        <li>健康检查、Prometheus 指标、Sentry</li>
      </ul>
    </td>
  </tr>
</table>

**平台保障**

- 每次兑换在同一个数据库事务内完成：扣积分、占库存、建订单、发货记录、积分流水与结算。
- 积分、佣金与充值金额全程整数运算。
- 访问不属于自己的资源返回 **404** 而非 403，防止枚举。
- Redis 可选公读缓存（带熔断）；S3 兼容对象存储（本地 MinIO，生产 S3/R2/OSS）。

## 技术栈

<p align="center">
  <img src="https://skillicons.dev/icons?i=react,ts,vite,tailwind,nodejs,express,prisma,postgres,redis,docker,nginx,githubactions,vitest,sentry,prometheus&amp;perline=8" alt="React、TypeScript、Vite、Tailwind CSS、Node.js、Express、Prisma、PostgreSQL、Redis、Docker、nginx、GitHub Actions、Vitest、Sentry、Prometheus">
</p>

| 层级 | 技术 |
| :--- | :--- |
| **前端** | React 18、TypeScript、Vite 6、React Router 6、Zustand、Tailwind CSS、Radix UI、Axios、Sentry |
| **后端** | Node.js 22、Express 4、TypeScript、Zod、Prisma 6、JWT + Cookie 刷新令牌 |
| **数据** | PostgreSQL 16、Redis 7（可选）、MinIO / S3 兼容存储 |
| **运维** | Docker Compose、nginx、GitHub Actions、Vitest、Playwright、pino、prom-client |

运行时约束：Node.js `>=22 <23`，npm `>=10 <11`（见 `.nvmrc`）。

## 架构概览

```mermaid
flowchart TB
  B["浏览器<br/>React + Vite"] -->|"/api（开发代理 · 生产 nginx）"| A["Express API"]
  A --> P[("PostgreSQL")]
  A -.->|可选缓存| R[("Redis")]
  A --> S["对象存储<br/>内存 · S3"]
  A --> M["邮件<br/>SMTP · 控制台"]
  A --> O["指标 · Sentry"]
```

**兑换流程**（全部在同一事务内）：

```mermaid
sequenceDiagram
  autonumber
  participant U as 用户
  participant API as POST /api/orders
  participant DB as PostgreSQL
  U->>API: 兑换（Idempotency-Key、expectedPrice）
  API->>DB: BEGIN
  API->>DB: 校验余额与商品
  API->>DB: 锁定库存条目
  API->>DB: 扣减积分
  API->>DB: 创建订单、发货记录、积分流水、结算
  API->>DB: 更新库存与销量
  API->>DB: COMMIT
  API-->>U: 返回订单与发货内容
```

角色分为 `user`、`merchant`、`admin`；商家资源严格按所有者隔离。

<details>
<summary><b>目录结构</b></summary>

```text
MoNexus/
├── src/            # React 前端（api、components、pages、stores、lib）
├── server/         # Express 后端（prisma 模型与迁移、src/modules、middlewares、lib）
├── e2e/            # Playwright 端到端测试
├── docs/           # PRD、规格、运维、归档
├── scripts/        # dev-up、备份、生产冒烟、verify-local
└── design-system/  # UI 设计令牌与品牌素材
```

后端模块遵循 `routes.ts` → `controller.ts` → service 分层；模块契约见 `server/src/modules/*/README.md`。

</details>

## 快速开始

需要 Node.js 22 与 npm 10、Docker（PostgreSQL / Redis）以及 Git。

```bash
git clone https://github.com/amo0114/MoNexus.git
cd MoNexus

nvm use
npm ci
npm --prefix server ci

# 拉起 Postgres + Redis、执行迁移、后端 :3000 与前端 :5173
bash scripts/dev-up.sh
# bash scripts/dev-up.sh --seed   # 重新写入演示数据
```

| 服务 | 地址 |
| :--- | :--- |
| 前端 | http://localhost:5173 |
| 后端 API | http://localhost:3000 |
| 健康检查 | http://localhost:3000/api/health/live · `/ready` |

停止：在 `dev-up` 终端按 `Ctrl+C`，再执行 `docker stop monexus-db monexus-redis`。

**演示账号**（执行 `npm run db:seed` 或 `dev-up.sh --seed` 后）：

| 角色 | 邮箱 | 密码 |
| :--- | :--- | :--- |
| 管理员 | `admin@moyuan.net` | `admin123` |
| 普通用户 | `test@moyuan.net` | `user123` |
| 商家 | `merchant@moyuan.net` | `merchant123` |

> [!WARNING]
> 以上账号仅供**本地开发**。任何共享部署前必须更换全部默认密钥与口令。

<details>
<summary><b>手动分步启动</b></summary>

```bash
# 1) 基础设施
docker compose up -d postgres redis

# 2) 后端
cd server
cp .env.example .env      # 使用 server 模板，并填写下面的本地配置
# 本地最小配置示例：
#   DATABASE_URL=postgresql://monexus:monexus_dev_2026@localhost:5432/monexus?schema=public
#   JWT_SECRET=local-development-secret-must-be-at-least-32-chars
#   FRONTEND_ORIGIN=http://localhost:5173
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev               # http://localhost:3000

# 3) 前端（新终端，仓库根目录）
npm run dev               # http://localhost:5173
```

如需真实图片上传，可启用 MinIO：`docker compose --profile storage up -d`。未启用时后端使用内存存储适配器，足够本地开发。

</details>

<details>
<summary><b>常用脚本</b></summary>

**仓库根目录**

| 命令 | 说明 |
| :--- | :--- |
| `npm run dev` | 启动 Vite 前端 |
| `npm run build` | 类型检查 + 前端生产构建 |
| `npm run e2e` | Playwright 端到端测试 |
| `npm run verify:local` | 本地全量门禁（库、单测、可选 E2E） |
| `npm run verify:local:no-e2e` | 同上，跳过 Playwright |
| `npm run prod:env` | 校验生产 `.env` |
| `npm run prod:gate` | 环境 + compose + 构建 + 启动 + 冒烟 |
| `npm run prod:smoke` | 生产冒烟检查 |
| `npm run backup:restore-check` | 校验数据库恢复到可丢弃目标库 |

**后端 `server/`**

| 命令 | 说明 |
| :--- | :--- |
| `npm run dev` | Express 热重载（`tsx watch`） |
| `npm run build` / `npm start` | 编译 TS 并运行 `dist` |
| `npm run db:migrate` | Prisma 开发迁移 |
| `npm run db:migrate:deploy` | Prisma 部署迁移 |
| `npm run db:seed` | 写入演示用户与商品 |
| `npm test` | Vitest 单元 / 接口测试 |

</details>

## 测试

```bash
# 从仓库根目录执行。
nvm use
npm run check:runtime
npm test                  # 前端单元/组件测试

# 后端测试需要可丢弃的测试库
docker compose up -d postgres
docker compose exec -T postgres createdb -U monexus monexus_test   # 仅首次
export TEST_DATABASE_URL='postgresql://monexus:monexus_dev_2026@localhost:5432/monexus_test?schema=public'
DATABASE_URL="$TEST_DATABASE_URL" npm --prefix server run db:migrate:deploy
REDIS_ENABLED=false npm --prefix server test
```

<details>
<summary><b>本地门禁、E2E 与注意事项</b></summary>

```bash
# 本地构建、后端测试与移动端/主套件/法律页面浏览器验证
npm run verify:local

# 仅主浏览器套件：需先对测试库迁移并写入 seed
# （verify:local 会自动准备这些夹具）。
DATABASE_URL="$TEST_DATABASE_URL" npm run e2e
DATABASE_URL="$TEST_DATABASE_URL" npm run e2e:ui # Playwright 交互界面
```

- 后端测试强制要求 `TEST_DATABASE_URL`，每项测试前会清空共享业务表。请使用可丢弃数据库，同一测试库只运行一个后端测试进程。定向验证可追加文件，例如 `npm --prefix server test -- src/__tests__/business-time-boundaries.test.ts`。
- `verify:local:no-e2e` 执行前后端构建和后端测试；`verify:local` 还会重置并 seed 测试库，运行移动端、主套件与法律页面浏览器测试。两者都不执行根目录前端单测、架构检查或通知/catalog-ops 独立 E2E，前端单测另跑 `npm test`，其余见[测试策略](./docs/testing-policy.md)。
- 本地 E2E 用于排查；最终交付代码的正式 CI/E2E 由 GitHub Actions 执行，本地局部通过不能替代 `CI OK`。
- 运行依赖数据库的本地 E2E 前先停止开发 API 服务：Playwright 可以复用已运行的服务，仅更改命令中的数据库 URL 不会改变该服务原先使用的数据库。

CI 与部署工作流见 [`.github/workflows/`](./.github/workflows/)。

</details>

## 生产部署

提供三条 Docker Compose 路径，另保留非 Docker 的 legacy 兜底。GitHub Actions 能向 GHCR 推送镜像时，优先使用 **路径 A**。

| 路径 | 适用场景 |
| :--- | :--- |
| **A — 经审批的 GitHub Actions 发布**（推荐） | 校验同一 `master` SHA 的 CI 与多架构镜像，等待 `production` Environment 审批，再执行 Compose 健康检查 |
| **B — 手动 GHCR / Compose** | 主机首次引导或故障恢复 |
| **C — 在主机本地构建镜像** | GHCR 不可用或离线预演 |
| **D — 非 Docker 产物**（legacy） | 经 SSH 部署到 nginx + systemd 主机 |

所有路径的前置相同：将 [`.env.example`](./.env.example) 复制为 `.env` 并填入真实密钥（JWT ≥ 32 字符、Postgres、SMTP、对象存储、指标令牌等），然后执行 `npm run prod:env`。

<details>
<summary><b>镜像与 Tag（GHCR）</b></summary>

[`docker-publish.yml`](./.github/workflows/docker-publish.yml) 负责构建，并在非 PR 事件下推送：

| 镜像 | 仓库路径 | Dockerfile |
| :--- | :--- | :--- |
| 后端 API | `ghcr.io/amo0114/monexus-server` | `server/Dockerfile` |
| 前端（nginx SPA） | `ghcr.io/amo0114/monexus-web` | 根目录 `Dockerfile` |

正式发布的 tag 同时包含 `linux/amd64` 与 `linux/arm64`。

| 触发 | 标签 |
| :--- | :--- |
| 推送到 `master` | `:master`、`:sha-<short>`、`:latest` |
| Git 标签 `v1.2.3` | `:1.2.3`、`:1.2`、`:latest` |
| Pull Request | 仅构建不推送（冒烟验证） |

`docker-compose.prod.yml` 通过 `MONEXUS_IMAGE_TAG`（默认 `latest`）与 `MONEXUS_PULL_POLICY`（`missing` · `always` · `never`）选择镜像。正式发布建议用不可变 tag（如 `sha-abc1234`）；跟踪 `latest` 时请设 `MONEXUS_PULL_POLICY=always`。

</details>

<details>
<summary><b>路径 A — 经审批的 GitHub Actions 发布</b></summary>

完成一次 VPS 引导后，使用 [`Compose Production Deploy`](./.github/workflows/compose-production-deploy.yml) 发布。先以 `workflow_dispatch + dry_run=true` 演练；手动演练成功前不要开启自动部署。详见 [`compose-production-deploy.md`](./docs/operations/compose-production-deploy.md)。

</details>

<details>
<summary><b>路径 B — 手动 GHCR / Compose</b></summary>

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u USERNAME --password-stdin   # 一次性

cp .env.example .env   # 填密钥；设置 MONEXUS_IMAGE_TAG / MONEXUS_PULL_POLICY
npm run prod:env

export MONEXUS_IMAGE_TAG=sha-<short>   # 或 latest / 1.2.3
export MONEXUS_PULL_POLICY=always      # 使用 :latest 时建议 always
npm run prod:up
npm run prod:ps
npm run prod:smoke
```

主机上无需编译源码，只需 Docker Compose、Postgres 数据卷和合法 `.env`。

</details>

<details>
<summary><b>路径 C — 在主机本地构建</b></summary>

```bash
npm run prod:env
npm run prod:build    # docker compose -f docker-compose.prod.yml build
npm run prod:up
npm run prod:smoke

# 或全量门禁（环境 + config + build + up + smoke）：
npm run prod:gate
```

</details>

<details>
<summary><b>路径 D — 非 Docker 产物（legacy）</b></summary>

GitHub Actions 仍可打 tar 包（[`cd.yml`](./.github/workflows/cd.yml)），经 SSH（[`deploy.yml`](./.github/workflows/deploy.yml)）部署到 **nginx + systemd**（或 PM2）主机，发布目录为 `/opt/monexus/`。详见 [`deployment-target.md`](./docs/operations/deployment-target.md)。

</details>

**运维文档：** [运维手册](./docs/operations/runbook.md) · [1Panel/OpenResty VPS](./docs/operations/vps-1panel-openresty-deployment.md) · [Caddy VPS](./docs/operations/vps-compose-deployment.md) · [受保护发布](./docs/operations/compose-production-deploy.md) · [主机形态](./docs/operations/deployment-target.md) · [回滚](./docs/operations/rollback-runbook.md) · [密钥管理](./docs/operations/secrets-management.md)

## 文档索引

| 文档 | 说明 |
| :--- | :--- |
| [产品 PRD](./docs/superpowers/specs/2026-04-30-monexus-product-prd.md) | 产品范围与里程碑 |
| [充值与支付平台 V1](./docs/specs/recharge-payment-platform-v1.md) | 充值平台；无凭据时 live 渠道保持 disabled |
| [商家结算契约](./docs/superpowers/specs/2026-04-29-monexus-merchant-settlement-contract.md) | 结算规则 |
| [OpenAPI](./docs/superpowers/specs/monexus-api-openapi.json) | 接口定义 |
| [`docs/operations/`](./docs/operations/) | 运维手册、灰度、告警 |
| [`docs/archive/`](./docs/archive/) | 历史计划、MVP 原型、设计交接（只读归档） |
| [设计系统](./design-system/monexus/MASTER.md) | UI 设计令牌与组件 |

## 参与贡献

本仓库主要为**内部产品**。若你有权限：

1. 从 `develop` 拉出功能分支（如 `feat/简短描述`），PR 目标为 `develop`；`master` 只接受 release/hotfix PR。详见[分支与 CI 规范](./docs/branching-and-ci.md)。
2. 变更聚焦，遵循 `server/src/modules/` 与 `src/pages/` 的现有边界。
3. 运行受影响的测试与构建（定向检查用 `npm run verify:quick`；更广验证用 `npm test` 与 `npm run verify:local:no-e2e`）。
4. 行为或运维流程变化时同步更新 `docs/`。**禁止**提交 `.env`、密钥或生产数据备份。

## 许可证

**私有 / 专有软件。** 版权归项目所有者所有。本代码库仅供授权的内部使用；未经书面许可，不得在组织外再分发或用于商业用途。

<br>

<p align="center"><sub>MoNexus — 积分进，数字价值出。</sub></p>
