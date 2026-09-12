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

## 2026-09-12 工作区验证快照

以下记录对应提交 `1d8b9ba`，用于区分本地自动化结果与发布前仍需在目标环境完成的项目：

| 检查 | 结果 | 证据或限制 |
| --- | --- | --- |
| Go 单元/集成测试、`go vet`、竞态测试 | 已完成 | `go test ./...`、`go test -race ./internal/... ./tests/integration`、`go vet ./...` |
| CGO-free 测试与 amd64/arm64 构建 | 已完成 | `CGO_ENABLED=0 go test ./...`；两个 `GOOS=linux` 交叉构建均返回 0 |
| Web 测试、类型检查、生产构建 | 已完成 | `npm test -- --run`（8 tests）、`npm run typecheck`、`npm run build` |
| 权限矩阵集成测试 | 已完成 | `TestSecurityPermissionMatrixAcrossResources` 通过 |
| 1 万/10 万索引基准 | 已完成 | ARM64 Oracle Neoverse-N1 主机；结果详见 `docs/operations/performance.md` |
| Docker 镜像/Compose 启动与备份恢复 | 未完成 | 当前 Docker daemon socket 返回 permission denied |
| 浏览器视口、键盘焦点与 NanoPi R5S 负载 | 未完成 | 当前环境没有目标浏览器记录或 NanoPi R5S 实机 |
