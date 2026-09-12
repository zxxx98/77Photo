# 安全与异常恢复验证

T19 的回归入口是仓库内的 Go 单元测试和 `tests/integration/security_test.go`。测试使用临时 SQLite 数据库与临时照片根目录，不会改动开发机数据。

```bash
go test ./internal/auth ./internal/storage ./internal/photos ./internal/folders ./internal/shares ./internal/database
go test ./tests/integration -count=1 -v
```

权限矩阵以 Alice 为照片所有者、Bob 为家庭成员、admin 为管理员：

| 资源或操作 | admin | Alice（owner） | Bob（read） | 未认证/已撤销 |
| --- | --- | --- | --- | --- |
| 文件夹、照片元数据 | 读写 | 读写 | 读取共享子树 | 401 |
| 缩略图、1280 预览、原图 | 读取 | 读取 | 读取共享子树 | 401；撤销后 403 |
| 上传、移动、重命名、删除 | 允许 | 允许 | 403 | 401 |
| 创建/撤销 share | 允许 | 允许 | 403 | 401 |
| 用户管理、rescan | 允许 | 403 | 403 | 401 |

集成测试还检查已撤销成员使用已知 photo ID 不能读取元数据或原图、read 成员带有效 CSRF 仍不能写入、缺少 CSRF 的 Cookie 写请求统一返回 `CSRF_INVALID`，以及 URL 编码的路径跳转不会离开 API 资源边界。`internal/storage` 测试覆盖符号链接越界和非法名称；认证测试覆盖统一登录失败、Session 过期、撤销和登录限流；上传测试覆盖损坏图片、像素上限、读中断、磁盘/索引失败补偿和重名不覆盖。

故障处理约定如下：

- 上传先写同目录临时文件，校验、同步和原子重命名完成后才写索引；任何失败都会清理临时文件。
- 删除先写 `deleted_at` 墓碑。原文件删除成功而索引删除失败时，墓碑保持隐藏，下一次 rescan 可以继续清理。
- 移动、重命名和文件夹路径更新在文件系统操作失败时尝试反向补偿；索引异常会被记录并由 rescan 修复。
- SQLite 开启 WAL、外键和 5 秒 busy timeout。数据库锁超时会返回业务错误，服务不会把未提交内容当成成功。
- rescan 只有在完整遍历到用户根目录时才判定缺失；根目录暂时不可访问时保留现有索引。

日志只包含请求 ID、方法、路径、状态和耗时。Cookie、CSRF、Session token、密码哈希和上传内容不写入日志。部署时应在反向代理启用 HTTPS，并将 `/api/v1/setup/admin` 仅暴露给可信的首次初始化网络。

目前没有自动模拟真实磁盘写满或进程被 `SIGKILL` 的 CI 测试；发布前可按下面的手工步骤复现：在独立临时卷上设置磁盘配额，上传超过剩余空间的文件；在上传和移动过程中停止进程；重启后执行管理员 rescan，确认没有 `.tmp` 文件、孤儿索引或被覆盖的原图。
