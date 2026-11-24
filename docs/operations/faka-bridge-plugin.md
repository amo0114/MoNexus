# FakaBridge 插件交付与运行

同一次构建产出 `core/` 和 `faka-bridge/`。只部署 `core/` 即可运行普通商城。已运行的商城可以安装同一构建的 FakaBridge 制品，再从管理端装载和管理接单状态。

## 构建与纯商城部署

在仓库根目录用项目锁定的 Node.js 22、npm 10 安装两端依赖，准备一个空的绝对制品目录。

```bash
npm ci
npm --prefix server ci
npm --prefix server run db:generate
npm --prefix server run build
npm --prefix server run package:fulfillment -- "$RELEASE_DIR"
npm run build -- --manifest
node scripts/package-fulfillment-web.mjs "$RELEASE_DIR"
```

将 `core/web/` 设为站点静态根。在 `core/` 运行 `npm ci` 与 `npm run db:generate`，按 [标准运行配置](runtime-settings.md) 准备商城环境。给全新的数据库执行 `npm run db:migrate:deploy`，随后以现有进程角色运行 `npm start`。API 与 worker 使用同一数据库。

已包含 FakaBridge 的老站通过原发布制品升级，继续执行原有 Prisma 迁移历史。此次增量迁移回填历史履约归属。老站完成滚动升级后才可以操作运行时注销。独立核心制品使用单独的迁移历史，两个迁移入口会在写入前拒绝另一种历史。老站需要更换数据库迁移历史时须另行制定迁移方案。

## 筹备并装载

1. 在 API 和 worker 上准备同一构建的 `faka-bridge/dist/`。把插件文件合入各实例的 `core/dist/`，将 `plugins/fakaBridge/entry.js` 作为最后一步原子发布。
2. 新核心库先将 `faka-bridge/prisma/faka-migrations/` 和 `faka-bridge/scripts/install-faka-schema.mjs` 分别放入 `core/prisma/` 和 `core/scripts/`，在 `core/` 执行 `node scripts/install-faka-schema.mjs`。该命令使用迁移数据库连接，记录校验和并可安全重试。老站的插件表由原 Prisma 迁移管理。
3. 把 `faka-bridge/web/manifest.json` 中列出的文件按原路径发布到静态根。当前构建的入口依赖这些带哈希的资源名。
4. 用拥有设置管理权限且已完成 MFA 的管理员打开配置页，确认制品状态后点击「装载插件」。首次装载的独立核心站点在启用接单前配置和校验 FakaBridge。API 按请求刷新装载状态，worker 通过轮询应用共享状态。检查各实例均可读取相同的部署状态。

## 暂停、恢复与注销

- 暂停接单后，新结账和重置确认在事务内重新核对状态。已有任务由已冻结配置继续执行，账号查询、已受理重置和状态查询仍可使用。恢复接单可以继续使用当前配置版本。
- 注销前先暂停接单。待处理与未知结果、活动租约、撤销、售后、有效订阅和仍可使用的权益都会阻止注销。按管理端返回的阻塞条件处理后重试。
- 注销让各实例停止插件路由和后台处理，保留插件表、原配置版本和历史履约归属。商城继续展示历史订单与交付。需要供应商处理的历史退款可重新装载后核对执行。
- 各实例收敛后，可以从制品目录移除独立插件文件。热装载支持同一构建，跨版本升级走正常发布并重启进程。

## 本地验收

使用一套独占的空测试数据库，并令 `TEST_DATABASE_URL` 指向名称包含 `monexus_test` 的库。在完成制品安装依赖与 Prisma 生成后运行下列命令。它会应用核心迁移、创建交易夹具，验证商城路径、独立资源的发布和两进程装载、注销。

```bash
node server/scripts/verify-fulfillment-release.mjs "$RELEASE_DIR"
```
