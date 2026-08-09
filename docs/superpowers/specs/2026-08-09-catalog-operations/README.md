# 商品目录、分类治理与库存操作 — Spec Coding 工程文档包

本目录是 SPEC-CATALOG-OPS-001 的唯一业务规格入口。当前只完成规格设计，不包含业务代码、依赖、数据库迁移、生成资产或运行时配置变更。

| 文档 | 角色 | 交付内容 |
| --- | --- | --- |
| [spec.md](./spec.md) | Specify | 问题、范围、Owner 决策、领域模型、API、不变量、需求与验收 |
| [plan.md](./plan.md) | Plan | 目标架构、迁移、阶段、测试、发布与回滚 |
| [task.md](./task.md) | Tasks | 原子任务、依赖、Owned/Must Not Touch、DoD 与证据 |
| [implement.md](./implement.md) | Implement | Worktree、DB/端口、权限、实施卡、共享热点锁与 Gate |
| [checklist.md](./checklist.md) | Checklist | P0/P1 完成定义、AC 索引、PR/发布闸门 |

执行顺序固定为 Specify → Plan → Tasks → Implement → Checklist。实施 Agent 不得用代码现状反向改写 Owner 冻结决策。

| 字段 | 值 |
| --- | --- |
| 规格 ID | SPEC-CATALOG-OPS-001 |
| Plan ID | PLAN-CATALOG-OPS-001 |
| Tasks ID | TASK-CATALOG-OPS-001 |
| Implement ID | IMPL-CATALOG-OPS-001 |
| Checklist ID | CHK-CATALOG-OPS-001 |
| 版本 | 0.1.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation** |
| 审查基线 | `develop@da38dd0580eeac737f5291556b9dbdf832d91970` |
| Spec Worktree | `/root/projects/worktrees/monexus-catalog-inventory-merchandising` |
| 并行契约 | [PAR-CMI-001](../2026-08-09-catalog-merch-identity-parallel-contract.md) |
| 前置设计 | `docs/superpowers/specs/2026-04-30-monexus-product-prd.md`、`docs/specs/product-model-and-checkout.md` |
| 方法依据 | [JavaGuide：Spec Coding 实践](https://javaguide.cn/ai-coding/practices/spec-coding.html)；仓库既有六件套规范 |

## 一句话结论

保留 Product → Offer → InventoryItem 的既有真相源关系，把“创建商品”和“改变可售量”拆成不同状态机；用平台治理的动态分类替代部署代码中的四类常量；让 Xboard 导入经过可复核 preview、封面门禁和数据库幂等关联；新增平台手工商品入口，但不在本规格实现热卖、推广或徽章。

## Owner 已批准的冻结决策

- [x] `O-CAT-01`：Offer 是价格、库存、履约真相源；Product 商业字段继续仅为兼容投影。
- [x] `O-CAT-02`：新商品默认 `draft`；创建商品不直接导入秘密库存或改变可售名额。
- [x] `O-CAT-03`：发布由独立原子 action 完成，并执行封面、分类、Offer、履约与至少一个可售 Offer 的 readiness gate。
- [x] `O-CAT-04`：新增数据库动态分类；分类只负责展示/检索，不约束 deliveryMode。
- [x] `O-CAT-05`：保留 `Product.type` 作为历史 label snapshot，新增稳定 `categoryId/code`；迁移后不因分类改名重写历史商品。
- [x] `O-CAT-06`：商家只能申请分类；管理员可批准为新分类、映射到已有分类或拒绝，全程审计。
- [x] `O-CAT-07`：Xboard import 使用 preview → confirm，必须有上传封面或分类默认封面，并以 external identity + request key 幂等。
- [x] `O-CAT-08`：P0 Xboard 不抓取任意远程图片、不同步调用 AI；图片只取平台对象存储或平台默认资产。
- [x] `O-CAT-09`：管理员获得通用平台商品创建向导；`merchantId=null` 只是平台发布身份，不在本规格定义徽章视觉。
- [x] `O-CAT-10`：现有 active 商品不因上线立即下架；新发布执行新门禁，legacy 未知类型回填到 inactive 的“待归类”分类。
- [x] `O-CAT-11`：Xboard 富文本在服务端按 allowlist 净化并移除远程图片/危险 URL；前端 DOMPurify 仅是第二道防线。

Owner 已批准 O-CAT-01～11 与 PAR-CMI-001；六份文档已冻结。所有 Implement 卡继续保持 Pending，直至 `S` 与各卡 Entry Gate 真实满足。

## 与其他规格的边界

- SPEC-MERCH-001 独占自然热卖、推广套餐/活动、平台精选、合作伙伴权益和 badge projection。
- SPEC-IDENTITY-SYNC-001 独占用户资料同步和头像/Navbar 一致性。
- SPEC-NOTIFY-RT-001 独占通知实时化；本规格不新增“分类审核/推广审核”通知事件。
- Shared Foundation Owner 统一落 Catalog/Merch 数据模型；本规格 Agent 不与 Merch Agent 并行编辑 `schema.prisma`。
- Owner Freeze 后先以最新 develop `D` 为直接父提交形成 docs-only SHA `S`；Foundation `F` 必须包含 `S`，Catalog/Merch lane 必须包含 `F`。
- Catalog Frontend 完成全部宿主修改后记录 host release `H`；`AdminPage.tsx`、`MerchantDashboardPage.tsx` 的整文件锁随后串行移交给 CMI Integration Owner。

## 当前已核实事实

- `Offer` 已被 schema 注释定义为价格、库存、履约真相源；Product 字段是投影。
- 商家创建 Product、默认 Offer、额外 Offers 已在同一事务中完成。
- 即时库存已有 preview/import/void；非即时限量 Offer 已有 capacity adjustment。
- 分类来自 `businessRegistry.productTypes` 的四个部署常量，不是数据库模型。
- Xboard catalog/input/product create 均没有图片契约，也没有 external plan 唯一关联。
- 管理端只有 Xboard 导入入口，没有通用平台商品创建 UI。

## 审核与变更控制

- Owner 修改任一 O-CAT 决策时，必须同步六件套、PAR-CMI-001、版本和追溯矩阵。
- Frozen 后改变 D-CAT/CAT/REQ/AC、迁移策略或 API 外部语义，须退回 Draft 重新批准。
- 本包不授权修改通知 Worktree、生产数据库、真实商品、真实 Xboard 数据或生产对象存储。
