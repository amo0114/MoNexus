# Checklist: 事务邮件品牌模板

| 字段 | 值 |
| --- | --- |
| 文档 ID | CHK-MAIL-TPL-001 |
| 规格 | SPEC-MAIL-TPL-001 |

## P0（必须）

- [x] 全部 kind 经 `renderMail`，含 `text` + `html`
- [x] HTML escape 单测覆盖
- [x] 验证 / 重置 / OTP / 测试邮件调用点已替换
- [x] 商家/业务 5 场景调用点已替换
- [x] 相关 vitest 通过（91 tests / 10 files，2026-08-05）
- [x] 未改 SMTP 凭证面、未改 token/OTP 安全协议
- [x] 测试邮件仍无业务敏感内容（MAIL-04）
- [x] 无 Prisma migration

## P1（应有）

- [x] preview 脚本可导出全部 kind
- [x] logo 使用绝对 URL + alt
- [x] subject 语义与现网接近

## 发布就绪

- [ ] PR 描述含规格路径与截图/预览说明（可选）
- [x] 回滚策略：revert 本 PR
