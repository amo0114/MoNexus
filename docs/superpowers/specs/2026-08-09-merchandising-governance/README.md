# 热卖、推广与平台身份展示 — Spec Coding 工程文档包

本目录是 SPEC-MERCH-001 的唯一实施入口。当前仅完成规格设计，不包含业务代码、迁移、积分扣款、推广活动、生产资产或图片生成。

| 文档 | 角色 |
| --- | --- |
| [spec.md](./spec.md) | Specify：领域语义、模型、排名、推广、权益、视觉和验收 |
| [plan.md](./plan.md) | Plan：架构、Foundation、阶段、测试、发布/回滚 |
| [task.md](./task.md) | Tasks：原子任务、文件所有权、依赖、DoD |
| [implement.md](./implement.md) | Implement：Worktree/DB/端口、权限、实施卡、证据 |
| [checklist.md](./checklist.md) | Checklist：P0/P1、AC、PR Gate |

| 字段 | 值 |
| --- | --- |
| 规格 ID | SPEC-MERCH-001 |
| Plan/Tasks/Implement/Checklist | PLAN-MERCH-001 · TASK-MERCH-001 · IMPL-MERCH-001 · CHK-MERCH-001 |
| 版本 | 0.1.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation** |
| 审查基线 | `develop@da38dd0580eeac737f5291556b9dbdf832d91970` |
| 并行契约 | [PAR-CMI-001](../2026-08-09-catalog-merch-identity-parallel-contract.md) |
| 前置依赖 | SPEC-CATALOG-OPS-001 的 category/public Product contract 与 Shared Foundation |
| 图片生成约束 | `/root/.codex/skills/api-image/SKILL.md`；运行时使用 provider 配置和 `gpt-image-2` |

## 一句话结论

彻底废弃商家可写 `isHot`：自然热卖由成功创建且当前未退款的订单（即时模式已扣积分、人工模式已冻结积分）的版本化时间窗快照计算；推广使用清晰标注的独立展位和固定时长积分套餐；平台精选、平台自营和商家合作伙伴各有独立权威来源与审计，不互相伪装。

## Owner 已批准的冻结决策

- [x] `O-MERCH-01`：商家/管理员都不能直接写自然热卖；遗留 Product.isHot 不再参与排序/展示，后续再物理删除。
- [x] `O-MERCH-02`：默认自然热卖规则为近 30 天、排除 refunded、每小时原子快照、分类内前 20% 且至少 5 单；阈值可由整数 SystemConfig 调整。
- [x] `O-MERCH-03`：热卖只影响 organic 排名/badge；推广和平台精选使用独立 shelf/placement，绝不伪装成 organic 热卖。
- [x] `O-MERCH-04`：P0 推广只使用站内积分固定时长套餐，不接法币、CPM、CPC、竞价或第三方支付。
- [x] `O-MERCH-05`：商家提交待审不扣款；管理员批准时同事务扣积分并 schedule/activate；余额不足进入 payment_failed。
- [x] `O-MERCH-06`：批准后开跑前平台取消全额自动退；开跑后不自动退，由管理员显式 0..chargedAmount 调整并写理由/审计。
- [x] `O-MERCH-07`：推广必须显示“推广”，平台精选显示“平台精选”；两者均不改变热卖指标。
- [x] `O-MERCH-08`：`merchantId=null` 自动投影“平台自营”；商家永远不能购买/申请该身份。
- [x] `O-MERCH-09`：“平台合作伙伴”是限时 MerchantEntitlement，默认按近 90 天净推广消费积分 `Σ(chargedPoints - refundedPoints) ≥ 1000` 自动授予，也可管理员有理由/到期日授予；禁止“平台认证/官方保证”文案。
- [x] `O-MERCH-10`：商品卡最多显示平台自营/平台精选/热卖三类；合作伙伴装饰只在商家身份区域；推广 disclosure 不计入 badge 数量。
- [x] `O-MERCH-11`：Image 2 只生成受审概念母版/纹理；生产小徽章使用代码/SVG/CSS，禁止运行时生图和未审核 AI 产物直接上线。
- [x] `O-MERCH-12`：本波不新增推广/精选/权益通知事件，不修改订单/结算语义。

## 用户可见语义

| 标签 | 含义 | 来源 |
| --- | --- | --- |
| 热卖 | 指定时间窗内有效销量达到规则 | 系统快照 |
| 推广 | 商家购买了明确标注的曝光位 | 有效 PromotionCampaign |
| 平台精选 | 平台运营人工选择 | EditorialFeature |
| 平台自营 | 商品由平台发布 | Product.merchantId=null |
| 平台合作伙伴 | 商家处于有效合作权益期 | MerchantEntitlement |

不得使用“平台认证”“官方认证”“平台担保”“质量保证”等暗示背书的文案。

## 范围边界

- Catalog 分类、商品 draft/publish、库存、Xboard 媒体由 SPEC-CATALOG-OPS-001 负责。
- Identity、Navbar 由 SPEC-IDENTITY-SYNC-001 负责。
- 通知由 SPEC-NOTIFY-RT-001 负责。
- Shared schema/migrations 只由 FND-CMI-001 Owner 落地；本规格业务 Agent 不直接改 schema。
- Frozen spec-only SHA `S` 必须是 Foundation `F` 的祖先；所有 Merch BE/FE lane 从 `F` 分叉。
- Merch 只交独立组件；Catalog host release `H` 后，`AdminPage.tsx`、`MerchantDashboardPage.tsx` 由 CMI Integration Owner 持有整文件锁并串行 mount。

Owner 已批准 O-MERCH-01～12 与 PAR-CMI-001；六件套已冻结。全部 Implement/Checklist 继续保持 Pending，直至 `S/F` 与对应 Gate 真实满足。
