# 轻小说与漫画书库

**Novel & Manga Library** 是为 NAS 上的轻小说和漫画设计的自托管管理台。从网页里搜索作品、挑选分卷或章节、查看下载进度，再把 EPUB 或 CBZ 收进自己的书库。已有 Komga 的话，可以继续用它阅读和管理藏书。

[本地预览](#本地预览) · [飞牛 NAS 部署](docs/DEPLOY-NAS.md#4-web-管理台bff--live-前端) · [使用手册](web/README.md) · [DSH 插件](docs/DSH-MANGA.md)

## 从搜索到入库

**下载轻小说。** 找到作品后选卷，交给 Dart 下载引擎生成 EPUB。已完成的文件可在书库查看、下载和校验。需要单文件阅读时，可将多卷合成一个 EPUB。

**下载漫画。** 搜索已在 Suwayomi 安装的来源，按章节提交下载，查看真实队列状态。归档服务自动保存单话 CBZ。选用分卷归档时，凑齐已核验的单行本目录后会自动合卷，并写入章节书签。

**整理自己的书库。** 轻小说和漫画可以分别选定 NAS 保存位置，也可以同步 Komga 的书库路径。Studio 提供书库浏览和下载管理，Komga 负责扫描、阅读和阅读进度。网页支持桌面与手机布局，并提供浅色、深色和跟随系统三种外观。

## 给藏书补上 Bangumi 元数据

在 **系统设置 → 刮削** 开启功能，选择 Bangumi 实时 API 或挂载的官方离线档案，并设置 Komga 在什么时候刷新书库。BangumiKomga 内置于 Studio Web 容器。

DSH 可通过 `komga_bangumi_metadata` 搜索候选作品，对指定系列或单册生成修改预览。确认后才写入 Komga，保留锁定的字段和现有册序。刮削使用单独的 API 密钥，查书库和下载进度可继续使用 Studio 的只读密钥。[刮削配置与调用说明](docs/BANGUMIKOMGA.md)

## 本地预览

准备 Node.js 24.9 或更新版本。以下命令启动演示模式，可直接体验搜索、书库和下载界面。

```sh
git clone https://github.com/xieqiong111/novel-manga-library.git
cd novel-manga-library
npm --prefix web ci
npm --prefix web run dev -- --host 127.0.0.1
```

在浏览器打开终端显示的地址，默认是 `http://127.0.0.1:5173`。

## 在 NAS 上部署

Studio 针对飞牛 NAS 与 Linux x86-64 Docker 主机提供部署指南。准备 Live 前端、Dart 运行器和持久化目录后，构建并启动 Web 服务。首次打开管理台时，通过部署初始化码创建管理员账号。Studio 默认使用端口 `5273`，Web 管理本身无需安装 DSH。

| 想接入的功能 | 所需组件与配置 |
| --- | --- |
| 轻小说 EPUB 下载 | Dart 运行器与启用的轻小说来源。[配置轻小说引擎](docs/CONFIG.md) |
| 漫画搜索、下载与追更 | Suwayomi 及其已安装的漫画源。[连接 Suwayomi](docs/MANGA.md) |
| 按章生成 CBZ | 独立的章节归档服务与可写的漫画目录。[部署 CBZ 归档](docs/MANGA-VOLUME-CBZ.md) |
| 浏览 Komga、同步目录或请求扫描 | Komga 连接及对应权限。[配置 Komga](docs/KOMGA.md) |
| Agent 下载、看进度或刮削 | DSH 0.2.2-rc.1 原生插件及对应服务配置。[安装 DSH 插件](docs/DSH-MANGA.md) |

需要让 DSH 与网页共用下载任务和进度时，启用 [Studio 托管模式](docs/DSH-STUDIO-JOBS.md)。

[从零部署 Studio](docs/DEPLOY-NAS.md#4-web-管理台bff--live-前端) · [首次创建管理员](web/README.md#首次创建管理员) · [HTTP API](web/README.md#http-api)

## 开发

前端与服务端分别维护在 `web/` 和 `server/`，DSH 原生工具位于 `src/`。Dart 下载核心与 CBZ 归档服务各自独立，可分别构建和验证。[开发命令与测试入口](docs/README.md#开发和验证)

项目采用 [MIT 许可证](LICENSE)，轻小说核心基于 [bili_novel_packer](https://github.com/montaro2017/bili_novel_packer)。上游组件及其归属见 [第三方声明](THIRD_PARTY_NOTICES.md)。
