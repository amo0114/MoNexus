# Order Notification System

订单消息通知体系规格文档。

## 文档结构

本规格遵循 Spec-Driven Development 模式，分为三个独立文档：

1. **[spec.md](./spec.md)** — 需求规格
   - 背景与问题
   - 目标与范围
   - 业务规则与不变量
   - 事件目录
   - 验收标准

2. **[design.md](./design.md)** — 技术设计
   - 架构概览
   - 数据模型
   - 核心组件
   - API 设计
   - 前端集成
   - 测试策略

3. **[tasks.md](./tasks.md)** — 实施任务
   - 任务依赖图
   - 分阶段任务清单
   - 验收标准与验证方式
   - 实施注意事项

## 快速开始

### 阅读顺序

1. **产品/业务评审**：先读 [spec.md](./spec.md)，确认需求和业务规则
2. **技术评审**：读 [design.md](./design.md)，评审架构和技术方案
3. **实施阶段**：按 [tasks.md](./tasks.md) 逐个完成任务

### Decision Review 结果

`spec.md §11` 的 Decision Review 已完成：7 个重点问题中 6 个已决定、1 个已明确延期、0 个需要人工阻塞。Phase 1 的默认行为、设计约束和实施任务已同步到三份文档；平台自营人工单收件人仅在平台建立 owner/值班或可审计分配机制后重新决策。

## 状态

| 项 | 状态 |
|---|---|
| 规格文档 | ✅ Ready for Phase 1 |
| 技术设计 | ✅ Ready for Phase 1 |
| 任务拆分 | ✅ Ready for Phase 1（T00–T07，共 8 个 Task） |
| 实施 | ✅ Phase 1 已实现（见 [checklist.md](./checklist.md)） |

## 变更日志

- 2026-08-07: 初始版本，基于原 `order-notification-system.md` 重构
- 2026-08-07: 完成 §11 Decision Review；同步 Phase 1 决定、设计和任务边界
