BEGIN;

ALTER TABLE "User" ADD COLUMN "nicknameIsGenerated" BOOLEAN NOT NULL DEFAULT false;

-- 用户确认将历史 mn_XXXXXXXX 视作旧默认昵称；历史数据没有手动来源记录。
-- 只执行一次，之后不按格式推断来源。已保存头像和其他昵称不变。
-- 固定 v1 词表，与 lib/defaultNickname.ts 的 ID 回退保持一致。
WITH words AS (
  SELECT ARRAY[
    '爱喝茶的', '追风的', '爱晒太阳的', '慢悠悠的',
    '爱吃桃的', '听雨的', '踏月的', '爱看云的',
    '捧着西瓜的', '悠闲的', '爱讲故事的', '正在摸鱼的',
    '打着盹的', '笑眯眯的', '爱种花的', '乘风的',
    '爱散步的', '抱着锦囊的', '爱写诗的', '等东风的',
    '早起的', '爱赏月的', '爱下棋的', '路过的',
    '背着行囊的', '爱吃面的', '数星星的', '摇着羽扇的',
    '爱听琴的', '看热闹的', '爱游山的', '满载而归的'
  ] AS prefixes, ARRAY[
    '小军师', '桃园客', '小都督', '卧龙学徒',
    '赤壁钓客', '江东旅人', '蜀中闲客', '锦囊匠',
    '竹林客', '云游书生', '青梅居士', '羽扇先生',
    '白马骑手', '星河剑客', '麦田守望者', '铜雀诗人',
    '东风信使', '山野琴师', '小先锋', '行路人',
    '桃花剑客', '煮茶先生', '观星客', '江畔渔夫',
    '小谋士', '听雨书生', '月下旅人', '青山隐士',
    '洛阳食客', '成都茶客', '石桥棋友', '草庐主人'
  ] AS roles
), candidates AS (
  SELECT id, (((id::bigint - 1) * 37) % 1024)::int AS slot
  FROM "User"
  WHERE nickname IS NULL OR btrim(nickname) = '' OR btrim(nickname) ~ '^mn_[2-9A-HJ-NP-Z]{8}$'
)
UPDATE "User" u
SET nickname = words.prefixes[(c.slot % 32) + 1] || words.roles[(c.slot / 32) + 1],
    "nicknameIsGenerated" = true
FROM words, candidates c
WHERE u.id = c.id;

COMMIT;
