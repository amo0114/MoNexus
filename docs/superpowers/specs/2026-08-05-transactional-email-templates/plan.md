# Plan: 事务邮件品牌模板

| 字段 | 值 |
| --- | --- |
| 文档 ID | PLAN-MAIL-TPL-001 |
| 版本 | 1.0.0 |
| 日期 | 2026-08-05 |
| 状态 | Frozen |
| 输入 | [spec.md](./spec.md) |

---

## 1. 架构

```
业务模块 (auth / fakaBridge / admin / cron helpers)
        │
        ▼
  renderMail(kind, vars)  ──►  MailMessage { to, subject, text, html }
        │
        ▼
  getMailer().send(msg)   ──►  SmtpMailer | ConsoleMailer | CaptureMailer
```

- **呈现与传输分离**：templates 只渲染；mailer 只投递。
- **零依赖**：字符串模板 + table HTML。
- **配置注入**：`siteName`、`appBaseUrl`、`logoUrl` 默认从 `config` 读取，测试可传 override。

## 2. 目录

```
server/src/lib/mailer/templates/
  tokens.ts          # 颜色、站点名、logo 路径常量
  escape.ts          # htmlEscape
  layout.ts          # wrapHtml / wrapTextSections
  render.ts          # 分发 + 公开 API
  kinds/
    emailVerification.ts
    passwordReset.ts
    provisionOtp.ts
    mailTest.ts
    lowStock.ts
    slaOverdue.ts
    bookingReminder.ts
    subscription.ts
    provisionDegraded.ts
  index.ts           # re-export
server/src/__tests__/mail-templates.test.ts
scripts/preview-mail-templates.mjs
```

## 3. 调用点改造

| 文件 | 改造 |
| --- | --- |
| `modules/auth/service.ts` | 验证 / 重置 → `renderMail` |
| `lib/fakaBridge/provisionEmailProof.ts` | OTP → `renderMail` |
| `modules/admin/mailOperations.ts` | 测试邮件 → `renderMail`（保留 MAIL_* 常量 subject） |
| `lib/lowStockNotify.ts` | `buildMail` → template |
| `lib/slaRemind.ts` | 同上 |
| `lib/bookingRemind.ts` | 同上 |
| `lib/subscriptionRemind.ts` | pre / expired |
| `modules/orders/provisionCron.ts` | degrade 通知 |

## 4. 阶段

| 阶段 | 内容 |
| --- | --- |
| P0 | templates 基础设施 + 单测骨架 |
| P1 | 全部 kind 实现 + 快照/结构断言 |
| P2 | 替换全部调用点 + 修回归测试 |
| P3 | preview 脚本 + checklist |

## 5. 发布与回滚

- **无 migration**；纯后端代码。
- **回滚**：revert PR；SMTP/token 行为不变。
- **风险**：个别客户端忽略部分 CSS → 已用 table + inline 缓解；logo 404 → alt + 站点名。

## 6. 测试计划

- `vitest`：`mail-templates.test.ts`（escape、各 kind 关键字段、html 存在）。
- 既有：`mailer.test.ts`、`admin-mail-operations`、auth/provision 相关测试适配。
- 本地：`node scripts/preview-mail-templates.mjs` 输出到 `outputs/mail-previews/`。
