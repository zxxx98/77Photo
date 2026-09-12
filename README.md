# 77Photo

77Photo 是一个面向家庭服务器的轻量照片库。Go 服务提供 REST API、React/PWA Web 界面和有限并发的 WebP 缩略图队列；SQLite 保存索引与权限，原图始终保存在普通文件系统中。

## 本地开发

需要 Go 1.23+、Node.js 22+ 和 npm：

```bash
go test ./...
go vet ./...
cd web && npm ci && npm test -- --run && npm run typecheck && npm run build
```

启动服务前端构建产物会由 Go 嵌入；直接运行 `go run ./cmd/77photo` 使用仓库中的静态 shell。默认监听 `:8080`，首次访问时调用 `POST /api/v1/setup/admin` 创建管理员。完整接口见 [docs/api/openapi.yaml](docs/api/openapi.yaml)。

## Docker Compose

```bash
docker compose up -d --build
curl -fsS http://127.0.0.1:8080/healthz
```

Compose 将原图、缓存和 SQLite 分到三个持久化卷。生产环境应在反向代理启用 HTTPS，并保持 `PHOTO_COOKIE_SECURE=true`。配置、升级和反向代理示例见 [部署文档](docs/operations/deployment.md)。

## 备份与性能

原图和 SQLite（包括 WAL）必须备份，缓存可以删除后重建；恢复步骤见 [备份恢复文档](docs/operations/backup-restore.md)。

大图库基准可重复运行：

```bash
go run ./tests/performance -count 10000 -pages 20
go run ./tests/performance -count 100000 -pages 20
```

安全矩阵、故障演练和发布清单分别见 [security.md](docs/operations/security.md)、[performance.md](docs/operations/performance.md) 和 [acceptance.md](docs/operations/acceptance.md)。
