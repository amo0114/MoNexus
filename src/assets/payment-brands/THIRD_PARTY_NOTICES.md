# Payment brand assets — third-party notices

Retrieval date: 2026-09-02.

These files are official vendor brand materials bundled at build time.
Runtime code must not fetch brand marks from external URLs.

## WeChat Pay / 微信支付

- Source page: https://pay.weixin.qq.com/material/brand.shtml
- Direct zip: https://material-10005922.file.myqcloud.com/common/brand.zip
- Material rules: https://pay.weixin.qq.com/static/material/material_rules.shtml
- Original path in zip (GBK names):
  `brand/品牌基础物料/04微信支付logo源文件/线上RGB模式/微信支付中文标识.png`
- Files:
  - `wechat-pay-zh-identifier.png` — unmodified official RGB Chinese identifier sheet.
  - `wechat-pay-zh.png` — viewBox crop of the stacked 中文标识 lockup (green Pay mark + 微信支付) from that sheet, light RGB, no recolor, stretch, or redraw. Used only as the QR center mark.

Do not substitute WeChat chat icons or icon-pack trademarks.

## Alipay / 支付宝支付 — BLOCKED_CONCERN

No standalone official Alipay **payment** mark is shipped in this PR.

Attempted sources on 2026-09-02:

1. Official 支付界面规范: https://opendocs.alipay.com/open/01apj2
   Page advertises `支付宝收银台视觉规范和素材.zip`. The document is a JavaScript SPA; no direct zip URL was retrieved.
2. Koubei restaurant pack (candidate): https://render.alipay.com/p/f/fd-iq34yyrt/index
   Zip: https://os.alipayobjects.com/rmsportal/QTMnazwZvQvUBAs.zip
   Visual review: table-card/promo collages, wifi/menu wayfinding, and a composite AI (`支付宝源logo，口碑logo.ai`) whose PDF preview is empty. One poster includes 支 + 口碑 + 饿了么 together. None is a standalone official 支 payment mark.

Alipay QR therefore renders **without** a center image. Do not copy similar marks from icon libraries.
