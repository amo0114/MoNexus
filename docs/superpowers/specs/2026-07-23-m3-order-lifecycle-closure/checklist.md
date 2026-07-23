# Checklist: M3 订单履约生命周期闭环

| 字段 | 值 |
| --- | --- |
| 文档 ID | `CHK-M3-OLC-001` |
| 版本 | `1.0.0` |
| 日期 | `2026-07-23` |
| 规格 | [`spec.md`](./spec.md) |
| 计划 | [`plan.md`](./plan.md) |
| 任务 | [`task.md`](./task.md) |

---

## 0. 使用方式

1. **实现中：** 每完成一项，将 `- [ ]` 改为 `- [x]`，并在「证据」列记 PR/commit/截图路径。  
2. **评审时：** Reviewer 抽查 P0；任一项 P0 未勾不得合入。  
3. **定义：**  
   - **P0** = 合并阻断（Definition of Done 硬条件）  
   - **P1** = 本波应完成，可书面豁免并建 follow-up issue  
   - **P2** = 可选增强  

### 签署

| 角色 | 姓名 | 日期 | 结果 |
| --- | --- | --- | --- |
| 实现者 | | | ☐ Ready for Review |
| Reviewer | | | ☐ Approved / ☐ Changes requested |
| QA（可兼任） | | | ☐ AC 通过 |

---

## 1. 范围与过程门禁（P0）

- [ ] **CHK-PROC-01** 变更范围符合 `spec.md` §2.1，无 MFA/订阅/公告/支付等范围外提交  
- [ ] **CHK-PROC-02** 未修改 Docker/GHCR/deploy workflow（除非独立运维 PR）  
- [ ] **CHK-PROC-03** 所有 P0 任务在 `task.md` 看板为 `Done`  
- [ ] **CHK-PROC-04** PR 描述链接本目录 `spec.md`，并列出 AC-01–06 自测结果  
- [ ] **CHK-PROC-05** 无密钥、`.env`、数据库 dump 进入 diff  

**证据：** PR URL: _______________

---

## 2. 领域规则与后端（P0 / P1）

### 2.1 契约（P0）

- [ ] **CHK-BE-01** `GET/POST` admin settlements 支持 `status=holding|voided|pending|settled`（REQ-F-040）  
- [ ] **CHK-BE-02** 用户订单详情响应包含 `holdingPoints`（REQ-F-041）  
- [ ] **CHK-BE-03** 未改坏 `legalTransitions`；非法迁移仍 400  
- [ ] **CHK-BE-04** `rejectOrder` / `resolveOrder` 行为与 PR #20 单测一致（未无意回退）  

### 2.2 推荐（P1）

- [ ] **CHK-BE-05** merchant stats 含 `todo` 计数（REQ-F-043）或已文档化前端降级方案  
- [ ] **CHK-BE-06** OpenAPI / 模块 README 已同步（若项目要求）  

**证据：** vitest 命令与结果: _______________

---

## 3. 用户端（P0 / P1）

### 3.1 P0

- [ ] **CHK-U-01** 订单详情展示状态 pill（含全枚举可渲染）  
- [ ] **CHK-U-02** 有冻结语义时展示 `holdingPoints` 及不误导的说明（REQ-F-011）  
- [ ] **CHK-U-03** `delivered` 可争议；成功后列表刷新为 `disputed`  
- [ ] **CHK-U-04** `delivered`/`disputed` 可确认结束；成功后为 `closed`  
- [ ] **CHK-U-05** `refunded` 无争议/确认入口，有终态说明（REQ-F-014）  

### 3.2 P1

- [ ] **CHK-U-06** 时间线 `timeline` 对用户可读（角色/时间/备注）  
- [ ] **CHK-U-07** 操作失败展示后端错误文案，无空白 Toast  

**证据：** 账号 / 订单 ID: _______________

---

## 4. 商家端（P0 / P1）

### 4.1 P0

- [ ] **CHK-M-01** `availableActions` 含 `start_fulfillment` 时接单可用（无回归）  
- [ ] **CHK-M-02** 含 `deliver` 时履约可用（无回归）  
- [ ] **CHK-M-03** 含 `respond_dispute` 时争议响应可用（无回归）  
- [ ] **CHK-M-04** 含 `reject` 时拒单可用；二次确认；成功后 `refunded`（**AC-01**）  
- [ ] **CHK-M-05** SLA 超时行高亮仍然有效  
- [ ] **CHK-M-06** 待办摘要：pending / processing / SLA 计数展示且与筛选一致（或已注明限制）  

### 4.2 P1

- [ ] **CHK-M-07** 列表/详情可见 holdingPoints、fulfillmentDeadline  
- [ ] **CHK-M-08** 结算列表可见 holding/voided 状态  

**证据：** 商家账号 / 订单 ID: _______________

---

## 5. 管理端（P0）

- [ ] **CHK-A-01** 订单列表可筛选 `disputed`（REQ-F-030）  
- [ ] **CHK-A-02** 仲裁 `result=refund` → 订单 `refunded`，结算 `voided`（**AC-02**）  
- [ ] **CHK-A-03** 仲裁 `result=close` → 订单 `closed`，结算进入可结算态（**AC-03**）  
- [ ] **CHK-A-04** 结算列表展示四态 pill（REQ-F-032）  
- [ ] **CHK-A-05** 结算筛选含 holding/voided（REQ-F-033）  
- [ ] **CHK-A-06** 批量结算仅 pending 可勾选；提交后状态 `settled`（**AC-04**）  
- [ ] **CHK-A-07** 非 admin 角色无法访问仲裁/结算写接口（抽测 401/403）  

**证据：** admin 操作截图或订单 ID: _______________

---

## 6. 验收场景（规格 AC，P0）

逐条执行，全部通过方可合入：

| AC | 描述 | 通过 |
| --- | --- | --- |
| **AC-01** | 商家拒单闭环 | ☐ |
| **AC-02** | 管理员仲裁退款 | ☐ |
| **AC-03** | 管理员仲裁关闭 | ☐ |
| **AC-04** | 批量结算仅 pending | ☐ |
| **AC-05** | E2E 主路径 manual_service | ☐ |
| **AC-06** | 自动化回归无失败 | ☐ |

详细 Given/When/Then 见 `spec.md` §10。

---

## 7. 测试自动化（P0 / P1）

### 7.1 P0

- [ ] **CHK-QA-01**  
  `cd server && ... vitest run` 覆盖：`m3-order-state-machine`、`orders-cron`、与本波相关的 admin/merchant 测试 **全部 PASS**  
- [ ] **CHK-QA-02** Playwright 主路径文件存在且本地 PASS（REQ-F-051 / **AC-05**）  
- [ ] **CHK-QA-03** Playwright 拒单 **或** 仲裁路径 PASS（REQ-F-052）  
- [ ] **CHK-QA-04** 全量或约定子集：`npm run verify:local:no-e2e` PASS（**AC-06** 基线）  

### 7.2 P1

- [ ] **CHK-QA-05** CI（GitHub Actions `ci.yml`）在本 PR 上绿  
- [ ] **CHK-QA-06** 完整 e2e suite 无新增 flake（或已知 issue 链接）  

**证据：**

```text
vitest: _______________
playwright: _______________
CI run: _______________
```

---

## 8. 非功能与安全（P0 / P1）

### 8.1 P0

- [ ] **CHK-NF-01** 越权：商家 A 无法操作商家 B 订单（期望 404）  
- [ ] **CHK-NF-02** 用户无法调用 admin resolve / merchant reject  
- [ ] **CHK-NF-03** 备注类输入受 max length 约束（前后端）  
- [ ] **CHK-NF-04** 无敏感字段（密码、refresh token）泄露到订单 JSON  

### 8.2 P1

- [ ] **CHK-NF-05** 破坏性按钮有确认；加载中防重复提交  
- [ ] **CHK-NF-06** 关键按钮具备可访问名称 / testid  
- [ ] **CHK-NF-07** 待办计数未引入全表扫描式请求（性能抽查）  

---

## 9. UX 一致性（P1）

- [ ] **CHK-UX-01** 订单/结算状态文案与 `businessRegistry` / RegistryPill 一致  
- [ ] **CHK-UX-02** Toast 成功/失败明确  
- [ ] **CHK-UX-03** 移动宽度下 Dialog 与表格不严重溢出（抽查 375px）  

---

## 10. 文档（P1）

- [ ] **CHK-DOC-01** PRD §0.1 已去除过时「积分未冻结 / 无仲裁接口」表述（T-DOC-01）  
- [ ] **CHK-DOC-02** 本目录四份文档版本号与实现一致  
- [ ] **CHK-DOC-03** 若有 API 破坏性，CHANGELOG 或 PR 说明已写  

---

## 11. 发布就绪（P0）

- [ ] **CHK-REL-01** 目标分支基于最新 `master`，冲突已解决  
- [ ] **CHK-REL-02** 无需数据迁移 **或** 迁移已 review 且可回滚说明完整  
- [ ] **CHK-REL-03** 合并后冒烟计划：灰度环境 AC-01–04 人工再跑一遍（负责人: _____）  
- [ ] **CHK-REL-04** 回滚方案明确：revert PR / 隐藏仲裁与拒单按钮（见 plan §8）  

---

## 12. 合并前最终门闩（全部 P0 必须为 x）

复制到 PR 描述：

```markdown
## DoD Gate (M3-OLC)
- [ ] Process (CHK-PROC-*)
- [ ] Backend (CHK-BE-01..04)
- [ ] User (CHK-U-01..05)
- [ ] Merchant (CHK-M-01..06)
- [ ] Admin (CHK-A-01..07)
- [ ] AC-01 .. AC-06
- [ ] QA (CHK-QA-01..04)
- [ ] Security (CHK-NF-01..04)
- [ ] Release (CHK-REL-01..04)
```

**仅当以上全部勾选，方可 Approve & Merge。**

---

## 13. 豁免记录（Exception Log）

| 检查项 ID | 原因 | 跟进 Issue | 批准人 | 日期 |
| --- | --- | --- | --- | --- |
| | | | | |

> P0 豁免需技术负责人书面批准；默认不允许。

---

## 14. 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 1.0.0 | 2026-07-23 | 初版验收清单 |
