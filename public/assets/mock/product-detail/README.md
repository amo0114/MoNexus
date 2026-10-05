# 商品详情页 mock 图片

从用户提供的 `/root/program/shopexample/shopinfo.png`（1536 × 1024）按原始像素裁切；未重绘、补全或放大。

页面引用路径：`/assets/mock/product-detail/<文件名>.png`。裁切坐标、尺寸及用途见 `manifest.json`。

## 接入注意

- `hero.png` 已包含宣传文字、左右切换按钮、页码；接入时避免重复叠加控件。它是带界面的截图裁片，并非干净的商品原图。
- `thumb-video.png` 已含播放图标，仅供封面占位，没有实际视频。
- `thumb-more.png` 已含遮罩与 `+3`。
- `platform-banner-visible.png` 只有截图可见的上半部分，底部设备画面被截断。
- 缩略图和推荐封面分辨率较低，适合接近原尺寸显示；不适合作为高清大图。
- 矩形裁片的部分圆角含截图背景像素，适用于参考图的浅色背景。

| 文件 | 原始尺寸 | 内容 |
| --- | --- | --- |
| `hero.png` | 515 × 444 | 商品主图；已含宣传文字、左右切换按钮及 1 / 6 页码。 |
| `thumb-mountain.png` | 72 × 59 | 雪山缩略图；避开外层蓝色选中描边。 |
| `thumb-video.png` | 74 × 55 | 视频封面占位图；已含播放按钮，无视频文件。 |
| `thumb-app.png` | 74 × 59 | 软件界面缩略图。 |
| `thumb-map.png` | 74 × 59 | 世界地图缩略图。 |
| `thumb-landscape.png` | 74 × 59 | 风景缩略图。 |
| `thumb-more.png` | 74 × 59 | 更多图片占位图；已含暗色遮罩及 +3 文字。 |
| `related-basic.png` | 77 × 78 | Aster Link 基础套餐封面。 |
| `related-pro.png` | 77 × 78 | 全球加速 Pro 封面。 |
| `related-gaming.png` | 77 × 80 | 轻量游戏专线封面。 |
| `platform-banner-visible.png` | 1037 × 119 | 多设备·全平台支持横幅；截图底部截断，仅包含可见部分，已含文字及平台图标。 |
