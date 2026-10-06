# 三国风默认昵称

注册未填写昵称时，服务端生成并保存趣味昵称，例如“爱喝茶的小军师”“追风的桃园客”。昵称最多 20 字，允许重名，不作为登录或账号标识。刷新、重新登录、修改头像不会重新分配昵称。

`User.nicknameIsGenerated` 记录来源：自动注册和历史回填为 `true`；注册时填写昵称或通过 `PATCH /auth/me` 明确保存昵称后为 `false`。只修改头像不改变昵称来源。公开响应不暴露此内部字段。

`20261005120000_friendly_default_nicknames` 一次性替换空昵称和精确符合 `mn_[2-9A-HJ-NP-Z]{8}` 的旧格式。历史数据没有来源记录，此范围已由产品方确认；无法区分历史上主动填写同格式的用户。其他非空昵称、已选预设头像、上传头像及账号其他字段不变。迁移后不再按昵称格式自动改名，用户手动保存旧格式也会保留。

历史回填和空值展示使用固定 v1 词表与用户 ID 映射。词表顺序不可重排；迁移测试验证 SQL 与 TypeScript 映射一致。个人资料、认证响应、排行榜与公开评价共用昵称解析规则，已保存昵称始终优先。评价缓存最长 30 秒后更新。

部署时先备份身份字段，再执行数据库迁移、生成 Prisma Client、启动新版服务。禁止用 `db push --force-reset` 更新已有数据。本地若数据库没有 Prisma 迁移历史，可核对字段后仅执行本次 SQL；不要为了补历史而重建数据库。回滚昵称时应依据备份逐项核对，避免覆盖迁移后用户主动修改的昵称。

验证：`default-nickname.test.ts`、`default-nickname-migration.test.ts`、`auth.test.ts`、`leaderboard.test.ts`、`modules/reviews/reviews.test.ts`，以及 `e2e/auth.spec.ts` 和 `e2e/profile-avatar.spec.ts`。

2026-10-06 补充验证：在独立空临时库执行完整 Prisma 迁移链及迁移状态检查，通过上述五个后端测试文件与 `leaderboard-current.test.ts`，共 82 项；排行榜页面另有 7 项前端测试通过。迁移回归覆盖全部 1024 个昵称映射、旧默认格式与手动昵称边界，并确认头像及密码字段不变；排行榜回归覆盖北京时间自然周/月、当天实时统计、名次基准、刷新与会话隔离。临时库已清理，未操作开发数据库。日志：`/root/projects/monexus-refactor-artifacts/identity-consolidation-20261006/`。
