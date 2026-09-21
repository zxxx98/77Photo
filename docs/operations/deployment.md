# 部署

生产部署需要 Docker Engine 24+ 和 Compose v2。照片、SQLite 数据库和缩略图缓存使用独立持久化卷；缓存可以删除并由服务按需重建。最终容器包含 `ffmpeg`、`ffprobe` 和 `heif-convert`，用于视频缩略图、HEIC/HEIF 预览与 MVIMG 动态片段。

```bash
docker compose up -d --build
curl -fsS http://127.0.0.1:8080/healthz
```

首次启动后，在受信任网络完成一次 `POST /api/v1/setup/admin`。之后该接口永久返回 `409 SETUP_COMPLETE`。反向代理应终止 HTTPS，并把外部请求转发到容器的 8080 端口；生产 Cookie 必须保持 `Secure`。示例（Caddy）：

```text
photos.example.test {
    reverse_proxy 127.0.0.1:8080
}
```

支持的环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PHOTO_DATA_DIR` | `./data/photos` | 原图与视频根目录 |
| `PHOTO_CACHE_DIR` | `./data/cache` | WebP 缩略图缓存 |
| `PHOTO_DB_PATH` | `./data/database/77photo.db` | SQLite 文件（含 WAL） |
| `PHOTO_LISTEN_ADDR` | `:8080` | 监听地址 |
| `PHOTO_THUMBNAIL_WORKERS` | `1` | 固定缩略图 worker，范围 1–64 |
| `PHOTO_MAX_UPLOAD_SIZE` | `10737418240` | 单文件字节上限 |
| `PHOTO_FFMPEG_PATH` | `ffmpeg` | FFmpeg 可执行文件路径；用于视频帧和 motion 提取 |
| `PHOTO_FFPROBE_PATH` | `ffprobe` | FFprobe 可执行文件路径；用于视频流校验 |
| `PHOTO_HEIF_CONVERT_PATH` | `heif-convert` | libheif 解码器路径；用于 HEIC/HEIF 预览 |
| `PHOTO_MEDIA_TIMEOUT` | `30s` | 外部媒体工具单次调用超时 |
| `PHOTO_SESSION_TTL` | `720h` | Session 有效期 |
| `PHOTO_COOKIE_SECURE` | `true`（容器） | HTTPS 环境保持 true；本地 HTTP 开发可设 false |

发布镜像由 `.github/workflows/release.yml` 在 `vMAJOR.MINOR.PATCH` 标签上构建并推送 `linux/arm64` 镜像，同时上传带嵌入 Web 资源的 CGO-free ARM64 二进制。二进制运行时需要能写入配置的照片、缓存和数据库目录；不依赖 libvips 或系统图像库。

升级时先备份原图和数据库，执行 `docker compose pull && docker compose up -d`，再检查 `/healthz` 和管理员 rescan。不要在升级过程中复用旧的缓存目录作为数据库卷。部署后应确认 `ffmpeg -version`、`ffprobe -version`、`heif-convert --version` 和 `curl -fsS http://127.0.0.1:8080/healthz` 均成功。

### Import folder organization

The settings page offers **Organize folders by timeline date**, disabled by default.
The import endpoint (`POST /api/v1/admin/imports`) accepts the optional boolean
`organize_by_date`; omitting it preserves source folders under `Imported`.

When enabled, originals are moved into `Imported/YYYY/MM/DD` using the same UTC
capture timestamp as the timeline (embedded metadata first, file modification
time as fallback). A Live Photo's still image determines the directory for both
files. Colliding basenames receive a shared numeric suffix, including when an
existing file has a different extension, so unrelated files cannot become false
Live pairs. Files whose metadata cannot be read are counted as failed and left
at their source. This option applies only to this import, not existing library files.
