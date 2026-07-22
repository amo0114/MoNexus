# MoNexus

[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![License](https://img.shields.io/badge/License-Private-lightgrey)](#许可证)

[English](./README.md) | **简体中文**

> 内部福利积分兑换平台。用户通过站内积分兑换数字商品（卡密、订阅链接、虚拟服务），**不接入任何真实货币或第三方支付**。

---

## 目录

- [项目简介](#项目简介)
- [功能特性](#功能特性)
- [技术栈](#技术栈)
- [架构概览](#架构概览)
- [目录结构](#目录结构)
- [快速开始](#快速开始)
- [演示账号](#演示账号)
- [常用脚本](#常用脚本)
- [测试](#测试)
- [生产部署](#生产部署)
- [文档索引](#文档索引)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

---

## 项目简介

**MoNexus** 是一个纯 **内部福利 / 积分激励平台**：平台运营方发放积分，商家供应数字商品，用户消费积分。所有金额均为系统内非负整数账面流转，与人民币、外币、银行卡、微信、支付宝、Stripe 等**无任何关联**。

| 角色 | 能力 |
| --- | --- |
| **普通用户 (user)** | 注册登录、签到邀请、浏览商城、兑换商品、查看订单与评价 |
| **商家 (merchant)** | 申请入驻、管理商品与库存、履约发货、查看结算 |
| **管理员 (admin)** | 审核商家、调整积分、配置系统奖励、批量结算、审计日志 |

**明确不做的边界：** 真实支付、用户法币充值积分、提现到法币、实物物流、多租户白标 SaaS、原生 App。仅 Web + 移动浏览器响应式。

---

## 功能特性

### 用户端

- 邮箱注册 / 登录，HttpOnly Cookie 刷新令牌
- 邮箱验证与密码重置（SMTP；本地可回退控制台邮件）
- 商品大厅：搜索、分类、游标分页
- 多种交付：即时库存卡密、固定内容、手动履约服务
- 每日签到、邀请码、积分流水
- 订单历史、发货内容复制、商品评价

### 商家端

- 自助入驻 + 管理员审核（`pending → active / rejected / suspended`）
- 商品增删改、多行库存导入、库存变更日志
- 订单列表、争议处理、手动发货
- 数据看板与分润结算（订单创建时快照抽成）

### 管理端

- 用户 / 商家 / 商品 / 订单 / 结算总览
- 商家审核 / 停用、按商家配置抽成比例
- 手动调积分，完整 Admin 审计
- 运行时系统配置（注册 / 邀请 / 签到奖励、会员等级）
- 可观测性：健康检查、Prometheus 指标、Sentry 错误上报

### 工程与质量

- 兑换同事务：扣积分 + 占库存 + 订单 + 发货 + 结算
- 积分与佣金全程整数运算，禁止浮点金额
- Redis 可选公读缓存 + 熔断
- S3 兼容对象存储（本地 MinIO，生产 S3/R2/OSS）
- CI/CD、备份脚本、生产 Compose、运维手册

---

## 技术栈

| 层级 | 技术 |
| --- | --- |
| **前端** | React 18、TypeScript、Vite 6、React Router 6、Zustand、Tailwind CSS、Radix UI、Axios、Sentry |
| **后端** | Node.js 20、Express 4、TypeScript、Zod、Prisma 6、JWT + Cookie 刷新令牌 |
| **数据** | PostgreSQL 16、Redis 7（可选）、MinIO / S3 兼容存储 |
| **运维** | Docker Compose、nginx、GitHub Actions、Vitest、Playwright、pino、prom-client |

**运行时约束：** Node.js `>=20 <21`，npm `>=10 <11`（见 `.nvmrc`）。

---

## 架构概览

```text
浏览器 (Vite/React)
        │  /api  （开发代理 / 生产 nginx）
        ▼
   Express API  ── Prisma ── PostgreSQL
        │              └── Redis（可选缓存）
        ├── 邮件（SMTP / 控制台）
        ├── 存储（内存 / S3）
        └── 指标 + Sentry
```

**核心兑换流程：**

```text
POST /api/orders
  → 同一事务内：
      校验余额与商品 → 锁定库存条目 → 扣积分
      → 创建订单 + 发货记录 + 积分流水 + 结算 → 更新库存销量
```

角色：`user` | `merchant` | `admin`。商家资源严格隔离；跨商家访问返回 **404**（而非 403），避免资源枚举。

---

## 目录结构

```text
MoNexus-new/
├── src/                      # React 前端
│   ├── api/                  # HTTP 客户端
│   ├── components/           # 通用与角色组件
│   ├── pages/                # 路由页面（商城、个人中心、商家、管理）
│   ├── stores/               # Zustand 状态
│   └── lib/                  # 主题、Web Vitals、错误上报
├── server/                   # Express 后端
│   ├── prisma/               # schema、迁移、seed
│   └── src/
│       ├── modules/          # auth / products / orders / merchant / admin ...
│       ├── middlewares/      # 鉴权、校验、指标、错误处理
│       └── lib/              # prisma、redis、cache、mailer、storage
├── e2e/                      # Playwright 端到端测试
├── docs/                     # PRD、设计说明、运维手册、archive/
├── scripts/                  # dev-up、备份、prod smoke、本地校验
├── docker-compose.yml        # 本地 Postgres + Redis（可选 MinIO）
├── docker-compose.prod.yml   # 生产编排
└── design-system/            # UI 设计令牌与品牌资产
```

---

## 快速开始

### 环境要求

- [Node.js 20](https://nodejs.org/) 与 npm 10
- [Docker](https://docs.docker.com/get-docker/)（用于 PostgreSQL / Redis）
- Git

### 一键启动（推荐）

自动拉起 Postgres + Redis、迁移、后端与前端：

```bash
# 克隆仓库
git clone <your-repo-url> MoNexus-new
cd MoNexus-new

# 安装依赖
npm install
cd server && npm install && cd ..

# 启动全套（可选：重新写入演示数据）
bash scripts/dev-up.sh
# bash scripts/dev-up.sh --seed
```

| 服务 | 地址 |
| --- | --- |
| 前端 | http://localhost:5173 |
| 后端 API | http://localhost:3000 |
| 存活探针 | http://localhost:3000/api/health/live |
| 就绪探针 | http://localhost:3000/api/health/ready |

停止：在 `dev-up` 终端按 `Ctrl+C`，再执行 `docker stop monexus-db monexus-redis`。

### 手动分步启动

```bash
# 1) 基础设施
docker compose up -d postgres redis

# 2) 后端
cd server
cp ../.env.example .env   # 或由 dev-up 自动写入 DATABASE_URL / JWT_SECRET
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

如需真实图片上传，可启用 MinIO：

```bash
docker compose --profile storage up -d
```

未启用 MinIO 时，后端使用内存存储适配器，足够本地开发。

---

## 演示账号

执行 `npm run db:seed` 或 `bash scripts/dev-up.sh --seed` 后：

| 角色 | 邮箱 | 密码 |
| --- | --- | --- |
| 管理员 | `admin@moyuan.net` | `admin123` |
| 普通用户 | `test@moyuan.net` | `user123` |
| 商家 | `merchant@moyuan.net` | `merchant123` |

> **安全提示：** 以上账号仅供**本地开发**。切勿用于预发 / 生产环境；任何共享部署前必须更换全部默认密钥与口令。

---

## 常用脚本

### 仓库根目录

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Vite 前端 |
| `npm run build` | 类型检查 + 前端生产构建 |
| `npm run e2e` | Playwright 端到端测试 |
| `npm run verify:local` | 本地全量门禁（库、单测、可选 E2E） |
| `npm run verify:local:no-e2e` | 同上，跳过 Playwright |
| `npm run prod:env` | 校验生产 `.env` |
| `npm run prod:gate` | 环境 + compose + 构建 + 启动 + 冒烟 |
| `npm run prod:smoke` | 生产冒烟检查 |
| `npm run backup:restore-check` | 校验数据库恢复到可丢弃目标库 |

### 后端 `server/`

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | Express 热重载（`tsx watch`） |
| `npm run build` / `npm start` | 编译 TS 并运行 `dist` |
| `npm run db:migrate` | Prisma 开发迁移 |
| `npm run db:migrate:deploy` | Prisma 部署迁移 |
| `npm run db:seed` | 写入演示用户与商品 |
| `npm test` | Vitest 单元 / 接口测试 |

---

## 测试

```bash
# 后端单测与接口测试（需可丢弃的测试库）
cd server
# 建议 TEST_DATABASE_URL 指向 monexus_test
npm test

# 仓库根目录完整校验
npm run verify:local

# 仅 E2E（需服务已启动）
npm run e2e
npm run e2e:ui      # Playwright 交互界面
```

CI 工作流见 [`.github/workflows/`](./.github/workflows/)（`ci.yml`、`cd.yml`、`deploy.yml` 以及备份与告警相关作业）。

---

## 生产部署

概要步骤（完整流程见运维文档）：

1. 将 `.env.example` 复制为 `.env`，填入真实密钥（JWT ≥ 32 字符、Postgres、SMTP、对象存储、指标令牌等）。
2. 校验：`npm run prod:env`
3. 构建并启动：`npm run prod:up`（或全量门禁 `npm run prod:gate`）
4. 冒烟：`npm run prod:smoke`
5. 每日备份：设置 `DATABASE_URL` 后执行 `bash scripts/backup.sh`

推荐部署形态：**自建 nginx + systemd**（或 PM2），发布目录建议 `/opt/monexus/`。详见：

- [`docs/operations/runbook.md`](./docs/operations/runbook.md)
- [`docs/operations/deployment-target.md`](./docs/operations/deployment-target.md)
- [`docs/operations/rollback-runbook.md`](./docs/operations/rollback-runbook.md)
- [`docs/operations/secrets-management.md`](./docs/operations/secrets-management.md)

---

## 文档索引

| 文档 | 说明 |
| --- | --- |
| [`docs/superpowers/specs/2026-04-30-monexus-product-prd.md`](./docs/superpowers/specs/2026-04-30-monexus-product-prd.md) | 产品 PRD 与里程碑 |
| [`docs/superpowers/specs/2026-04-29-monexus-merchant-settlement-contract.md`](./docs/superpowers/specs/2026-04-29-monexus-merchant-settlement-contract.md) | 商家结算契约 |
| [`docs/superpowers/specs/monexus-api-openapi.json`](./docs/superpowers/specs/monexus-api-openapi.json) | OpenAPI 定义 |
| [`docs/operations/`](./docs/operations/) | 运维手册、灰度、告警 |
| [`docs/archive/`](./docs/archive/) | 历史计划、MVP 原型、设计交接（只读归档） |
| [`design-system/monexus/MASTER.md`](./design-system/monexus/MASTER.md) | UI 设计系统 |

---

## 参与贡献

本仓库主要为**内部产品**。若你有权限并希望贡献：

1. 从 `master` 拉出功能分支（如 `feat/简短描述`）。
2. 变更聚焦，遵循 `server/src/modules/` 与 `src/pages/` 现有边界。
3. 提交前运行 `npm run verify:local:no-e2e`（或完整 `verify:local`）。
4. 优先小 PR、动机清晰；行为或运维流程变化时同步更新 `docs/`。
5. **禁止**提交 `.env`、密钥或生产数据备份。

重大设计变更请先对照 `docs/superpowers/` 下的 PRD / 设计说明。

---

## 许可证

**私有 / 专有软件。** 版权归项目所有者所有。

本代码库仅供授权的内部使用。未经书面许可，不得在组织外再分发或用于商业用途。

---

## 致谢

- 产品与工程里程碑 M1–M9（MVP → 履约状态机 → 评价 → 生产运维）
- `design-system/monexus/` 下的设计令牌与 UI 改版交接
- 开源依赖：React、Express、Prisma、Vite、Tailwind、Playwright、Vitest 等生态项目

---

<p align="center">
  <sub>MoNexus — 积分进，数字价值出。面向内部福利场景（灰度目标 100–10,000 用户）。</sub>
</p>
