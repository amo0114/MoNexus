# Handoff · 后端架构整改与 FakaBridge 可选插件

- Owner 于 2026-11-24 在会话批准实施，要求最终只用一个 PR 指向 develop。
- 基线为 origin/develop@4b098c8ff415b53dabb32758730cfb792b60cc9c。首个实现工作树为 /root/projects/worktrees/monexus-backend-review-faka-plugin。根目录旧文档分支有用户的未提交 UI 变更，应留在原处。
- 工具链为 Node 22.23.1、npm 10.9.8；隔离库名 `monexus_test_backend_review_pr_20261124`，本机 PostgreSQL 14，时区 Asia/Shanghai。

## 已实现

- BE-01 统一 FakaBridge 重试 SQL 时间类型。BE-05 钱包开户与扫描负例。BE-02 冻结环内有向边。BE-06 OpenAPI 文档路径触发真实 API 测试。
- BE-03 将共享支付辅助模块下沉，支付运行时经组合入口调用充值用例；移除支付/充值环的豁免。
- BE-04 将平台订单履约命令搬到订单层。BE-07 提取即时交付与策略。BE-08 统一配置版本锁、校验和探测限流。
- 通过增量迁移持久化外部履约方，回填历史任务并兼容旧实例插入。取消、争议、售后与人工履约不再直接读 FakaBridge 任务。缺失 provider 时取消和历史售后按保守语义处理。

## 验证

- 首个实现工作树的中间快照通过 server build、architecture、migration safety 和单库 migrate。目标测试批次运行了 12 文件、88 项通过，包括 Asia/Shanghai 下的 FakaBridge 重试回归。实现期间又有少量边界和提取改动，最终提交需重跑。
- 原工作区评审证据见 docs/reviews/2026-11-24-backend-architecture-review。

## 下一步

1. 去除 app.ts 和组合根对 Faka 的静态装载，隔离 Faka 专属 HTTP/body 阶段、admin 注册、商品容量及前端扩展。保持原管理 MFA/授权和 bot raw-body 次序。
2. 建立可选安装、跨实例运行时装载、暂停和安全注销。复用现有 IntegrationConfig 接单锁。验收卸载时覆盖未处理任务、租约、撤销、reset operations、有效权益及存量服务。
3. 当前历史 Prisma 迁移把通用 Offer 列、Faka 表和约束混在多个文件。已应用文件保持原样。纯商城新库须有独立且可演进的安装路径，先验证旧库升级和干净核心库两条路径。避免把无配置或空布尔开关当作独立安装已经完成。
4. 用最终提交重跑 build、OpenSpec 验证、critical integrations、纯核心和热装载验收，创建单一 PR 并按 `run-e2e` 标签规则触发门禁。出站范围、生产时区和公告可达性仍需按可用证据核对。
