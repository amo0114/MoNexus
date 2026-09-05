-- PR-3：买家「进行中」订单红点权威计数（COUNT by userId + status）的支撑索引。
CREATE INDEX "Order_userId_status_idx" ON "Order"("userId", "status");
