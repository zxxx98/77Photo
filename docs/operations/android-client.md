# Android 客户端运维与验收

## 兼容性与首次配置

客户端目标为 Android 12（API 31）及以上。最低服务端不是一个可单独通过版本字符串判断的旧 Web 版本，而是首次包含以下移动协议的 77Photo 服务端发布：

- `POST /api/v1/mobile/auth/login`、`POST /api/v1/mobile/auth/refresh` 和 `POST /api/v1/mobile/auth/logout`；
- 设备列表/撤销接口；
- 图库、文件夹、上传和管理员扫描接口对 `Authorization: Bearer` 的支持；
- 当前数据库迁移中包含移动设备和令牌表。

本仓库的 OpenAPI 版本基线为 `1.0.0`。如果登录返回移动接口不支持，升级服务端，不要尝试在 WebView 中复用 Cookie 登录。

生产部署步骤：

1. 在反向代理启用 HTTPS，只向外部暴露代理地址；服务端仍监听容器内的 8080。
2. 域名证书必须覆盖用户输入的域名。使用 HTTPS IP 时，证书必须在 SAN 中包含该 IP；仅把 IP 写进 CN 不足够。
3. 当前客户端不提供私有 CA 导入和 TLS 绕过能力。优先使用公有 CA；若受管设备已安装私有 CA，先在目标 Android 版本上验证系统信任链和网络安全策略，再交付。
4. 在 App 中添加服务器地址。HTTPS 域名、HTTPS IP 和带端口地址都可以使用；HTTP 只能使用命中的内网 IP CIDR，并会在登录页显示未加密警告，必须勾选受控内网确认后才能登录。
5. 使用用户名和密码完成移动登录。密码不会转化为 Web Cookie；后续请求使用短期 access token，refresh token 轮换并只保存在 Android Keystore 加密存储中。

HTTP 内网白名单是风险开关，不是加密替代品。默认范围包括 loopback、RFC1918、link-local 和 ULA；登录前必须明确确认仅在受控内网使用未加密 HTTP。用户添加公网 CIDR 前会收到高风险确认，`0.0.0.0/0` 和 `::/0` 永远拒绝。不要把公网反向代理地址配置成 HTTP。

## 后台上传行为

上传通过 Android Photo Picker 选择媒体，不申请读取整个相册的宽泛权限。选择目标文件夹后，任务先进入 Room，再由 data-sync 前台服务上传；默认只使用 Wi-Fi，并发可设为 1–4（默认 2）。Android 13+ 需要通知权限才能在系统通知栏观察进度；拒绝权限时，应用页应明确提示后台进度不可见。

以下恢复语义用于验收和故障排查：

- 网络中断、进程被回收或前台服务到达系统时限时，任务保留在本地队列，租约释放后由受网络约束的 WorkManager 恢复。
- 单个未完成文件没有断点续传，恢复时从头读取；已完成任务不会因恢复流程再次执行。
- 429、5xx、超时和网络错误使用带抖动的退避，最长 15 分钟；永久格式/大小错误显示为失败，重复照片显示为跳过。
- 电池优化和厂商后台策略可能延迟恢复。对需要可靠后台上传的设备，按厂商文档将 App 设为允许后台活动或“不受限制”，但不能要求用户关闭 Android 的整体安全机制。
- 通知只显示数量、字节进度和成功/跳过/失败汇总，不显示私密服务器完整地址、文件系统路径、令牌或照片缩略图。暂停/继续操作只作用于对应服务器的队列。

## 缓存、会话与设备撤销

设置中的“清理缩略图缓存”只清理服务端读取的缩略图查询缓存，不删除 Photo Picker 媒体、原始照片、Room 队列或 Keystore 凭据。服务器切换时，旧服务器任务仍绑定旧的 server ID；先暂停并明确选择保留或取消，不能把任务静默投递到新服务器。

退出当前设备会撤销当前移动设备的服务端令牌并清除本地凭据。需要撤销其他手机时，使用服务端移动设备管理接口按设备 ID 撤销；密码变更、停用或删除账户会撤销该账户的所有移动设备。撤销后重新启用账户不会恢复旧令牌，必须重新登录。

## 故障排查

每个 API 错误都应带 `request_id`。提交工单时记录时间、服务器配置名称、脱敏的用户/设备 ID、操作、HTTP 状态码和 request ID；不要提交 access token、refresh token、Cookie、完整照片路径或照片本身。若日志中出现令牌、密码或私密 URL，应立即按泄露事件处理并撤销相关设备。

常见现象：

| 现象 | 检查项 |
| --- | --- |
| 提示服务端不支持移动登录 | 确认服务端已完成移动迁移并暴露 `/api/v1/mobile/auth/login`，再检查反向代理是否错误缓存了 404。 |
| HTTPS IP 登录失败 | 检查证书 SAN 是否包含 IP、设备时间是否正确，以及代理是否把正确 Host/SNI 转发到服务端。 |
| HTTP 地址被阻止 | 只允许 IP 字面量；确认该 IP 命中已启用 CIDR。域名解析到内网 IP 也不会放宽 HTTP 规则。 |
| 后台没有进度 | 检查 Android 13+ 通知权限、通知渠道、电池优化和厂商后台限制；回到 App 后以 Room 队列快照判断任务是否仍在恢复。 |
| 上传停在排队 | 检查网络是否满足 Wi-Fi/移动网络设置、目标文件夹写权限和是否有另一个服务/Worker 持有租约。 |
| 登录或刷新突然失效 | 在服务端按时间和 request ID 检查设备是否被撤销或 refresh token 重放；不要要求用户提供令牌。 |

## 发布前检查

本地/CI 构建命令：

```sh
cd mobile
npm ci
npm test -- --runInBand
npm run typecheck
npm run lint
cd android
./gradlew testDebugUnitTest
./gradlew assembleDebug
```

`.github/workflows/android-ci.yml` 独立处理 `mobile/**` 改动。它会运行 JavaScript、TypeScript、Lint 和 Kotlin 检查；当 `mobile/package.json` 的 `version` 相对目标分支发生变化时，额外构建并上传带该版本号的 debug APK。正式 tag 仍由 Android Release workflow 生成签名 AAB 与 APK。

真实 release 由 CI 从 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS` 和 `ANDROID_KEY_PASSWORD` secrets 恢复签名材料，生成 AAB 与 APK。密钥文件只写入 runner 临时目录，构建日志不得输出密码或 key material。

按 [Android E2E 说明](../../mobile/e2e/README.md) 在 Android 12、Android 13 和当前稳定版设备上运行 Maestro；额外记录通知拒绝、网络切换、进程终止、前台服务超时、并发 1/4、HTTPS 域名/IP、允许的 LAN HTTP 和公网 HTTP 阻断结果。
