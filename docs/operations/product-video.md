# 商品展示视频运行说明

实现分支 `feat/product-showcase-video`，独立目录 `/root/projects/worktrees/monexus-product-showcase-video`。基线叠加 P1.5-A `e226d6a`（其远程分支尚未合并 develop）；合并前需按 P1/P1.5 的最终契约重新集成。原工作区的既存修改未带入。

## 使用和权限

商家创建/编辑、管理员创建平台商品/编辑商品均有“商品视频”控件。上传只生成待关联资产；保存才修改商品。替换失败保留原视频，移除后也要保存。每商品一个视频，视频资产不能跨商品或跨经营主体关联。管理员代商家上传使用该商品 merchantId。

普通详情首屏使用原封面，点击后获取 180 秒播放凭证；原生控件再次点击播放，默认静音，可打开声音。列表和分享封面沿用图片。图库图片灯箱不包含视频。

视频的新增、替换、移除与商品内容 CAS、公开审核失效在同一事务完成。游客签发复用分类、生命周期及当前版本批准门禁；登录用户复用 member 门禁。审批人员从管理员编辑页完整预览并听取音频后，使用 P1.5 的版本 CAS 审批；P1.5-B 审核工作台需复用 `ProductVideoPlayer actor="admin"` 和编辑 DTO，不能仅看缩略图批准。视频分支没有另建一套审核控制台。

## 部署参数

生产 Compose 默认关闭以下开关；完成实际部署环境验收后由部署配置启用：

```dotenv
PRODUCT_VIDEO_UPLOAD_ENABLED=false
PRODUCT_VIDEO_PLAYBACK_ENABLED=false
```

仅设置为 `false` 才暂停；本地直接运行的缺省值为启用。开关不删除数据，也不撤回已签发 URL/已下载字节。关闭上传不影响现有播放；关闭签发不影响图片与购买。

上传要求运行用户可执行 `prlimit`、`ffprobe` 和 `ffmpeg`。runtime Alpine 镜像安装发行版 `ffmpeg`、`util-linux`；需随镜像更新安全补丁，并记录实际版本。应用用户为非 root。`GET /api/admin/product-videos/health`（active admin + MFA）单独返回工具可用性、两个开关和进程忙状态，不影响整站 ready。

固定预算：40 MiB 文件、60 秒、H.264 yuv420p SDR MP4、长边≤1920/短边≤1080、≤60fps、方形像素；AAC-LC ≤2声道且≤48kHz或无音轨。不接受外链、额外轨道或任意转码。全量解码验证后 stream copy/faststart，生成≤640尺寸且≤512KiB JPEG。请求总240秒、接收120秒、媒体处理合计60秒、对象写入合计60秒。媒体子进程地址空间768MiB、CPU60秒，输出日志128KiB，单进程仅一个请求。临时盘上传前至少512MiB可用；主体1个处理中、最多5个未关联 ready 资产。

仓库 Nginx 对精确上传路径放宽45MiB、关闭请求缓冲、对齐超时。生产外层 1Panel/OpenResty/CDN 还需单独核实请求体上限、120秒接收和240秒处理预算；默认 Node requestTimeout 为300秒，不要将其配置为小于应用预算。多实例扩容前重新测量容量，此实现没有跨实例全局 CPU 队列。

临时文件仅在 `PRODUCT_VIDEO_TEMP_ROOT` 内创建和回收，不扫描系统 `/tmp`。Compose 默认 `/tmp/monexus-product-videos/uploads`；直接运行时按服务工作目录派生隔离路径。不同 worktree 或同主机多个实例如自定义此值，必须使用不同目录。请求中断（包括上传结束后断开响应）会取消处理。

媒体子进程的单文件写入上限为64MiB（`RLIMIT_FSIZE`），避免封装异常在最终40MiB检查前耗尽磁盘；输入仍独立限40MiB，海报最终限512KiB。

## 私有存储和日志

复用现有 private bucket；对象固定为 `product-videos/v1/{UUID}/video.mp4` 和 `poster.jpg`。位置绑定上传开始时的 provider，切换 active provider 不会改变已有视频的读桶。禁止桶匿名读；不改付费交付的 attachment/octet-stream 签名。

签发 JSON 和对象均 private/no-store。签名 URL 是临时持有者凭证，可在180秒内转发；撤销审核/退出登录只阻止新授权，不能撤回旧链接和已下载字节。前端在身份、会话、商品和资产变化时取消请求、暂停并移除 src。

仓库私有桶反代及开发签名路径关闭 access log；应用日志将开发签名路径替换为 redacted。外层网关、provider 访问日志和错误平台也必须移除完整查询串/签名路径，HTTPS、Host、原路径/查询串不得改写。跨域 provider 按需允许 Range，不能以公开桶解决播放器跨域错误。

## 清理、备份和回滚

付费附件 GC 仅处理64位SHA-256加短扩展名；跳过视频和未知对象。视频 GC 先锁资产复查无商品引用，再置 deleting、事务外删除；失败保留记录重试。已关联/归档商品仍有引用时不删。未关联资产宽限24小时，过期 uploading 10分钟标失败；孤儿严格按视频目录/UUID查库后回收，DB故障保留对象。残留本地临时目录超过10分钟后回收。

Portable backup 新导出为 v3：使用与 pg_dump 相同的 Repeatable Read 快照，按资产绑定 provider 流式导出视频/海报，核对大小/SHA-256。恢复到目标 env 私有桶；v3 的数据库恢复、视频清单匹配检查及 provider 重绑在同一个 PostgreSQL事务完成，清单不匹配整体回滚。恢复前禁止覆盖已有对象；数据库提交前失败会补偿本次对象。v1/v2 继续支持；旧工具拒绝 v3。恢复仅向空实例执行。

已有可移植备份的公开图片/付费附件路径仍有历史 provider 轮换限制：旧付费导出仅枚举当前写桶，旧恢复不重绑历史 provider。本文的跨桶演练使用 env 底座，不能据此声称历史 provider 轮换恢复已验证。存在此部署情形时先修复并演练，禁止把该备份当作完整灾备。

回滚先关上传/签发，保留新增表、引用和对象。不可直接回到会将视频当无引用附件删除的旧 GC；必须先停旧清理任务。不要用破坏性 migration down 或删桶回滚。

## 可复现验证

Node22/npm10，独立可丢弃 PostgreSQL；禁止与其他 worktree 共用清表测试库。

```bash
TEST_DATABASE_URL=<disposable-db> npm --prefix server test -- src/modules/productVideos/productVideos.test.ts
npm test -- src/components/catalog/ProductVideoPlayer.test.tsx src/components/merchant/ProductVideoUploader.test.tsx
```

`server/scripts/product-video-storage-integration.ts` 验证真实隔离 MinIO：匿名403、inline MIME、no-store、Range206/416、篡改/过期403，付费下载仍attachment。

`server/scripts/product-video-backup-integration.ts` 从 server 目录运行，要求 `VIDEO_BACKUP_SOURCE_URL`、`VIDEO_BACKUP_TARGET_URL` 两个独立且空的已迁移数据库，名称必须以 `monexus_video_backup_` 开头。默认连接 localhost:19380 的隔离 MinIO；脚本创建专用桶并只清理自身桶。包含加密导出、篡改清单回滚、恢复原包、授权Range播放、付费附件字节核对。数据库由操作者事后清理。

## 本地验证记录（2026-10-22）

- 全新库105个迁移通过；从 P1.5 的104个迁移、含已批准商品的数据升级通过，原商品视频引用为空、批准版本保持不变。
- 前端全量205文件/1720用例通过；最终视频、真实 Redis 缓存及付费存储回归5文件/51用例通过。较早的商品写入、准入失效和审批 CAS 回归5文件/60用例通过。
- 实际 FFmpeg 文件验证覆盖无音轨、AAC-LC 立体声、竖屏旋转、可变帧率、损坏文件及伪装播放清单；超大 multipart、异常流清理、并发关联、GC 竞争及删除重试有集成断言。
- Chromium 真实旅程完成商家 UI 上传保存、管理员编辑页完整预览、真实审批接口批准、游客在1280/820/390宽度播放及切换图片后释放资源；原图片图库3条浏览器回归通过。
- 从全新独立测试环境运行主 Playwright 套件，124项全部通过（12.2分钟）。文件写入上限补充后，受影响的5项真实媒体/上传用例另行复跑通过；法律页、通知实时和 catalog-ops 专用套件仍以最终 CI 为准。
- 真实隔离 MinIO 的私有签名/Range/过期/付费 attachment 回归通过；加密 v3 跨库跨桶恢复、篡改清单事务回滚、恢复后授权 Range 播放和付费文件字节核对通过。
- 前后端构建、架构/OpenAPI 引用、Nginx 静态检查通过；最终服务端镜像构建和镜像内非 root 有界解码/封装/海报生成通过。镜像内 FFmpeg 为8.1.2；本机测试工具为4.4.2。

上线还需要生产实际 provider/完整反代链、目标服务器容量、iOS Safari/Android Chrome/桌面 Firefox 的真实兼容验证，以及 P1.5-B 审核 UI 集成和最终 CI。Chromium 视口不能替代 iOS Safari；本地通过不等于已发布。
