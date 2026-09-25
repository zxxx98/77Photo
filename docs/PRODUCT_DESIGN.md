# 77Photo 产品与架构设计

## 1. 项目定位

77Photo 是一个面向家庭场景的轻量级、自托管照片管理服务。

目标不是复刻 Immich 或 Google Photos 的全部能力，而是在低资源设备上提供家庭照片管理最常用的核心功能：

- 多用户登录
- 文件夹式照片存储
- 图库浏览
- 缩略图与预览图
- 上传、移动、删除、重命名
- 基础 EXIF 信息读取
- 手机、平板与桌面 Web 自适应
- 文件夹与照片的只读公开链接

项目优先面向 NanoPi R5S、树莓派、小型 ARM64 NAS 和低配家庭服务器等设备。

核心原则：

> 用 Immich 约 20% 的功能覆盖家庭照片管理约 80% 的需求，并把服务保持在足够轻量、可维护、可迁移的状态。

---

## 2. 设计目标

### 2.1 轻量

默认部署不依赖：

- PostgreSQL
- Redis / Valkey
- 独立消息队列
- AI / ML 服务
- 视频转码服务

推荐形态：

```text
77Photo Server
├── Go API
├── SQLite
├── static Web assets
├── photos/
└── cache/thumbnails/
```

V1 目标是在 4 GB 内存的 NanoPi R5S 上长期运行时仍能给其他家庭服务留出足够资源。

资源目标属于工程目标而不是硬性承诺：

- 空闲常驻内存：尽量控制在 300 MB 以内
- 正常图库浏览：尽量控制在 500 MB 以内
- 缩略图生成时允许短时升高，但必须限制并发
- 默认缩略图生成并发：1
- 不开启视频转码

### 2.2 文件系统优先

照片的真实来源是普通文件，而不是数据库私有格式。

```text
/photos
├── users
│   ├── alice
│   │   ├── 2026
│   │   └── Travel
│   └── bob
└── shared
    ├── Family
    └── Baby
```

数据库只保存索引、权限与元数据。

即使 77Photo 停止维护，照片仍然可以直接通过文件系统读取、备份、迁移。

### 2.3 原图不可破坏

默认规则：

- 不修改原始照片内容
- 不把 EXIF 写回原图
- 不覆盖原文件来生成预览
- 缩略图全部放入缓存目录
- 元数据写入 SQLite

### 2.4 Web 优先

V1 使用响应式 Web / PWA，一套界面适配：

- Android
- iOS
- iPadOS
- Windows
- macOS
- Linux

原生 Android/iOS 应用不是 V1 前置条件。

但服务端 API 与 Web UI 解耦，为后续原生客户端留出空间。Android 重建方向见 [从零设计](ui/ANDROID_FROM_WEB.md)；技术栈和自动备份实现尚未确定。

---

## 3. 非目标

以下能力不进入 V1：

- AI 语义搜索
- 人脸识别
- 自动人物聚类
- 地图浏览
- RAW 在线处理
- Live Photo 特殊处理
- 在线图片编辑
- Google Photos / iCloud 导入器
- 视频硬件转码
- 智能相册
- 原生 Android / iOS 后台自动备份

V1 对视频仅做最低限度支持：

- 保存文件
- 识别媒体类型
- 浏览器原生支持的格式可以直接播放
- 可选生成 poster
- 不做服务器端转码

---

## 4. 推荐技术栈

### Backend

- Go
- REST API
- SQLite
- `database/sql` + 轻量 SQLite driver
- libvips 或兼容实现负责高效图片缩放

Go 的原因：

- 单二进制部署简单
- ARM64 支持成熟
- 常驻内存相对可控
- 并发模型适合图库 API
- 非常适合家庭服务器

### Frontend

推荐：

- React
- TypeScript
- Vite
- PWA
- CSS Grid / Flexbox

避免第一版引入复杂 SSR 运行时。

生产环境可以由 Go 直接托管构建后的静态资源，从而减少额外进程。

### Database

SQLite 作为默认数据库。

建议：

- WAL mode
- foreign keys enabled
- 对 `owner_id`、`taken_at`、`folder_id`、`checksum` 建索引
- 数据库文件单独持久化

V1 不需要 PostgreSQL。

---

## 5. 总体架构

```text
                ┌──────────────────────┐
                │ Responsive Web / PWA │
                └──────────┬───────────┘
                           │ HTTPS
                           ▼
                ┌──────────────────────┐
                │      Go Server       │
                │                      │
                │ Auth / ACL           │
                │ Photo API            │
                │ Folder API           │
                │ Upload API           │
                │ Thumbnail worker     │
                └──────┬────────┬──────┘
                       │        │
                 SQLite│        │Filesystem
                       ▼        ▼
                ┌─────────┐  ┌──────────────┐
                │photo.db │  │ /photos      │
                └─────────┘  │ /cache       │
                             └──────────────┘
```

V1 不部署独立 worker。

缩略图任务放在 Server 内部，通过有限长度队列和固定并发执行。

---

## 6. 存储模型

### 6.1 用户目录

推荐默认结构：

```text
/photos/users/{user-id}/
```

例如：

```text
/photos/users/1/2026/IMG_0001.jpg
/photos/users/2/Travel/IMG_1234.jpg
```

不要直接使用用户名作为真实路径中的唯一身份标识，避免用户名修改造成迁移问题。

UI 可以显示用户名，但内部使用不可变 user ID。

### 6.2 共享目录

```text
/photos/shared/{folder-id}/
```

共享目录本身也属于一个资源，通过旧的 ACL 控制成员访问权限。对外分享使用独立的只读 `share_links`，不会改变成员权限模型。

### 6.3 缩略图目录

缩略图不与原图混放。

```text
/cache/thumbnails/
├── 256/
├── 512/
└── 1280/
```

文件名建议基于稳定 photo ID + source revision/hash，而不是直接使用原文件名。

例如：

```text
/cache/thumbnails/256/01JABC123.webp
/cache/thumbnails/512/01JABC123.webp
/cache/thumbnails/1280/01JABC123.webp
```

V1 推荐三档：

- 256 px：手机网格
- 512 px：高 DPI 网格
- 1280 px：详情预览

只有用户明确选择“查看原图”时才读取完整原文件。

---

## 7. 文件夹即相册

V1 不引入虚拟 Album 模型。

一个文件夹就是一个相册。

```text
/photos/users/1/
├── 2026
│   ├── 宝宝满月
│   ├── 宝宝百日
│   └── 家庭聚会
└── 旅行
```

对应 UI：

```text
文件夹

2026
├── 宝宝满月      238
├── 宝宝百日      315
└── 家庭聚会       84
```

这样可以避免：

- album 表
- album-photo 多对多关系
- 虚拟集合与磁盘目录不一致
- 删除/移动后需要复杂同步

未来如果确实需要“收藏”“虚拟相册”，可以在 V2 作为额外逻辑加入，而不改变真实文件结构。

---

## 8. 数据模型

以下为逻辑模型，具体 SQL 可在实现阶段细化。

### users

```text
id
username
password_hash
role
is_active
created_at
updated_at
```

`role` 第一版只需要：

- admin
- user

### folders

```text
id
owner_id
parent_id
storage_path
name
is_shared
created_at
updated_at
```

`storage_path` 必须由后端生成和维护，不允许客户端提交任意绝对路径。

### photos

```text
id
owner_id
folder_id
storage_path
filename
mime_type
size
width
height
checksum
captured_at
file_created_at
indexed_at
created_at
updated_at
```

其中：

- `captured_at` 优先取 EXIF 拍摄时间
- 没有 EXIF 时回退到文件时间
- `checksum` 用于重复文件检测和变更判断

### shares（legacy member ACL）

```text
id
resource_type
resource_id
user_id
permission
created_at
```

`permission` 第一版：

- read
- write

管理员不依赖 share 记录管理系统资源。

### share_links

公开链接独立于旧的家庭成员 ACL：

```text
id
resource_type       # photo 或 folder
resource_id
token_hash
password_hash       # 可选，仅保存 Argon2id 摘要
expires_at          # 1 天、7 天或 NULL（永久）
created_at
updated_at
revoked_at
```

链接本身是只读的。照片链接只暴露一张照片，文件夹链接只暴露该文件夹及其子文件夹中的照片。原图下载、编辑、删除和成员选择都不属于公开链接能力。

### sessions

如果使用服务端 Session：

```text
id
user_id
token_hash
expires_at
created_at
last_seen_at
```

建议优先使用 HttpOnly Secure Cookie，而不是把长期 token 存在浏览器 LocalStorage。

---

## 9. 身份认证与安全

### 9.1 密码

推荐使用 Argon2id。

要求：

- 每个用户独立 salt
- 参数可配置但提供安全默认值
- 登录接口有基础速率限制
- 错误信息不区分“用户不存在”和“密码错误”

### 9.2 Session

推荐：

- HttpOnly Cookie
- Secure
- SameSite=Lax 或更严格
- Session 可撤销

家庭内网部署也不应假设“不需要安全”。

### 9.3 路径安全

这是项目必须重点保证的部分。

禁止客户端通过 API 直接请求服务器文件路径，例如：

```text
GET /api/file?path=/photos/users/2/private.jpg
```

正确方式：

```text
GET /api/photos/{photoId}
```

后端执行：

```text
photoId
  ↓
DB lookup
  ↓
owner / share ACL
  ↓
normalize internal storage path
  ↓
verify path is inside configured storage root
  ↓
read file
```

必须防止：

- `../` path traversal
- symlink escaping storage root
- 用户通过重命名构造非法路径
- API 越权访问其他用户资源

---

## 10. V1 API 设计

统一前缀：

```text
/api/v1
```

### Auth

```text
POST   /api/v1/auth/login
POST   /api/v1/auth/logout
GET    /api/v1/auth/me
```

### Users - admin only

```text
GET    /api/v1/users
POST   /api/v1/users
PATCH  /api/v1/users/{id}
DELETE /api/v1/users/{id}
```

删除用户时默认不得直接删除其照片，需要明确选择处理方式。

### Folders

```text
GET    /api/v1/folders
GET    /api/v1/folders/{id}
POST   /api/v1/folders
PATCH  /api/v1/folders/{id}
DELETE /api/v1/folders/{id}
POST   /api/v1/folders/{id}/move
```

### Photos

```text
GET    /api/v1/photos
GET    /api/v1/photos/{id}
GET    /api/v1/photos/{id}/thumbnail?size=256
GET    /api/v1/photos/{id}/preview
GET    /api/v1/photos/{id}/original
POST   /api/v1/photos/upload
POST   /api/v1/photos/{id}/move
PATCH  /api/v1/photos/{id}
DELETE /api/v1/photos/{id}
```

图库查询参数建议：

```text
GET /api/v1/photos?folder_id=123&cursor=...&limit=100
GET /api/v1/photos?from=2026-09-01&to=2026-09-30
```

优先使用 cursor pagination，避免大图库中 offset 越来越慢。

### Legacy member ACL share

```text
GET    /api/v1/shares
POST   /api/v1/shares
DELETE /api/v1/shares/{id}
```

以上接口保留用于兼容已有成员 ACL，但不再由 Web 导航或分享页面使用。

### Public link share

```text
POST   /api/v1/share-links
GET    /api/v1/share-links/{token}
POST   /api/v1/share-links/{token}/unlock
GET    /api/v1/share-links/{token}/photos
GET    /api/v1/share-links/{token}/photos/{photoId}/preview
```

创建链接需要登录、资源所有权（或管理员权限）和 CSRF。接收者不需要登录；没有设置密码时任何持有链接的人都可以查看。设置密码后，接收者先通过解锁接口，服务器下发仅 HttpOnly、按链接路径限定的访问 cookie。

有效时长只有 `1_day`、`7_days` 和 `forever`。公开页面只显示预览或浏览器内联视频，不提供原图下载、上传、编辑、删除、权限设置或家庭成员选择。

---

## 11. 上传流程

```text
Browser
   │
   │ multipart upload
   ▼
Go Server
   │
   ├── auth / ACL
   ├── validate MIME / extension
   ├── generate safe destination name
   ├── write temp file
   ├── fsync / atomic rename
   ├── calculate checksum
   ├── extract metadata
   ├── insert DB row
   └── enqueue thumbnail generation
```

关键要求：

- 上传先进入临时文件
- 完成校验后 atomic rename
- 中断上传不得留下数据库脏记录
- 默认限制最大上传尺寸，可配置
- 禁止客户端指定任意服务器绝对路径

后续 V2 可以加入分片上传。

---

## 12. 缩略图策略

### 12.1 Lazy + background generation

上传成功后将生成任务加入内部队列。

如果图库请求的缩略图还不存在：

- 可以同步生成一次小图
- 或返回 placeholder，并由后台补齐

第一版优先保证简单可靠。

### 12.2 并发限制

低配设备上图片解码很容易瞬间吃满 CPU 和内存。

因此缩略图 worker 必须可配置：

```text
THUMBNAIL_WORKERS=1
```

默认值为 1。

不要按照 CPU 核数自动开高并发。

### 12.3 格式

首选 WebP。

原始照片可能是 JPEG/PNG/HEIC，但缩略图缓存统一输出 WebP 可以减少存储与网络流量。

如果 ARM64 环境中的 HEIC 依赖部署过于复杂，可以把 HEIC 完整支持推迟到 V1.x。

---

## 13. 图库页面

### Mobile

```text
┌─────────────────┐
│ ☰   77Photo  🔍 │
├─────────────────┤
│ 2026年9月       │
│                 │
│ ▣ ▣ ▣           │
│ ▣ ▣ ▣           │
│ ▣ ▣ ▣           │
│                 │
│ 2026年8月       │
│ ▣ ▣ ▣           │
│ ▣ ▣ ▣           │
├─────────────────┤
│ 图库  文件夹  我的 │
└─────────────────┘
```

### Desktop

```text
┌────────┬──────────────────────────────────┐
│ 图库   │ 2026年9月                       │
│ 文件夹 │                                  │
│ 设置   │ ▣ ▣ ▣ ▣ ▣ ▣                    │
│        │ ▣ ▣ ▣ ▣ ▣ ▣                    │
│        │ ▣ ▣ ▣ ▣ ▣ ▣                    │
│        │                                  │
│ 设置   │                                  │
└────────┴──────────────────────────────────┘
```

### 页面组成

V1 建议只有以下核心页面：

1. 登录
2. 图库时间线
3. 文件夹浏览
4. 图片详情
5. 上传
6. 我的设置
7. 管理员用户管理

不要在第一版堆太多导航入口。

---

## 14. 图片详情页

详情页提供：

- 1280 px preview
- 文件名
- 拍摄时间
- 分辨率
- 文件大小
- 所在文件夹
- 下载原图
- 移动
- 重命名
- 删除
- 只读分享链接（Share2 icon）

EXIF 信息第一版只展示常用字段：

- camera make/model
- capture time
- focal length
- aperture
- ISO

GPS 可以读取但第一版不需要做地图 UI。

---

## 15. 响应式设计

同一 React 页面通过 breakpoint 变化布局，不维护独立 mobile Web。

建议：

```text
< 640 px      phone
640-1024 px   tablet
> 1024 px     desktop
```

图库网格不要固定列数，优先使用：

```css
grid-template-columns: repeat(auto-fill, minmax(...));
```

移动端重点：

- 大触摸区域
- 底部导航
- 图片滑动查看
- 上传入口明显
- 避免 hover-only 操作

桌面端重点：

- 左侧导航
- 键盘操作
- 多选
- 更高信息密度

---

## 16. PWA

V1 可以支持：

- Web App Manifest
- 添加到桌面
- standalone 模式
- 静态资源缓存
- 基础离线壳页面

但不要把 PWA 当成可靠的手机后台自动备份方案。

特别是在 iOS 上，浏览器后台任务限制不适合长期监控相册并上传。

---

## 17. 未来原生客户端

未来 Android App 应复用同一 REST API；具体技术栈在重建时重新评估。

```text
React Web ────────┐
                  ├── REST API ── Go Server
Android 客户端 ───┘
```

原生 App 先交付安全浏览与手选上传；Web 难以可靠实现的以下能力应作为后续独立阶段评估：

- 后台相册扫描
- 自动备份
- Wi-Fi only
- 充电时上传
- 上传失败重试
- 上传状态通知

不要为了“看起来像 App”而过早维护两套 UI，也不要在自动备份的授权和可靠同步尚未实现时宣称它已经可用。

---

## 18. 文件索引

除了用户通过 77Photo 上传，未来可能需要支持管理员直接把已有照片复制到 `/photos`。

因此需要设计可重复执行的索引器：

```text
scan filesystem
   ↓
compare indexed files
   ↓
new file      -> index
changed file  -> refresh metadata + invalidate thumbnails
missing file  -> mark missing / remove index
```

V1 可以先提供管理员手动触发：

```text
POST /api/v1/admin/rescan
```

之后再考虑定时扫描或文件系统 watch。

避免第一版依赖 inotify 作为唯一真相来源，因为 NAS、网络挂载和批量迁移可能丢事件。

---

## 19. 删除策略

第一版建议支持软删除/回收站，而不是立即 unlink。

推荐：

```text
/photos/.trash/{user-id}/...
```

数据库增加：

```text
deleted_at
```

可提供：

- 恢复
- 永久删除
- 管理员清空回收站

家庭照片误删的代价很高，因此安全优先于实现省事。

如果 V1 为控制范围暂不实现完整回收站，至少 UI 中的永久删除必须有明确二次确认。

---

## 20. 重复照片

V1 上传时可以计算 SHA-256 或更快的内容 hash。

用途：

- 同目录重复上传提示
- 索引变化判断
- 缩略图缓存失效

V1 不需要全局自动去重。

多个用户拥有内容相同的照片时，默认仍然保留各自独立文件，避免 dedup 引入引用计数和删除语义复杂度。

---

## 21. 部署

推荐支持两种形式。

### Docker Compose

```text
77photo
├── /data/database
├── /data/photos
└── /data/cache
```

只需要一个应用容器。

### Standalone

发布：

- linux-arm64

Go 二进制内嵌 Web 静态资源。

这对 NanoPi / Raspberry Pi 特别友好。

---

## 22. 配置

建议环境变量示例：

```text
PHOTO_DATA_DIR=/data/photos
PHOTO_CACHE_DIR=/data/cache
PHOTO_DB_PATH=/data/database/77photo.db
PHOTO_LISTEN_ADDR=:8080
PHOTO_THUMBNAIL_WORKERS=1
PHOTO_MAX_UPLOAD_SIZE=10737418240
PHOTO_SESSION_TTL=720h
```

所有目录在启动时做：

- existence check
- permission check
- writable/readable check

如果配置错误，应 fail fast，而不是启动后再出现模糊错误。

---

## 23. 备份策略

77Photo 不应该把“图库软件正常运行”误认为“照片已经备份”。

至少需要明确三个需要备份的对象：

```text
/photos          必须
/photo.db        必须
/cache           可丢弃，可重新生成
```

设计上保证删除整个 `/cache` 后服务仍然可以正常恢复。

数据库备份应考虑 SQLite WAL 状态，不能简单在高写入期间复制不完整数据库文件。

---

## 24. 日志与可观测性

V1 只需要结构化日志：

- server start/stop
- login failure
- upload success/failure
- scan result
- thumbnail failure
- unauthorized access
- filesystem error

禁止在日志中记录：

- 用户密码
- Session token
- 完整 Authorization header

可以提供：

```text
GET /healthz
```

返回数据库和核心存储可用性。

---

## 25. V1 功能清单

V1 完成标准：

### Authentication

- [ ] 首次启动创建管理员
- [ ] 登录 / 登出
- [ ] 多用户
- [ ] 管理员创建、禁用用户

### Storage

- [ ] 用户独立根目录
- [ ] 文件夹创建
- [ ] 文件夹重命名
- [ ] 文件夹移动
- [ ] 文件夹删除

### Photos

- [ ] 单张上传
- [ ] 批量上传
- [ ] 图片索引
- [ ] EXIF 拍摄时间
- [ ] 256 / 512 / 1280 缩略图
- [ ] 图库浏览
- [ ] 原图下载
- [ ] 移动
- [ ] 重命名
- [ ] 删除

### Sharing

- [ ] 从照片详情页创建只读公开链接
- [ ] 从文件夹行创建只读公开链接
- [ ] 1 天 / 7 天 / 永久时长与可选密码
- [ ] 公开链接照片与文件夹文案区分
- [ ] 公开查看页不提供原图下载和编辑操作

### Web

- [ ] 登录页
- [ ] 时间线
- [ ] 文件夹页
- [ ] 图片详情页
- [ ] 上传界面
- [ ] 用户设置
- [ ] 管理员用户管理
- [ ] 手机 / 平板 / PC 响应式
- [ ] PWA manifest

### Operations

- [ ] Docker image
- [ ] linux-arm64 build
- [ ] health check
- [ ] 基础日志
- [ ] 手动 rescan

---

## 26. V2 候选功能

在 V1 稳定之后再考虑：

- 收藏
- 公开链接批量管理与更丰富的访问控制
- 分片上传
- Android 自动备份 App
- 上传失败恢复
- HEIC 更完整支持
- 视频 poster
- 更丰富的 EXIF
- 回收站
- 批量选择与批量操作
- 相似文件检测
- 全文搜索
- WebAuthn / Passkey

---

## 27. V3 / 可选高级功能

仅当项目仍保持清晰边界且设备资源允许时考虑：

- 人脸识别
- CLIP 语义搜索
- 地图
- Live Photo
- RAW preview
- 视频转码
- iOS 原生自动备份

这些能力建议以可插拔形式实现，避免强制所有用户承担资源成本。

例如未来 AI 可以独立成为：

```text
77Photo Core
     │
     └── optional AI service
```

核心服务即使不部署 AI 也必须完整可用。

---

## 28. 建议开发顺序

### Phase 1 - Skeleton

1. Go server
2. SQLite migration
3. React shell
4. 登录与用户
5. Docker / ARM64 CI

### Phase 2 - Core storage

1. 文件夹模型
2. 上传
3. metadata extraction
4. checksum
5. 文件读取权限

### Phase 3 - Gallery

1. thumbnail worker
2. timeline API
3. responsive grid
4. photo viewer
5. cursor pagination

### Phase 4 - Family features

1. shared folders
2. ACL
3. admin user management
4. manual rescan

### Phase 5 - Hardening

1. path traversal tests
2. permission boundary tests
3. corrupted image handling
4. interrupted upload handling
5. large-library performance tests
6. backup/restore documentation

---

## 29. V1 验收场景

### 场景 A：家庭成员独立使用

- Alice 登录
- 上传照片到自己的 `2026/宝宝` 文件夹
- Bob 登录后无法查看 Alice 的私人目录

### 场景 B：公开分享

- Alice 从照片详情或文件夹行创建公开链接
- 可选择 1 天、7 天、永久，并可选设置密码
- 没有密码时接收者无需登录即可查看
- 有密码时接收者只能解锁后查看，且只能看到预览

### 场景 C：图库浏览

- 用户打开手机 Web
- 首屏只请求小尺寸缩略图
- 滚动时继续分页
- 点击照片加载 preview
- 点击“原图”后才传输完整文件

### 场景 D：低资源设备

- NanoPi R5S 同时运行其他 Docker 服务
- 77Photo 空闲时不持续占用 CPU
- thumbnail worker 默认只运行一个任务
- 不运行 AI 与视频转码服务

### 场景 E：软件退出后的数据可读性

- 停止 77Photo
- 管理员仍然可以直接从 `/photos` 中找到完整原始照片
- 删除 `/cache` 不影响原图
- 重新启动后可重建缩略图

---

## 30. 项目边界

当一个新功能需要引入以下任一内容时，需要先重新评估是否符合 77Photo 的定位：

- 新的长期运行服务
- 新的数据库
- 新的消息队列
- 大量常驻内存
- GPU / NPU 强依赖
- 大规模视频转码
- 修改原始照片格式

核心判断标准：

> 这个功能是否值得让所有家庭部署都承担额外复杂度？

如果答案是否定的，应优先设计为可选模块。

---

## 31. 总结

77Photo 的竞争力不来自“功能比 Immich 更多”，而来自：

- 足够简单
- 足够轻
- 文件系统透明
- 原图可迁移
- 低配 ARM64 设备友好
- 家庭多用户体验完整
- Web 与未来原生 App 共用 API

V1 应严格控制范围，先把：

```text
多用户
+ 文件夹
+ 图库
+ 上传
+ 缩略图
+ 权限
+ Responsive Web
```

做到稳定、快速、低资源占用。

只要这一层足够扎实，后续无论增加 Android 自动备份、分享、搜索还是可选 AI，都可以在不推翻核心架构的前提下逐步扩展。
