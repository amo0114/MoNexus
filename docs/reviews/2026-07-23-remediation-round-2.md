# 2026-07-23 Review — 第二轮修复记录

本记录对应 `docs/reviews/2026-07-23-findings.md` 中不依赖账务模型迁移的
治理、公开接口与运行面问题。它不替代原始发现：原始文档保留复现证据，本文记录
修复后的行为和回归范围。

| 原发现 | 修复 | 回归证据 |
| --- | --- | --- |
| ADM-01 | 管理员创建、编辑平台商品与 `AdminLog` 写入放进同一数据库事务。审计仅记录商品名称、类别、图标、价格、原价、热门状态和上下架状态；不复制富文本、图片 URL、固定发货内容或库存秘密。 | `admin-product-audit.test.ts`：创建与更新均留下可检索审计，且断言描述/富文本不在详情中。 |
| PUB-01 | 公告公开接口不再以 JWT 内的 role claim 决定定向受众。可选认证请求会读取当前 `User.status` 与商家 `Merchant.status`；封禁用户、停用商家和失效账号退化为访客，仅可获取 `audience=all`。 | `announcements.test.ts`：三种仍持有有效 JWT 的失效身份均只看到全员公告。 |
| UPLOAD-01 | 上传在写入对象存储前校验 PNG、JPEG、WebP、GIF 的文件签名，并要求实际类型与请求 MIME 完全一致；开发/测试内存下载响应增加 `X-Content-Type-Options: nosniff`。 | `uploads.test.ts`：伪造 PNG、真实 PNG 伪报 JPEG 均返回 `400 UNSUPPORTED_MEDIA_TYPE`；合法 PNG 上传和读取保持可用。 |
| OPS-02 | 服务在 `NODE_ENV=production` 且缺少 `METRICS_TOKEN` 时拒绝启动，消除仅靠部署预检才会发现 `/api/metrics` 裸露的缺口。开发和测试环境仍允许未配置 token。 | 两组隔离配置加载：缺 token 的 production 配置以退出码 1 拒绝；配置 token 时可正常加载。既有 `metrics.test.ts` 覆盖 bearer 校验。 |

## 验证

```text
npm run build                                      # server/
vitest: announcements / uploads / admin audit / metrics
24 tests passed, 4 files
```

## 保留工作

- **OPS-01**（加密且异机的 PostgreSQL + MinIO 对象备份）仍是 P1。它需要先确定
  备份目标、密钥保管和对象数据的保留周期；不能把未确认的远端凭据或破坏性同步命令
  写进生产脚本。
- 文件签名检查用于拒绝伪造 MIME；如果未来允许 SVG、TIFF、HEIC 或需要图像内容
  审核，应引入受维护的解码/重编码流水线，而不是扩大当前白名单。
