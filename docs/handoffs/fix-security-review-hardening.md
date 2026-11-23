# 安全审计加固交接

- 任务契约见 [安全审计修复方案](fix-security-review-hardening.contract.md)。
- 基线为 `develop@143a56d`。本地实施分支为 `fix/security-review-hardening`，发布线程从实施提交创建 PR 分支。
- 最新实现快照为 `162fcc7809f74d8df20e254a2a4f58efc694ba10`。
- 测试使用隔离 PostgreSQL 16 的 `monexus_test_security_review`、`monexus_test_security_browser` 及独立 Redis 7，使用合成数据。

## 已完成

- 商品列表和详情缓存迁移至新的投影版本。真实 Redis 回归检查旧投影仍存在时，正常商品响应中无审核输入字段。既有可见性复核和缓存隔离用例一起通过。
- 已隔离登录、MFA、密码操作和登录挑战签发预算。普通登录进入人机验证后，证明与密码校验分别保留预算。
- 收敛商品徽章投影并切换认证加密的分页游标。移除公开存活探针中的运行时间与时间戳，以及注册表中客户端不需要的运营配置。

## 验证记录

| 命令 | 结果 | 快照 |
| --- | --- | --- |
| `npm --prefix server test -- src/modules/products/cacheRevocation.test.ts src/modules/products/public-fields.test.ts src/__tests__/cache.test.ts` | 退出 0，真实 Redis 模式下 17 个测试通过 | `2b17632` |
| `npm --prefix server run build` | 退出 0 | `2b17632` |
| `git diff 143a56d HEAD --check` | 退出 0 | `2b17632` |
| `npm --prefix server test -- src/__tests__/registration-auth-flow.test.ts src/__tests__/login-failures.test.ts src/__tests__/human-verification-altcha.test.ts src/__tests__/health-endpoints.test.ts --reporter=dot` | 退出 0，36 项通过 | `162fcc7` 的源码 |
| `npm --prefix server run build`、`npm run build` | 均退出 0 | `162fcc7` 的对应端源码 |
| `npm test -- src/pages/LoginPage.test.tsx src/pages/StorePage.cmi.test.tsx src/pages/ShopPage.test.tsx src/components/merchant/dashboard/MerchantProductsPanel.test.tsx src/components/merchandising/badges.test.ts src/components/merchandising/forbiddenWords.test.tsx src/components/store/StoreProductCard.test.tsx src/api/registry.cacheIsolation.test.ts src/stores/registryIdentitySwitch.test.ts --maxWorkers=2` | 退出 0，65 项通过 | `162fcc7` 的前端行为 |
| `playwright test e2e/registration-abuse-prevention.spec.ts --grep 'asks for a login proof' --workers=1` | 退出 0，Chromium 用例通过 | `162fcc7` 的浏览器用例 |
| `npm run test:architecture`、`npm run check:architecture` | 均退出 0 | `162fcc7` 的模块边界和 API 契约 |

联合后端回归覆盖 13 个文件。运行期间调整了登录证明前置配额，首次联合运行中其余 112 项通过，唯一失败项为运行期间变动的登录用例。上表的最终版认证复跑已通过该用例。

## 待完成

- 同一个 PR 送交独立审查及 CI。生产镜像、429 上游来源、外部探针消费者和边缘响应头仍待核实。
