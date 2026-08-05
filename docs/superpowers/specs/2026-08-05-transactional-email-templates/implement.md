# Implement Protocol: 事务邮件品牌模板

| 字段 | 值 |
| --- | --- |
| 文档 ID | IMPL-MAIL-TPL-001 |
| 版本 | 1.0.0 |
| 日期 | 2026-08-05 |
| 状态 | Active |
| 输入 | [spec.md](./spec.md) · [plan.md](./plan.md) · [task.md](./task.md) · [checklist.md](./checklist.md) |
| 方法依据 | Spec Coding：Specify → Plan → Tasks → Implement |

---

## 1. 入口门槛

- [x] Specify / Plan / Tasks 已冻结
- [x] 独立 worktree：`/root/projects/worktrees/monexus-email-templates-polish`
- [x] 分支：`feat/email-templates-polish`，基线 `origin/develop@8c47201`
- [x] 不需要生产密钥 / 生产库
- [x] 无 Prisma migration

## 2. 隔离契约

| 资源 | 规则 |
| --- | --- |
| 可写目录 | 仅本 worktree |
| 主仓 `/root/projects/MoNexus-new` | 只读；不在此编辑 |
| Docker / 共享 DB | 不占用；本任务以 vitest 为主 |
| 端口 | 不启动长期 dev server（除非人工预览） |

## 3. 文件所有权

| 可改 | 禁止 |
| --- | --- |
| `server/src/lib/mailer/**` | 改 SMTP 超时语义、改 token 协议 |
| 上表 8 个调用点文件 | 改 abuse limiter / registration 开关 |
| 相关 `__tests__/**` | 无关前端大改 |
| 本规格目录、`scripts/preview-mail-templates.mjs` | 改 `schema.prisma` |

## 4. 验证命令

```bash
cd /root/projects/worktrees/monexus-email-templates-polish/server
npx vitest run src/__tests__/mail-templates.test.ts src/__tests__/mailer.test.ts src/__tests__/admin-mail-operations.test.ts
# 更广回归（按需）：
npx vitest run
```

预览：

```bash
cd /root/projects/worktrees/monexus-email-templates-polish
node scripts/preview-mail-templates.mjs
```

## 5. 合并闸门

1. checklist P0 全通过  
2. 无 migration drift  
3. PR → `develop`，说明链接本规格目录  
