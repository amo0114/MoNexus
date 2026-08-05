# Tasks: 事务邮件品牌模板

| 字段 | 值 |
| --- | --- |
| 文档 ID | TASK-MAIL-TPL-001 |
| 版本 | 1.0.0 |
| 状态 | Frozen |

---

## T0 — 文档与基线

- [x] 冻结 README/spec/plan/task/implement/checklist
- [x] worktree 基于最新 `origin/develop`
- **DoD**：决策 D-01~D-05 写入 spec；基线 commit 记录在 README

## T1 — 呈现层基础设施

- [x] `escape.ts` / `tokens.ts` / `layout.ts` / `render.ts` / `index.ts`
- [x] 类型安全的 kind 分发
- **DoD**：可对任意 kind 调用 `renderMail`；非法 kind 编译期或运行期明确失败
- **Owned**：`server/src/lib/mailer/templates/**`

## T2 — Kind 实现

- [x] 全部 10 个 kind 的 text + html
- [x] 单元测试覆盖 A-01~A-05
- **DoD**：`mail-templates.test.ts` 绿
- **Owned**：`templates/kinds/**`、`__tests__/mail-templates.test.ts`

## T3 — 调用点替换

- [x] 8 个业务文件改用 `renderMail`
- [x] 修复依赖纯文本的断言
- **DoD**：相关 vitest 绿；发送消息含 `html`
- **Owned**：auth / provisionEmailProof / mailOperations / lowStock / sla / booking / subscription / provisionCron + 对应测试

## T4 — 预览与验收

- [x] `scripts/preview-mail-templates.mjs`
- [x] checklist 勾选
- **DoD**：可本地打开预览 HTML；checklist P0 全绿
