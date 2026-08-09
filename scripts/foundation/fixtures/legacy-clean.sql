-- FND-CMI-001 F0 — legacy-clean historical fixture.
--
-- Loaded into a database sitting at the frozen PRE-F0 migration head
-- (56 migrations, no F0 wave). It represents real historical production
-- shape: four legacy types, an unknown type, an empty type, an active
-- no-image product, a multi-Offer product and Xboard (faka_bridge) Offers.
--
-- Counts (used by the conservation check):
--   users=3, merchants=1, products=9, offers=12, inventory_items=5,
--   orders=3, inventory_logs=3
--
-- All values are fixed test-only material; no secrets, no real merchant data.

-- users (admin / merchant owner / buyer)
INSERT INTO "User" ("email", "password", "role", "status", "nickname") VALUES
  ('admin-legacy@test.local',   'test-password-x', 'admin',    '正常', '历史管理员'),
  ('merchant-legacy@test.local','test-password-x', 'merchant', '正常', '历史商家主'),
  ('buyer-legacy@test.local',   'test-password-x', 'user',     '正常', '历史买家');

-- merchant
INSERT INTO "Merchant" ("userId", "name", "status", "commissionRate", "updatedAt")
VALUES (2, '历史商家', 'active', 0.10, now());

-- products (9)
-- P1..P4 = exact four legacy types; P5 unknown; P6 empty; P7 active no-image;
-- P8 multi-Offer; P9 Xboard offer.
INSERT INTO "Product"
  ("name", "type", "icon", "price", "stock", "sales", "status", "deliveryMode", "stockMode", "merchantId", "createdAt")
VALUES
  ('历史网络节点', '网络节点', 'package', 1000, 10, 0, 'active',   'instant_inventory', 'limited', 1, now() - interval '90 days'),
  ('历史共享账号', '共享账号', 'package', 2000, 10, 0, 'active',   'instant_inventory', 'limited', 1, now() - interval '80 days'),
  ('历史充值卡密', '充值卡密', 'package', 3000, 10, 0, 'active',   'instant_inventory', 'limited', 1, now() - interval '70 days'),
  ('历史邀请码',   '邀请码',   'package', 4000, 10, 0, 'inactive', 'instant_inventory', 'limited', 1, now() - interval '60 days'),
  ('未知类型商品', '未知类型XYZ', 'package', 5000, 10, 0, 'active', 'instant_inventory', 'limited', 1, now() - interval '50 days'),
  ('空类型商品',   '',         'package', 6000, 10, 0, 'active',   'instant_inventory', 'limited', 1, now() - interval '40 days'),
  ('无图活跃商品', '网络节点', 'package', 7000, 10, 0, 'active',   'instant_inventory', 'limited', 1, now() - interval '30 days'),
  ('多规格商品',   '充值卡密', 'package', 8000, 20, 0, 'active',   'instant_inventory', 'limited', 1, now() - interval '20 days'),
  ('Xboard商品',   '网络节点', 'package', 9000, 10, 0, 'active',   'instant_inventory', 'limited', 1, now() - interval '10 days');

-- offers (12): one default per product + a second default-free offer on P8 and
-- two Xboard (faka_bridge) offers on P9/P3 with non-canonical SKU casing that
-- migration 3 canonicalizes to lower(btrim(...)).
INSERT INTO "Offer"
  ("productId", "name", "price", "status", "deliveryMode", "stockMode", "stock",
   "isDefault", "externalIntegration", "externalSku", "createdAt")
VALUES
  (1, '默认规格', 1000, 'active', 'instant_inventory', 'limited', 10, true,  NULL, NULL, now() - interval '90 days'),
  (2, '默认规格', 2000, 'active', 'instant_inventory', 'limited', 10, true,  NULL, NULL, now() - interval '80 days'),
  (3, '默认规格', 3000, 'active', 'instant_inventory', 'limited', 10, true,  NULL, NULL, now() - interval '70 days'),
  (4, '默认规格', 4000, 'active', 'instant_inventory', 'limited', 10, true,  NULL, NULL, now() - interval '60 days'),
  (5, '默认规格', 5000, 'active', 'instant_inventory', 'limited', 10, true,  NULL, NULL, now() - interval '50 days'),
  (6, '默认规格', 6000, 'active', 'instant_inventory', 'limited', 10, true,  NULL, NULL, now() - interval '40 days'),
  (7, '默认规格', 7000, 'active', 'instant_inventory', 'limited', 10, true,  NULL, NULL, now() - interval '30 days'),
  (8, '默认规格', 8000, 'active', 'instant_inventory', 'limited', 20, true,  NULL, NULL, now() - interval '20 days'),
  (8, '月卡规格', 8500, 'active', 'instant_inventory', 'limited',  5, false, NULL, NULL, now() - interval '19 days'),
  (9, '默认规格', 9000, 'active', 'instant_inventory', 'limited', 10, true,  NULL, NULL, now() - interval '10 days'),
  (9, 'Xboard订阅', 9500, 'active', 'manual_service', 'limited', 10, false, 'faka_bridge', '  XBOARD-SKU-A  ', now() - interval '9 days'),
  (3, 'Xboard订阅2', 9600, 'active', 'manual_service', 'limited', 10, false, 'faka_bridge', 'Xboard-Sku-B', now() - interval '8 days');

-- inventory items (5)
INSERT INTO "InventoryItem" ("productId", "offerId", "content", "status", "createdAt") VALUES
  (1, 1, 'LEGACY-CARD-0001', 'available', now() - interval '90 days'),
  (2, 2, 'LEGACY-CARD-0002', 'available', now() - interval '80 days'),
  (3, 3, 'LEGACY-CARD-0003', 'available', now() - interval '70 days'),
  (8, 8, 'LEGACY-CARD-0004', 'available', now() - interval '20 days'),
  (8, 8, 'LEGACY-CARD-0005', 'available', now() - interval '20 days');

-- orders (3)
INSERT INTO "Order" ("userId", "productId", "offerId", "price", "status", "merchantId", "createdAt") VALUES
  (3, 1, 1, 1000, 'delivered', 1, now() - interval '80 days'),
  (3, 2, 2, 2000, 'delivered', 1, now() - interval '70 days'),
  (3, 8, 8, 8000, 'closed',    1, now() - interval '15 days');

-- inventory logs (3) — import actions (delta > 0, orderId null, batchId set)
INSERT INTO "InventoryLog" ("productId", "offerId", "merchantId", "actorUserId", "action", "delta", "batchId", "createdAt") VALUES
  (1, 1, 1, 1, 'import', 1, '00000000-0000-0000-0000-000000000001', now() - interval '90 days'),
  (2, 2, 1, 1, 'import', 1, '00000000-0000-0000-0000-000000000002', now() - interval '80 days'),
  (8, 8, 1, 1, 'import', 2, '00000000-0000-0000-0000-000000000003', now() - interval '20 days');
