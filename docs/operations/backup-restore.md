# 备份与恢复

必须备份：

1. `PHOTO_DATA_DIR` 中的原图和视频；
2. `PHOTO_DB_PATH` 对应的 SQLite 数据库及其同目录的 `-wal`、`-shm` 文件（或使用 SQLite 一致性备份 API）；
3. 缓存无需备份，缩略图会按 `photo ID + source revision` 重建。

最安全的简单方式是停止服务后复制照片根和数据库目录：

下面命令中的 `photo-data` 和 `photo-database` 替换为 `docker volume ls` 中当前 Compose 项目的实际卷名（Compose 通常会加项目名前缀）。

```bash
docker compose stop 77photo
docker run --rm -v photo-data:/src:ro -v "$PWD/backup:/dst" alpine \
  sh -c 'cp -a /src/. /dst/photos/'
docker run --rm -v photo-database:/src:ro -v "$PWD/backup:/dst" alpine \
  sh -c 'cp -a /src/. /dst/database/'
docker compose start 77photo
```

恢复时先停止服务，把备份中的 `photos/` 和 `database/` 还原到对应卷，再启动容器。确认管理员登录、用户禁用状态、共享权限和图库索引都存在；删除缓存卷后打开一张图片，接口应先返回缩略图 pending，随后由 worker 生成 WebP。最后执行一次管理员 rescan，确认新增、更新、缺失和失败统计符合备份内容。

若不能停机，必须使用 SQLite 官方一致性备份方式（例如 `VACUUM INTO` 或在线备份 API），并同时保留 WAL；直接复制正在写入的 `.db` 文件可能丢失最近事务。恢复前在隔离目录校验 `PRAGMA integrity_check`，确认通过后再替换生产卷。
