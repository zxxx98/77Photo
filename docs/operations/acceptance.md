# V1 发布验收记录

每个版本发布前复制本页并填写版本、提交、测试设备和日期。未运行的项目标记为“未完成”，不以推测替代结果。

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| A：Alice 登录并上传到私人 `2026/宝宝`，Bob 无法查看 | ☐ | `go test ./internal/auth ./internal/folders ./internal/photos` + 手工记录 |
| B：Alice 分享目录给 Bob read/write，Bob 可按权限浏览或上传 | ☐ | `go test ./tests/integration -run SecurityPermissionMatrix` |
| C：手机首屏缩略图、连续分页、预览和主动下载原图 | ☐ | `npm run build` + 浏览器记录 |
| D：NanoPi R5S 空闲、浏览、缩略图和 rescan 负载 | ☐ | `docs/operations/performance.md` 设备记录 |
| E：停止服务后原图可直接读取，删除缓存后重启可重建 | ☐ | `docs/operations/backup-restore.md` 手工记录 |
| amd64 容器启动 | ☐ | `docker buildx build --platform linux/amd64 --load .` |
| arm64 容器启动或实机验收 | ☐ | 设备型号、镜像摘要和 `/healthz` |
| 375/768/1440 px 响应式与键盘焦点 | ☐ | 浏览器截图或 e2e 记录 |
| 1 万/10 万索引性能 | ☐ | `artifacts/performance/*.json` 与 `/usr/bin/time -v` |

发布阻断项包括：任何越权响应、原图丢失或覆盖、备份无法恢复、数据库完整性检查失败、镜像无法启动、或未标记的实机性能缺口。
