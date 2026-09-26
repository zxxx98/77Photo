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

## 备份与性能

原图和 SQLite（包括 WAL）必须备份，缓存可以删除后重建；恢复步骤见 [备份恢复文档](docs/operations/backup-restore.md)。

大图库基准可重复运行：

```bash
go run ./tests/performance -count 10000 -pages 20
go run ./tests/performance -count 100000 -pages 20
```

安全矩阵、故障演练和发布清单分别见 [security.md](docs/operations/security.md)、[performance.md](docs/operations/performance.md) 和 [acceptance.md](docs/operations/acceptance.md)。

## Android 客户端

新的 React Native Android 工程位于 [mobile/](mobile/README.md)。当前完成第一阶段的服务器连接、移动端登录与设备会话基础；照片浏览和上传仍在后续阶段。App 沿用 `77Photo` 显示名、`com.photo77` 应用 ID 和[原启动图标](assets/android/launcher/README.md)，使用现有移动 Bearer API。产品方向和阶段边界见 [Android 从零设计](docs/ui/ANDROID_FROM_WEB.md)。
