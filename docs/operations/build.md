# 构建与平台依赖

## 本地检查

```sh
go test ./...
go vet ./...
(cd web && npm ci && npm test && npm run typecheck && npm run build)
```

Dockerfile 先构建 Vite 静态资源，再复制到 `internal/webassets/static`，由 Go 的 `embed.FS` 编入最终二进制。生产二进制不会在启动时依赖 Node.js。

## ARM64

SQLite 使用 `modernc.org/sqlite`，是纯 Go driver；当前服务和 SQLite 路径不要求 CGO 或系统动态图片库。容器构建显式使用 `CGO_ENABLED=0`，CI 对 `linux/arm64` 执行 BuildKit 构建。

如果后续引入 libvips 或其他本地图片库，必须同时更新 Docker 构建阶段、运行时动态库清单和 ARM64 的 CI 冒烟验证，不能把宿主机上的库默认为发布依赖。

## 运行时目录

Compose 将照片、缓存和 SQLite 数据库挂载到独立卷：

- `/data/photos`：原图和文件夹，必须备份。
- `/data/database`：SQLite 文件及 WAL，必须备份。
- `/data/cache`：缩略图缓存，可删除后重建。
