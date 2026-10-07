# 77Photo

77Photo 是一个面向家庭服务器的轻量照片库。Go 服务提供 REST API、React/PWA Web 界面和有限并发的 WebP 缩略图队列；SQLite 保存索引与权限，原图始终保存在普通文件系统中。支持 JPEG、PNG、HEIC/HEIF、MP4、WebM，以及 JPEG/HEIC/HEIF + MOV 动态照片；MVIMG 和内嵌 motion 会生成可重建的派生视频。

## 本地开发

需要 Go 1.23+、Node.js 22+ 和 npm：

```bash
go test ./...
go vet ./...
cd web && npm ci && npm test -- --run && npm run typecheck && npm run build
```

启动服务前端构建产物会由 Go 嵌入；直接运行 `go run ./cmd/77photo` 使用仓库中的静态 shell。默认监听 `:8080`，首次访问时调用 `POST /api/v1/setup/admin` 创建管理员。完整接口见 [docs/api/openapi.yaml](docs/api/openapi.yaml)。

媒体容器依赖 FFmpeg/FFprobe 和 libheif 的 `heif-convert`。部署后可用以下命令确认能力：

```bash
ffmpeg -version
ffprobe -version
heif-convert --version
curl -fsS http://127.0.0.1:8080/healthz
```

## Docker Compose

```bash
docker compose up -d --build
curl -fsS http://127.0.0.1:8080/healthz
```

Compose 将原图、缓存和 SQLite 分到三个持久化卷。生产环境应在反向代理启用 HTTPS，并保持 `PHOTO_COOKIE_SECURE=true`。配置、升级和反向代理示例见 [部署文档](docs/operations/deployment.md)。

## 地图

Web 端「地图」页按拍摄位置浏览照片，照片详情显示位置和小地图，底图使用天地图。在天地图控制台申请「浏览器端」key，写入 Compose 同目录的 `.env`（`PHOTO_MAP_TIANDITU_KEY=…`，不要提交到 Git）后重启服务。升级前已入库的照片需要管理员在设置中执行一次「重新扫描文件」来读取位置。详见[部署文档](docs/operations/deployment.md)。

## 功能开发设计

回收站已交付；分享链接管理功能正在开发，使用方法见[分享链接管理](docs/operations/share-management.md)。基础搜索和个人收藏已完成本地开发，收藏可在 Web/Android 查看器中设置，并通过图库的「收藏」入口跨文件夹查看；后续推进 Android 视频自动备份。任务拆分、兼容要求和验收标准见[家庭照片管理补齐计划](docs/superpowers/plans/2026-09-28-family-photo-roadmap.md)。

本地人脸识别通过可选的 Windows NVIDIA GPU 容器按需处理照片，R5S 保存人物数据并支持手动增量扫描。安装见 [部署文档](docs/operations/face-recognition.md)，设计与验收边界见 [开发设计](docs/superpowers/specs/2026-09-27-local-face-recognition-design.md)。该功能默认关闭。

Web 管理员「重复照片」支持跨文件夹查找完全重复副本、pHash 视觉相似扫描，以及可选本地整图 AI 扫描。按所属用户隔离，动态照片比较完整动态内容；对比后选择保留项，其余移入回收站。AI 使用独立整图模型与局部细节核验，部署、算法边界和使用方法见 [重复照片清理](docs/operations/duplicates.md)。

## 回收站

Web 单张与批量删除会移入回收站，默认保留 30 天，支持批量恢复、重名自动改名、永久删除与按范围清空。原图和动态照片伴随文件一起保留，操作中断后可继续恢复。管理员可切换查看所有用户的回收站；配置、共享规则及备份要求见[回收站说明](docs/operations/trash.md)。

## 图库搜索

Web「时间线」支持按文件名、拍摄日期范围、文件夹和照片/视频组合筛选。输入文件名后稍等片刻即自动搜索；“清除筛选”恢复普通列表。日期按浏览器所在时区解释，结束日期包含当天。动态照片归入照片。查询约定和性能测量见 [M3 开发记录](docs/operations/releases/m3-search-draft.md)。

## 备份与性能

原图和 SQLite（包括 WAL）必须备份，缓存可以删除后重建；恢复步骤见 [备份恢复文档](docs/operations/backup-restore.md)。

大图库基准可重复运行：

```bash
go run ./tests/performance -count 10000 -pages 20
go run ./tests/performance -count 100000 -pages 20
```

安全矩阵、故障演练和发布清单分别见 [security.md](docs/operations/security.md)、[performance.md](docs/operations/performance.md) 和 [acceptance.md](docs/operations/acceptance.md)。

## Android 客户端

重写后的 React Native Android 工程位于 [mobile/](mobile/README.md)。当前支持服务器连接、移动端登录、照片与文件夹浏览、预览播放、原图分享、持久化手动上传队列，以及可选的后台照片自动备份。手动上传退到后台可能中断；自动备份受 Android 调度限制，目前独立视频仍需手动上传。Android APK **只支持 ARM64（`arm64-v8a`）**，调试和编译不使用 x86/x86_64 Android 目标或模拟器。App 沿用 `77Photo` 显示名、`com.photo77` 应用 ID 和[原启动图标](assets/android/launcher/README.md)，使用现有移动 Bearer API。构建要求和验证命令见移动端 README，产品方向见 [Android 从零设计](docs/ui/ANDROID_FROM_WEB.md)。
