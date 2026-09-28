-- SPEC-CHAT-BOT-001 (rev 2): 绑定主路径改为「QQ 群内邮箱验证码」，不再要求
-- 用户先到网站生成绑定码。
--
-- 背景：初版让用户在网站生成 6 位码再回群里发送，但本功能的目的恰恰是服务
-- 「不来网站」的用户，构成循环依赖。签到强制 requireVerifiedEmail，因此能用
-- 签到的人邮箱必然已验证 —— 邮箱本身就是既成的身份证明链。
--
-- 表结构变更（该表在当前分支尚未发布，无历史数据需要迁移）：
--   code(明文唯一) → codeHash(sha256 唯一)：库被读也无法反推可用验证码
--   新增 platform / platformId：把验证码限定到发起绑定的那个平台账号，
--     防止 A 触发发码后 B 拿码绑定
--   新增 failedAttempts：6 位数字仅 10^6 空间，必须限次（上限 5 次，
--     触顶即 consumedAt 作废），否则可被枚举

-- DropIndex
DROP INDEX IF EXISTS "ChatBindCode_code_key";

-- AlterTable
ALTER TABLE "ChatBindCode"
  DROP COLUMN IF EXISTS "code",
  ADD COLUMN "codeHash" TEXT NOT NULL,
  ADD COLUMN "platform" TEXT NOT NULL DEFAULT 'qq',
  ADD COLUMN "platformId" TEXT NOT NULL,
  ADD COLUMN "failedAttempts" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "ChatBindCode_codeHash_key" ON "ChatBindCode"("codeHash");

-- CreateIndex
CREATE INDEX "ChatBindCode_platform_platformId_idx" ON "ChatBindCode"("platform", "platformId");
