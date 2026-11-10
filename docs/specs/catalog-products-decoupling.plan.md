# `catalog` 与 `products` 解耦拆分方案

| 项目 | 内容 |
| --- | --- |
| 文档 ID | `PLAN-CATALOG-PRODUCTS-DECOUPLING-001` |
| 版本 | `1.0.0` |
| 日期 | 2026-11-10 |
| 状态 | 已确认两个 PR 都做；PR 1（单元 A + B）实施中，PR 2 待实施 |
| 核验基线 | `origin/develop@63e1b83` |
| 范围 | 仅后端 `server/src`；不改接口、不改数据库、不改业务行为 |
| 工程规范 | [分支与 CI](../branching-and-ci.md)、[测试政策](../testing-policy.md) |

## 1. 结论

`products`（公开读取）和 `catalog`（商品写入与治理）之间的双向依赖，绝大部分不是业务上的互相调用，而是两边都把**公共定义**放在了自己目录里，对方只好反向 import。把这些公共定义下沉到 `server/src/lib/productCatalog/`，`catalog → products` 的依赖可以从 12 处降到 0。

需要先说明一点预期：只做下沉，后端那个 16 个模块互相成环的大环**不会变小**。`products` 还会被另一条路径留在环里（`points` 的路由文件挂载了 `chatbot` 的控制器，`chatbot` 又依赖 `products`）。要让大环真正缩小，还要改两处路由挂载。两步都做完，大环从 16 个模块降到 10 个，剩下的 10 个正是订单、履约、Xboard 那一组，属于另外的专项。

| 阶段 | `catalog → products` | 依赖 `products` 的模块数 | 大环模块数 |
| --- | --- | --- | --- |
| 现状 | 12 处 | 14 | 16 |
| 单元 A + B（下沉公共定义） | 0 | 3（`shops`、`storefront`、`chatbot`） | 16 |
| 单元 C（路由挂载归位） | 0 | 3 | 10 |

以上数字来自对基线代码的静态 import 模拟（把待迁移文件视为已移到 `lib`、把待删的挂载边去掉后重算），不含测试文件。

## 2. 现状

### 2.1 `catalog → products`（12 处，全部是公共定义）

| 被引用文件 | 引用方 | 内容 |
| --- | --- | --- |
| `products/cache.ts` | `catalog` 内 6 个文件 | `invalidateProductPublicCache`，写商品后让公开缓存失效 |
| `products/visibility.ts` | `catalog` 内 4 处 | `CATEGORY_GUEST_VISIBILITY` 常量与类型 |
| `products/schema.ts` | `catalog` 内 2 个文件 | 商品名称、描述、价格的字段校验 |

### 2.2 `products → catalog`（8 处）

| 被引用文件 | 引用方 | 性质 |
| --- | --- | --- |
| `catalog/templates/types.ts`、`registry.ts`、`productDetails.ts` | `products/service.ts`、`recommendations.ts` | 公共定义（商品模板） |
| `catalog/constants.ts` | `products/shareLinks.ts` | 公共定义（错误码） |
| `catalog/readinessOffer.ts` | `products/publicAvailability.ts` | 业务调用（规格是否可售） |
| `catalog/assurance/service.ts` | `products/service.ts` | 业务调用（读取保障信息） |

最后两项是读模块调用写模块的查询函数，方向合理，保留。

### 2.3 这些文件其实是全局公共件

| 文件 | 行数 | 模块外引用处 | 引用它的模块 | 自身依赖 |
| --- | --- | --- | --- | --- |
| `products/visibility.ts` | 244 | 26 | 10 个 | Prisma、`lib/httpError`、`middlewares/auth`（仅类型） |
| `products/cache.ts` | 149 | 18 | 6 个 | `config`、`lib/cache` |
| `products/schema.ts` | 103 | 4 | `catalog`、`merchant`、`admin` | zod、`lib/businessRegistry` |
| `catalog/templates/types.ts` | 130 | 8 | `admin`、`orders`、`products`、脚本 | 无 |
| `catalog/templates/registry.ts` | 196 | 3 | `products`、脚本 | 同目录 |
| `catalog/templates/productDetails.ts` | 61 | 1 | `products` | zod、同目录 |
| `catalog/templates/fulfillmentStrategy.ts` | 206 | 1 | `orders` | 同目录 |
| `catalog/constants.ts` | 158 | 9 | `admin`、`products` | 无 |

这些文件都不依赖任何业务模块，可以直接移动。

### 2.4 把 `products` 留在大环里的路由挂载

- `points/routes.ts` 引入 `chatbot/bindController`，用来挂 `GET /api/points/chat-bind/status` 和 `DELETE /api/points/chat-bind`。
- `orders/routes.ts` 引入 `reviews/controller`，挂 `POST|PUT /api/orders/:id/review`。
- `products/routes.ts` 引入 `reviews/controller`，挂 `GET /api/products/:id/reviews`。

这三处是“路由文件替别的模块挂接口”，业务逻辑并不互相依赖。

## 3. 目标结构

新增目录 `server/src/lib/productCatalog/`，只放不依赖业务模块的公共定义：

| 新位置 | 来源 | 说明 |
| --- | --- | --- |
| `lib/productCatalog/templates/`（`types.ts`、`registry.ts`、`productDetails.ts`、`validate.ts`、`fulfillmentStrategy.ts`、`definitions.json` 及各自的测试） | `catalog/templates/` | `routes.ts` 及其测试留在 `catalog/templates/` |
| `lib/productCatalog/constants.ts` | `catalog/constants.ts` | 整体移动 |
| `lib/productCatalog/visibility.ts` | `products/visibility.ts` | 整体移动；对 `middlewares/auth` 保持仅类型引用 |
| `lib/productCatalog/publicCache.ts` | `products/cache.ts` | 整体移动 |
| `lib/productCatalog/fieldSchemas.ts` | `products/schema.ts` 中的字段校验与长度常量 | `listProductsQuerySchema`、`productSummariesQuerySchema` 两个查询 DTO 留在 `products/schema.ts` |

约定：

- 不留兼容转发文件，所有引用处一次改到新路径。
- 只移动和改 import，不改函数签名、不重命名导出、不调整逻辑。

## 4. 实施单元

### 单元 A：模板与常量下沉

1. 移动 `catalog/templates/` 下除 `routes.ts`、`routes.test.ts` 之外的文件，以及 `catalog/constants.ts`。
2. 更新引用：模块外约 22 处，`catalog` 内部约 68 行。
3. 检查 `server/src/scripts` 与 `server/src/prisma` 下的引用（基线中有脚本引用 `templates/types`、`templates/registry`）。

### 单元 B：可见性、缓存、字段校验下沉

1. 移动 `products/visibility.ts`、`products/cache.ts`。
2. 拆分 `products/schema.ts`：字段校验移到 `fieldSchemas.ts`，两个查询 DTO 留下。
3. 更新引用：模块外约 48 处。
4. 逐个核对测试里的 `vi.mock('…/products/cache.js')`、`vi.mock('…/products/visibility.js')`。路径不改的话 mock 会静默失效，测试可能仍然通过但不再覆盖原意。

### 单元 C：路由挂载归位

1. `chatbot` 导出自己的绑定状态路由，由 `app.ts` 挂到 `/api/points/chat-bind`；`points/routes.ts` 删除对 `chatbot` 的引用。
2. `reviews` 导出自己的路由，由 `app.ts` 挂载 `/api/orders/:id/review` 和 `/api/products/:id/reviews`；`orders/routes.ts`、`products/routes.ts` 删除对 `reviews` 的引用。
3. 路径、方法、中间件链必须与现状逐项一致，包括登录校验、`requireVerifiedEmail`、参数校验的顺序。

单元 C 的风险在 `app.ts` 的挂载顺序：现有约束是推广路由在 `products/:id` 之前。新挂的评价路由不能抢在这些路由之前匹配，也不能被 `products/:id` 抢先匹配。

### 架构检查

在 `scripts/architecture-rules.mjs` 增加两条规则，防止回退（“`lib` 不得引用业务模块”已由现有规则覆盖）：

- `modules/catalog/` 不得运行时引用 `modules/products/`。
- `modules/points/` 不得引用 `modules/chatbot/`（单元 C 完成后启用）。

每条规则在 `scripts/architecture-rules.test.mjs` 补一个通过用例和一个违规用例。

实施时核对：基线中没有任何测试 mock 被移动的文件，单元 B 第 4 步的风险不成立。

## 5. PR 划分

| PR | 内容 | 是否带 `run-e2e` |
| --- | --- | --- |
| PR 1 | 单元 A + B，附第一条架构规则 | 否（纯移动，无行为变化） |
| PR 2 | 单元 C，附第二条架构规则 | 是（改动路由挂载，涉及登录中间件链） |

PR 1 是纯机械改动，可以先合。PR 2 有行为风险，单独评审。

## 6. 验证

PR 1：

- `npm --prefix server run build`（类型检查加注册表运行时导入）。
- `npm run check:architecture` 与 `npm run test:architecture`。
- 后端定向测试：随文件移动的模板测试、`products` 与 `catalog` 目录下的测试、游客可见性相关测试。
- 全量后端测试交给 CI。
- 合并前后各跑一次第 1 节的 import 统计，确认 `catalog → products` 为 0。

PR 2 在 PR 1 的基础上增加：

- 动手前先确认这 5 个接口各有集成测试覆盖正常路径与未登录路径；缺的先补，再改挂载。
- 评价相关与签到绑定相关的后端集成测试。
- CI 上的 E2E。

## 7. 风险

| 风险 | 处理 |
| --- | --- |
| 改动面大（约 140 行 import），与并行分支冲突 | PR 1 尽快合并；开工前确认没有正在改 `catalog/templates`、`products/visibility` 的分支 |
| 测试里的 mock 路径失效但测试仍通过 | 单元 B 第 4 步逐个核对；对关键用例临时改坏实现，确认测试会失败 |
| 单元 C 改变路由匹配顺序或漏掉中间件 | 先补集成测试再改；逐项对照现有中间件链 |
| `lib` 反向依赖业务模块，下沉失去意义 | 第一条架构规则强制禁止 |

## 8. 不在本方案范围

- `products/service.ts`（965 行）与 `orders/service.ts`（1246 行）的内部拆分。
- `orders`、`fulfillment`、`catalog/platformFulfillment.ts` 之间的互相调用。
- Xboard 与发卡逻辑从核心模块中剥离。
- `payment` 与 `recharge` 的边界。
- `products → catalog` 保留的两处查询调用（`readinessOffer`、`assurance/service`）。
