# 商品展示视频运行说明

自动处理与独立视频审核的设计见 [补充方案](../specs/product-video-processing.md)。下方历史验证记录保留原版本上下文，本次部署请按当前预算和审核步骤执行。

## 使用和权限

商家创建/编辑、管理员创建平台商品/编辑商品均有“商品视频”控件。上传返回 202，后台处理完成后点击“使用此视频”，保存才修改商品。可离开页面，24 小时内返回编辑器恢复未保存资产。替换失败保留原视频，移除后也要保存。每商品一个视频，视频资产不能跨商品或跨经营主体关联。管理员代商家上传使用该商品 merchantId。

普通详情的当前视频进入可视区域后获取 180 秒播放凭证并尝试静音自动播放；浏览器拦截时显示中央播放图标，可主动打开声音。离开可视区域或进入后台暂停，用户主动暂停及播放结束后不自动重播。编辑和审核预览仍需点击播放。画面完整显示，模糊海报填充留白；移动端页面操作按钮移出视频区域，跨布局断点保留媒体选择。列表和分享封面沿用图片。图库图片灯箱不包含视频。

视频的新增、替换、移除与商品内容 CAS、公开审核失效在同一事务完成。游客签发复用分类、生命周期及当前版本批准门禁；登录用户复用 member 门禁。所有普通浏览者还需视频独立审核通过。商品管理 → 视频内容审核（含仅登录商品） → 完整播放视频、打开声音听完音轨 → 勾选审核声明 → 批准。之后 public 商品才能在游客公开审核中批准；视频批准不会自动公开商品。已通过列表可填写原因并撤销视频批准。

**升级行为**：新迁移将现有视频统一设为 pending；商品正文保持可见，视频在补审前对普通用户隐藏，商家/管理员可预览。请在发布窗口内安排管理员补审。尚未保存的视频不进入内容审核队列。

## 部署参数

生产 Compose 默认关闭以下开关；完成实际部署环境验收后由部署配置启用：

```dotenv
PRODUCT_VIDEO_UPLOAD_ENABLED=false
PRODUCT_VIDEO_PLAYBACK_ENABLED=false
```

仅设置为 `false` 才暂停；本地直接运行的缺省值为启用。开关不删除数据，也不撤回已签发 URL/已下载字节。关闭上传不影响现有播放；关闭签发不影响图片与购买。

上传要求运行用户可执行 `prlimit`、`ffprobe` 和 `ffmpeg`。runtime Alpine 镜像安装发行版 `ffmpeg`、`util-linux`；需随镜像更新安全补丁，并记录实际版本。应用用户为非 root。`GET /api/admin/product-videos/health`（active admin + MFA）单独返回工具可用性、两个开关和进程忙状态，不影响整站 ready。

原片预算：90 MiB、60 秒、MP4/MOV、H.264/HEVC、最多 4096×2160（竖屏同等长短边）、120fps，单视频/最多单音轨，丢弃时间码等 data 轨。后端自动方向修正、缩放、HDR tone mapping 和音频转码，成品 H.264 yuv420p SDR，长边≤1920/短边≤1080、30fps，AAC-LC 双声道48kHz或无音轨，最大40MiB；海报≤640尺寸、512KiB。无静默截断/丢音轨。

仓库 Nginx 上传路径95m，关闭请求缓冲；**外层 1Panel/OpenResty/SaaS 也必须放宽至至少95m，不能只更新仓库配置**。应用接收120秒、整次上传240秒（含原片写入），原片成功入队后后台继续。工作器媒体处理360秒、CPU300秒、地址空间2GiB，单文件输出64MiB、日志128KiB、单线程；预留至少512MiB临时盘。单进程单个处理任务，跨实例 cron 租约，数据库每次领取10分钟，最多3次（存储暂时失败30秒后重试、无效素材立即失败）。实际硬件可能无法在预算内处理所有4K素材，应记录超时率再调整容量，禁止无限重试。

`ProductVideoAsset` 中 queued/processing 为任务来源，不能依赖进程内队列。进程退出时中断当前子进程，正常恢复排队；强制退出后10分钟租约到期可被接管。超期旧工作器的输出无法提交。每个经营主体最多1个上传/排队/处理任务及5个未关联成品。

临时文件只在 `PRODUCT_VIDEO_TEMP_ROOT` 内创建和回收；不同进程需独立目录。子进程预算最长360秒，遗留本地目录10分钟后可清理。原片在私有桶 `product-video-sources/v1/{UUID}/source`；从不提供原片播放签名，成功或终止后删除，失败删除由24小时GC兜底。临时关闭上传开关不丢弃已有排队任务。

## 私有存储和日志

复用现有 private bucket；新成品路径为 `product-videos/v1/{资产UUID}/{尝试UUID}/video.mp4` 和 `poster.jpg`，旧版本无尝试子目录的路径仍可读。位置绑定上传开始时的 provider，切换 active provider 不会改变已有视频的读桶。禁止桶匿名读；不改付费交付的 attachment/octet-stream 签名。

签发 JSON 和对象均 private/no-store。签名 URL 是临时持有者凭证，可在180秒内转发；撤销审核/退出登录只阻止新授权，不能撤回旧链接和已下载字节。前端在身份、会话、商品和资产变化时取消请求、暂停并移除 src。

仓库私有桶反代及开发签名路径关闭 access log；应用日志将开发签名路径替换为 redacted。外层网关、provider 访问日志和错误平台也必须移除完整查询串/签名路径，HTTPS、Host、原路径/查询串不得改写。跨域 provider 按需允许 Range，不能以公开桶解决播放器跨域错误。

## 清理、备份和回滚

付费附件 GC 仅处理64位SHA-256加短扩展名；跳过视频和未知对象。视频 GC 先锁资产复查无商品引用，再置 deleting、事务外删除；失败保留记录重试。已关联/归档商品仍有引用时不删。未关联资产宽限24小时，过期 uploading 10分钟标失败；孤儿严格按视频目录/UUID及当前成品generation/活跃任务token查库后回收（不删除 queued/processing 原片），DB故障保留对象。残留本地临时目录超过10分钟后回收。

Portable backup 新导出为 v3：使用与 pg_dump 相同的 Repeatable Read 快照，按资产绑定 provider 流式导出视频/海报，核对大小/SHA-256。恢复到目标 env 私有桶；v3 的数据库恢复、视频清单匹配检查及 provider 重绑在同一个 PostgreSQL事务完成，清单不匹配整体回滚。恢复前禁止覆盖已有对象；数据库提交前失败会补偿本次对象。v1/v2 继续支持；旧工具拒绝 v3。恢复仅向空实例执行。原片和进行中任务不随备份导出；恢复时 uploading/queued/processing 标 failed 并清除租约，商家须重新上传。

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

## 本地验证记录（2026-10-22，初始视频实现）

- 全新库105个迁移通过；从 P1.5 的104个迁移、含已批准商品的数据升级通过，原商品视频引用为空、批准版本保持不变。
- 前端全量205文件/1720用例通过；最终视频、真实 Redis 缓存及付费存储回归5文件/51用例通过。较早的商品写入、准入失效和审批 CAS 回归5文件/60用例通过。
- 实际 FFmpeg 文件验证覆盖无音轨、AAC-LC 立体声、竖屏旋转、可变帧率、损坏文件及伪装播放清单；超大 multipart、异常流清理、并发关联、GC 竞争及删除重试有集成断言。
- Chromium 真实旅程完成商家 UI 上传保存、管理员编辑页完整预览、真实审批接口批准、游客在1280/820/390宽度播放及切换图片后释放资源；原图片图库3条浏览器回归通过。
- 从全新独立测试环境运行主 Playwright 套件，124项全部通过（12.2分钟）。文件写入上限补充后，受影响的5项真实媒体/上传用例另行复跑通过；法律页、通知实时和 catalog-ops 专用套件仍以最终 CI 为准。
- 真实隔离 MinIO 的私有签名/Range/过期/付费 attachment 回归通过；加密 v3 跨库跨桶恢复、篡改清单事务回滚、恢复后授权 Range 播放和付费文件字节核对通过。
- 前后端构建、架构/OpenAPI 引用、Nginx 静态检查通过；最终服务端镜像构建和镜像内非 root 有界解码/封装/海报生成通过。镜像内 FFmpeg 为8.1.2；本机测试工具为4.4.2。

## 最终 P1/P1.5 集成回归（2026-10-22）

- 已基于 `e0cc7cf` 集成审核工作台；前端视频/上传/审核组件3文件12用例通过，包含视频替换后409重新读取及切商品时忽略晚到响应。
- 独立 PostgreSQL 全新105个迁移通过；视频、审批 CAS、待审队列及套餐写入失效回归4文件33用例通过，1项真实 Redis 专项在本轮未启用 Redis 时跳过。缓存路径的真实 Redis 验证见上方初始实现记录，本轮不将跳过计为通过。
- Chromium 真实流程3项通过：P1.5 公开审核及分类收紧旅程，以及商家上传保存 → 审核台完整播放含 AAC-LC 音轨样片（取消静音）→ UI 批准 → 游客三种布局播放。视频旅程不再通过 helper 代替审核台批准。自动化取消静音不等于实际设备扬声器听感验收。
- 前后端构建、架构与 OpenAPI 引用、架构测试、Nginx 静态检查通过；后端与前端独立代码复核未发现阻塞项。
- 首轮远程 CI 暴露旋转样片生成命令的跨版本差异：FFmpeg 6.1/8.1 不再通过旧 `rotate` 元数据命令生成旋转信息。样片按工具能力使用 `display_rotation`，并先断言输入方向；封装显式关闭隐式旋转且复核方向、显示尺寸和音轨不变。FFmpeg 4.4 与 Ubuntu 24.04/FFmpeg 6.1 的视频后端用例各15项通过（各1项 Redis 专项跳过），8.1 镜像内真实旋转文件的解码、封装、海报和尺寸验证通过；独立复核无阻塞项。

上线还需要最终远程 CI、生产实际 provider/完整反代链、目标服务器容量及 iOS Safari/Android Chrome/桌面 Firefox 的真实兼容验证。Chromium 视口不能替代 iOS Safari；本地通过不等于已发布。生产 Compose 视频上传/播放继续默认关闭，完成上线验收后再启用。

## 自动处理与独立审核本地验证（2026-10-23）

- 独立开发工作树从 `149d4f1` 建立，原工作区既有修改未带入。本次开发不修改生产配置，生产现状以单独的上线验收记录为准。
- 后端视频模块21项通过（启用真实 Redis，包含缓存视频审核撤销后立即隐藏）；游客准入审批、失效、缓存门禁回归共25项通过。失效回归首次受本地IO/事务超时影响，单独重跑14项全部通过，未调整业务代码或测试超时。
- 上传、播放器、游客审批、独立视频审核组件4文件16项通过；前后端构建、架构/OpenAPI引用和架构规则测试通过。
- 原有视频浏览器旅程更新为异步上传 → 选择/保存 → 独立视频内容审核 → 游客公开审批 → 三种布局播放，全程使用真实API与媒体，通过。
- 真实隔离 MinIO 的匿名访问、inline MIME/no-store、Range206/416、签名篡改/过期及付费 attachment 回归通过；PostgreSQL16客户端完成新generation产物的加密v3跨库/跨桶备份恢复、篡改回滚及恢复后授权播放。
- 本机FFmpeg4.4真实HEVC/PQ MOV与PCM音轨转换为H.264/SDR/AAC-LC；Alpine运行镜像FFmpeg8.1完成同类素材及4K/HLG到1920×1080的非root有界转换。合成素材验证处理路径，不替代真实手机HDR素材的色彩、听感和长片性能验收。
- 上线前仍需最终CI、外层代理95m、实际硬件长片容量和手机原片实测；不包含独立媒体出口及第三方SaaS缓存问题的修复。

## 队列指标与审核分页

`/api/metrics` 读取持久任务状态，因此 worker 不执行时也能观察积压：

- `monexus_product_video_assets{status="queued|processing|failed"}`：各状态数量。
- `monexus_product_video_oldest_queued_seconds`：最早排队任务年龄，包含重试等待。
- `monexus_product_video_expired_processing`：领取租约已过期的处理中任务数。
- `monexus_product_video_processing_seconds{outcome="succeeded|retry|failed"}`：包含对象存储读写的单次处理耗时直方图。

健康接口保留 `busy`，并明确返回本实例 `uploadBusy`、`workerActive`。状态数量来自数据库，健康接口的活动标志只代表所请求的进程。指标查询依赖数据库；数据库不可用时 scrape 失败，应由既有 scrape/up 告警承接。

示例告警见 `product-video-alerts.rules.yml`，需由运维加载到 Prometheus；默认排队阈值为 15 分钟，可按实际素材和机器能力调整。告警后先检查 worker 日志、临时盘容量与对象存储，再决定恢复服务或让商家重新上传；不要直接修改 processing token。

审核列表接受 `moderation/page/pageSize`，返回 `{items,total,page,pageSize}`，按创建时间和资产 ID 稳定排序。管理面板每页 50 条，已通过/已拒绝历史也可翻页。
