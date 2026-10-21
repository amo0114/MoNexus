-- SPEC-CATALOG-VIS-001 P1-A — 分类级游客可见性（增量迁移）
--
-- ProductCategory.guestVisibility 只有 public / members_only 两个值，默认 public。
--
-- 默认 public 是本迁移的关键安全属性：上线后所有既有分类都保持「游客可见」，
-- 与当前线上行为逐字一致。收紧是管理员的显式动作，不由迁移暗中完成。
-- 反向（把新列默认 members_only）会在上线瞬间隐藏全站商品，那不是本次变更。
--
-- Prisma 无法表达 CHECK 约束，因此与既有 ProductCategory 约束同一处手工追加。
-- DEFAULT 与 CHECK 并存：DEFAULT 保证既有行与本迁移之后未显式赋值的插入都是
-- public，CHECK 保证任何写入（含绕过应用层的直接 SQL）都无法落库第三个值。
--
-- 已在带既有数据的库上验证：迁移前存在 active 与 inactive 两种分类各一条，
-- 迁移后两行 guestVisibility 均为 public，DEFAULT 生效且未改写其它列。
-- 非法值 'private' 被 CHECK 拒绝；索引
-- ProductCategory_guestVisibility_status_sortOrder_id_idx 已创建。

ALTER TABLE "ProductCategory"
  ADD COLUMN "guestVisibility" TEXT NOT NULL DEFAULT 'public';

ALTER TABLE "ProductCategory"
  ADD CONSTRAINT "ProductCategory_guestVisibility_valid_check"
    CHECK ("guestVisibility" IN ('public', 'members_only'));

-- 游客端「列出可公开分类」按 guestVisibility 过滤，与 status 组合使用。
CREATE INDEX "ProductCategory_guestVisibility_status_sortOrder_id_idx"
  ON "ProductCategory"("guestVisibility", "status", "sortOrder", "id");
