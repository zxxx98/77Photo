# 本地人脸识别部署与使用

适用场景：NanoPi R5S 运行 77Photo；Windows 电脑运行 Docker Desktop、WSL2 和 NVIDIA GPU。识别由管理员手动开始，电脑关闭后人物数据仍保存在 R5S。功能默认关闭。

当前仓库已包含 Go API、网页端、模型准备脚本和 GPU 容器源码。**此环境无法连接 Docker daemon，也没有 Windows/NVIDIA GPU，所以下列镜像组合尚未经你的电脑实测。** 首次使用先备份 77Photo 的 SQLite 数据库和照片，然后用约 100 张获准测试的照片验证速度和分组效果；不要直接全库扫描。

## Windows 电脑：准备模型和容器

1. 安装较新版本的 NVIDIA Windows 驱动、WSL2、Docker Desktop，启用 WSL2 后端和 Linux 容器。打开 PowerShell，在仓库的 `services/face-worker` 目录运行 `docker version` 和 `nvidia-smi`。Docker Compose 需要能访问 GPU；若没有 CUDA 设备，worker 启动时会失败，不会静默改用 CPU。
2. 运行 `py -3 prepare_models.py`。若 Windows 尚未安装 Python，也可在该目录执行 `docker run --rm -v "${PWD}:/work" -w /work python:3.12-slim python prepare_models.py`。脚本下载固定版本的 OpenCV Zoo YuNet（MIT）与 SFace（Apache-2.0）权重和许可证，校验 SHA-256，并生成 `models/manifest.json`。约需下载 39 MB。镜像推理时不联网下载模型。不要把 `models/` 提交到 Git。
3. 从 `.env.example` 复制出 `.env`，将 `FACE_BIND_IP` 填为 Windows 电脑在家中网络里的固定 IP，例如 `192.168.1.100`。生成不少于 32 字符的随机 `FACE_API_KEY`，不要使用示例值。PowerShell 可运行：

   ```powershell
   $bytes = New-Object byte[] 32
   [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
   [Convert]::ToHexString($bytes)
   ```

   将输出写进当前目录 `.env` 的 `FACE_API_KEY`。主项目和 worker 可使用**同一密钥值**，但各自 `.env` 文件不要入库。
4. 运行 `docker compose build`，再运行 `docker compose up -d`。这会本地构建 `linux/amd64` GPU 镜像；不会修改 R5S 镜像。首次构建会下载 CUDA 和 Python 依赖，耗时由网络决定。
5. Windows 防火墙只允许 R5S 的内网 IP 访问 TCP 8091。不要把 8091 映射到公网。保持电脑不休眠时才能扫描；识别完成后可运行 `docker compose stop`。

> 上述 PowerShell `Convert.ToHexString` 需要较新的 .NET/PowerShell。若命令不可用，可以用系统密码管理器生成 64 位十六进制随机串。

## R5S：启用可选功能

仓库根目录的 `compose.yaml` 已加入 `PHOTO_IMAGE` 和人脸识别环境变量。公开仓库中的 `ghcr.io/zxxx98/77photo:latest` 可能尚未包含本次代码，因此需要**先构建当前源码**，发布新镜像后才可改用正式版本。在 R5S 的仓库根目录运行：

```bash
docker build -t 77photo:faces .
```

在仓库根目录 `.env` 中加入下面的值，地址换成你的 Windows 电脑 IP，密钥与 worker 相同：

```dotenv
PHOTO_IMAGE=77photo:faces
PHOTO_FACE_ENABLED=true
PHOTO_FACE_WORKER_URL=http://192.168.1.100:8091
PHOTO_FACE_WORKER_TOKEN=替换成上一步生成的随机密钥
PHOTO_FACE_ALLOW_INSECURE_LAN=true
PHOTO_FACE_MATCH_THRESHOLD=0.55
```

`PHOTO_FACE_ALLOW_INSECURE_LAN=true` 表示你明确接受家庭局域网内的 HTTP 传输；通过 Tailscale/WireGuard 等私有加密连接，或在 worker 前加 HTTPS 代理时，改用对应地址并关闭该选项。R5S 向 Windows 主动发请求；**不要**写 `localhost` 或 WSL 的临时 IP。`PHOTO_FACE_MATCH_THRESHOLD=0.55` 是参考 SFace 官方人脸验证阈值后选的保守初值，自动匹配还要求第一、第二候选相差至少 0.08。它没有在你的家庭照片上完成标定；先用约 100 张照片检查误合并。想关闭自动匹配、只手动合并，可改为 `1` 并重启 R5S。阈值变更只影响后续扫描，不会自动重排已有结果。人物向量一旦由某版本模型写入，不能无迁移地切换模型版本。

然后运行：

```bash
docker compose up -d
```

R5S 的数据库会自动执行新增迁移。管理员登录 Web 后，进入「设置」或「人物」，点击「测试连接」，再点击「扫描新增照片」。旧库首次扫描会处理所有尚未识别的照片。扫描时会发出最长边约 1280px、去掉 EXIF/GPS 的 JPEG 预览图；在照片中非常小的人脸可能漏检。照片原图仍在 R5S；worker 只保留模型文件和运行时临时数据，不维护照片库。

电脑关机或网络中断后，任务显示离线暂停；重启容器并点击「继续」。R5S 重启后任务会标为暂停，再点击「继续」。若某些照片预览解码失败，任务会记录失败数，之后可使用「重试失败照片」。识别结果和命名在电脑关机时也可浏览。

## 故障排查与资源边界

| 现象 | 检查 |
| --- | --- |
| “电脑离线”或连接测试失败 | Windows IP/防火墙/容器运行状态；从 R5S 使用密钥请求 `GET http://电脑IP:8091/v1/health`，无需打开公网 |
| 返回 401 | 两台设备上的密钥是否一致，是否误带空格或换行 |
| 返回模型不兼容 | 模型清单、模型文件或预处理版本变化。旧人物向量不能直接混用；恢复原模型或设计迁移流程 |
| GPU 不可用 | Windows 驱动、WSL2 GPU 透传、Docker Desktop 的 Linux 容器模式；检查 `docker compose logs face-worker` |
| 照片浏览明显变慢 | 暂停扫描，检查 R5S 解码负载和缓存目录可用空间；一次只运行一个推理请求，头像解码同样受限 |

照片和人脸向量仍属敏感数据。密钥在容器环境变量和 R5S 部署配置中，限制这些文件和 Docker 管理权限。HTTP 局域网连接没有传输加密；如果网络中有不可信设备，请改用加密连接。应用不会主动持久化 worker 收到的图片，但 Windows 的页面文件、WSL swap 和崩溃转储仍可能保存内存片段。

按 [备份恢复文档](backup-restore.md)备份 R5S 的 SQLite（含 WAL）和原图，缓存无需备份。数据库升级回退要使用兼容版本或升级前备份；只回退旧版容器不能撤销数据库迁移。

当前第一版仅管理员能查看人物数据；普通成员和公开分享接口不会返回人脸元数据。视频逐帧识别和 Android 原生人物页仍在后续范围。具体协议和限制见 [开发设计](../superpowers/specs/2026-09-27-local-face-recognition-design.md)。
