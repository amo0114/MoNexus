# 安全审计加固交接

- 任务契约见 [安全审计修复方案](fix-security-review-hardening.contract.md)。
- 本地唯一写入人为 Codex，分支为 `fix/security-review-hardening`，基线为 `develop@143a56d`。
- 已验证代码快照为 `2b17632b3cccc644b4985fcfb000f19cfa93274a`，执行时工作区干净。
- 测试使用隔离 PostgreSQL 16 的 `monexus_test_security_review` 和独立 Redis 7。未使用生产数据。

## 已完成

- 商品列表和详情缓存迁移至新的投影版本。真实 Redis 回归检查旧投影仍存在时，正常商品响应中无审核输入字段。既有可见性复核和缓存隔离用例一起通过。
- 已起草登录流量隔离、推荐字段与游标、健康探针和注册表收敛方案。

## 验证记录

| 命令 | 结果 | 快照 |
| --- | --- | --- |
| `npm --prefix server test -- src/modules/products/cacheRevocation.test.ts src/modules/products/public-fields.test.ts src/__tests__/cache.test.ts` | 退出 0，真实 Redis 模式下 17 个测试通过 | `2b17632` |
| `npm --prefix server run build` | 退出 0 | `2b17632` |
| `git diff 143a56d HEAD --check` | 退出 0 | `2b17632` |

## 待完成

- 登录策略和公开 API 契约变更等 Owner 确认范围。在现有规格的基础上补齐变更并实施。
- 当前交付为本地分支，独立审查、CI、线上镜像与边缘配置均未验证。认证策略尚未改动，未执行认证 E2E。生产核验使用已有脱敏观测。
