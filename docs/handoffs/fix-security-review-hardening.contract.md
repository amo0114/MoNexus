# MoNexus 安全审计修复方案

基线 `develop@143a56da9b5654ee25f95f263f7821574d29b7d9`。任务来源为 Owner 于 2026-11-23 要求制定方案并修复已核实的审计问题。
Owner 在会话中批准按复核结果实施，并授权推送一个修复分支和创建一个指向 `develop` 的 PR。

## 第一批 · 补齐商品审核字段脱敏

- `34e05e1` 已从列表和详情的响应序列化中移除 `guestEligibility`、`publicContentRevision` 和 `archivedAt`。数据库仍读取这些字段用于实时去留判定，缓存命中时仍可能直接使用升级前的响应数据。
- 升级列表及详情的 Redis 投影版本。店铺列表复用同一列表路径，会员与游客继续使用各自的缓存键。旧缓存依靠原有 TTL 自然淘汰。改动限于 `server/src/lib/productCatalog/publicCache.ts` 与现有 Redis 回归测试。
- 验收时在隔离 Redis 中预置旧版投影，验证新版本返回正常商品且不含三个审核字段。重跑既有分类收紧和缓存隔离用例。保留商品可售判断、库存、价格和审核规则。

## 第二批 · 登录可用性（MNX-01）

基线认证路由共用 IP 硬配额，邮箱密码失败另有独立人机验证。报告中的“三次即阻断”仍待提取既有 429 记录核实。

1. 为登录、MFA 和密码操作分配独立入口预算，保留 MFA 挑战、密码操作和刷新原有保护。登录保留按邮箱的密码失败计数、同形错误与 Redis 原子计数。
2. 登录的低摩擦 IP 配额用尽后，复用现有 `HUMAN_VERIFICATION_REQUIRED` 和 `action=login` 流程。可通过有效的单次人机证明进入独立的、有上限的密码校验预算。缺失或无效证明不做 bcrypt。邮箱与 IP 同时要求验证时只校验一次证明。验证服务或 Redis 不可用时保留受控错误语义。
3. 继续保留全局 API 防洪。普通登录和验证后的密码校验分别最多 30 次每 15 分钟，证明校验另设 120 次每分钟的独立预算。登录 ALTCHA 签发使用独立键，并提供无需依赖注册接口的公开验证配置。上线时按固定标签观察各层 429、登录成功率和共享出口容量。
4. 验收覆盖正常登录、同出口高流量下其他账号仍可通过人机验证完成登录、管理员随后能完成 MFA，以及计数并发、窗口到期、验证码重放拒绝、刷新及密码操作的兼容性。单独记录共享出口达到全局或边缘容量上限时仍可能被限流。

## 第三批 · 收敛公开接口（MNX-02/03/04）

- **商品推荐。** 公开响应保留热卖、平台自营、精选和合作伙伴徽章。分页游标改用版本化认证加密，使用与现有签名密钥用途隔离的派生密钥。服务端继续固定原排序快照并校验筛选、可见性和过期。新旧版本读到不兼容游标时均可返回原有 409，商城从第一页自动恢复，店铺通过「重新加载」恢复。长度在解析前检查。
- **健康探针。** `/api/health` 和 `/api/health/live` 对公网只提供存活状态，保留现有 HTTP 200 语义。进程运行时间使用已有受保护的监控渠道。核对外部探针是否依赖响应体，并盘点 `/api/health/ready` 的部署和外部消费方。内部 readiness 保留现有 200 / 503 和依赖诊断，公网 readiness 的细节须在确认探针迁移方式后收敛。
- **注册表。** 保留详情需要的公开模板定义、分类和显示标签。公共响应移除会员等级门槛、加成及低库存阈值。商家列表继续优先用鉴权商品接口返回的 `lowStock`。确认游客、普通会员和管理角色的公开响应，以及身份切换缓存隔离。
- 本次获批的公开响应调整体现在 OpenAPI。原行为出处为 `SPEC-MERCH-001` §6.3 和 §9、健康与配置 OpenAPI 契约，以及 `docs/specs/product-guest-visibility-ai-moderation.md` §3.4。

## 生产核验与收口

- **MNX-01** 核对部署 SHA、代理跳数、可信来源和既有 429 观测，确认命中应用全局、认证或边缘规则。使用脱敏事件及 `Retry-After` 按时间关联。共享出口回归在隔离环境完成。
- **MNX-05/07** 核对相同部署下入口与源站的 CSP 和 Cache-Control。确认重复头所属层后再移除冗余配置。保留既有前端渲染和实际使用的人机验证器所需来源。
- **MNX-06 及店铺文本渲染** 按现有保障验收。后台路由仍须通过服务端鉴权与 MFA，店铺名称和简介继续按纯文本渲染。
- 不涉及资金与交易规则、属主 404、业务时区、数据库迁移或后台任务。生产部署及边缘配置核验另行处理。

## 本地验证

- 后端 Redis 回归与接口契约运行 `npm --prefix server test -- src/modules/products/cacheRevocation.test.ts src/modules/products/public-fields.test.ts src/__tests__/cache.test.ts`，使用任务独占 PostgreSQL 和 Redis。
- 后端类型检查运行 `npm --prefix server run build`。实现登录后增跑 `src/__tests__/registration-auth-flow.test.ts`、`src/__tests__/login-failures.test.ts`、`src/__tests__/auth-mfa.test.ts`、`src/__tests__/auth-sessions.test.ts`，以及 `npm test -- src/pages/LoginPage.test.tsx` 并覆盖认证 E2E。
- 修改公开契约时运行 `npm run test:architecture`、`npm run check:architecture` 和针对 OpenAPI、游标、探针、注册表的后端集成测试。发布前对照实际镜像再次核实响应形状和生产代理指标。
