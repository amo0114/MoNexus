-- Synthetic fixture for the pre-governance schema; disposable database only.
INSERT INTO "User" (email,password,role,status,"createdAt") VALUES ('legacy-admin@example.test','never-a-password','admin','正常','2026-10-01'),('legacy-banned@example.test','never-a-password','user','已封禁','2026-10-02'),('legacy-merchant@example.test','never-a-password','merchant','正常','2026-10-03'),('legacy-buyer@example.test','never-a-password','user','正常','2026-10-04');
INSERT INTO "Merchant" ("userId",name,status,"updatedAt") SELECT id,'历史商家','active',CURRENT_TIMESTAMP FROM "User" WHERE email='legacy-merchant@example.test';
INSERT INTO "ProductCategory" (code,label,"normalizedLabel","createdByUserId","updatedByUserId","updatedAt") SELECT 'governance-test','网络节点','网络节点',id,id,CURRENT_TIMESTAMP FROM "User" WHERE role='admin';
INSERT INTO "Product" (name,type,price,"categoryId","merchantId","createdAt") SELECT '历史商品',c.label,100,c.id,m.id,'2026-09-30 16:30:00' FROM "ProductCategory" c CROSS JOIN "Merchant" m LIMIT 1;
INSERT INTO "Offer" ("productId",name,price) SELECT id,'默认规格',100 FROM "Product";
INSERT INTO "Order" ("userId","productId","offerId",price,status,"merchantId","createdAt") SELECT u.id,p.id,o.id,100,'completed',p."merchantId",'2026-09-30 16:30:00' FROM "User" u CROSS JOIN "Product" p CROSS JOIN "Offer" o WHERE u.email='legacy-buyer@example.test';
INSERT INTO "SettlementBatch" ("requestKey","requestHash","createdByUserId","itemCount","totalPoints","createdAt") SELECT 'legacy-batch',repeat('a',64),id,1,0,'2026-09-30 16:30:00' FROM "User" WHERE role='admin';
INSERT INTO "OrderAfterSalesCase" ("orderId",reason,"createdByUserId","updatedAt","createdAt") SELECT o.id,'历史售后',u.id,CURRENT_TIMESTAMP,'2026-09-30 16:30:00' FROM "Order" o CROSS JOIN "User" u WHERE u.role='admin';
