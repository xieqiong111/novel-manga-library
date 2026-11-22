# 下载后打包为 CBZ

独立归档服务每 60 秒查看 Suwayomi 已下载的章节。WebUI、DSH 以及 Suwayomi 自己的下载都由同一个服务归档。归档通过 Suwayomi 的 `/api/v1/chapter/{id}/download` 读取已完成的数据，沿用原始图片格式和页序。归档文件含连续页号和供 Komga 读取的 `ComicInfo.xml`。

- 每章下载完成后自动生成一个 CBZ。带卷号的分话也逐章生成，无需等待同卷的其他章节。
- 例如 `第001话 [7350].cbz`。末尾是 Suwayomi 章节 ID，可区分同话的不同版本。无话号的独立章节用 `章节 [7350].cbz`。
- 来源若只提供整卷条目，须换成提供分话的来源。旧卷包保留，已在旧卷包中的章节不会自动再写一份。
- 默认写入所选漫画目录下的作品文件夹。开启分卷归档后，新 CBZ 可放入该作品的单行本子目录。来源与作品 ID 保存在隐藏标记中。

## 可选分卷归档

在「系统设置 → NAS 保存目录 → 漫画分卷归档」打开「按单行本建立子目录」，并选择目录来源。可以随时关闭。已归档的文件继续以原位置提供，切换设置不会迁移或重复打包它们。

```text
漫画/
└── 为美好的世界献上祝福！/
    ├── 第01卷/
    │   ├── 第001话 [7350].cbz
    │   └── 第002话 [7351].cbz
    ├── 第02卷/
    │   └── 第006话 [7355].cbz
    └── 未分卷/
        └── 第141话 [7490].cbz
```

Studio 先绑定 Bangumi 漫画系列和 Suwayomi 的确切来源与作品。出版社目录和已核对的参考目录可供匹配。配置 OpenTomeDB 后，Studio 可以用 Bangumi 单行本的确切 ISBN 匹配该版本。重复话号、无法确认的拆话、缺少目录和冲突列入「未分卷」。

在「刮削设置」打开「下载后刷新」和「Komga 收录后自动刮削」，按需启用封面。Studio 在作品目录中为已下载的章节建立带卷号的硬链接，并在 Komga 中排除底层分卷目录。Komga 将这些入口收录到同一个漫画系列。每卷对应的 Bangumi 单行本链接和不同封面挂在该卷已收录的代表章节上。代表章节保留其原本的话名。卷资料也可以在 Studio 的「按单行本查看」中查询。原 CBZ 与下载记录仍使用卷目录。

在漫画详情选择「按单行本查看」后，可以查询 Bangumi 单行本，或用选中卷的 ISBN 查询已配置的 OpenTomeDB。OpenTomeDB 官方 SQLite 可以放入 Studio 的数据目录，配置 `LN_OPENTOME_SQLITE=/data/manga-metadata.sqlite` 并重启 Studio。数据库以只读方式打开。数据许可和来源见 [OpenTomeDB](https://opentomedb.com/data/)。

《为美好的世界献上祝福！》示例的正篇目录使用 [第 1–20 卷参考目录](https://it.wikipedia.org/wiki/Capitoli_di_Konosuba!_-_This_Wonderful_World) 和 [第 21 卷出版社试读](https://yenpress.com/titles/9798855433692-konosuba-god-s-blessing-on-this-wonderful-world-vol-21-manga)。第 22–23 卷的 [参考话号](https://konosuba.fandom.com/wiki/Category:Konosuba_Chapters) 目前标为待核验。

### 卷目录 API

| 请求 | 用途 |
| --- | --- |
| `GET /api/manga/:id/volume-catalog` | 查看来源、目录、核验状态和 Bangumi 单行本 |
| `POST /api/manga/:id/volume-catalog` ，`action: "resolve"` | 绑定作品并载入参考目录与关联单行本 |
| 同上，`action: "opentome", volume: 1` | 用指定卷的 Bangumi ISBN 匹配 SQLite 版本 |
| 同上，`action: "search-publisher", volume: 21` | 查找 Yen Press 和 KADOKAWA 的官方候选页面 |
| 同上，`action: "verify-publisher", volume: 21, publisherUrl: "…"` | 验证官网页面与卷号、作品或 ISBN，并保存明确的试读章节目录 |

数据不足的发布页面返回 `no-publisher-contents`。日期、ISBN 和卷号存在时，仍需单独的逐话目录才能分卷。Agent 使用 Studio 任务密钥和 `manga_volume_catalog`，可先查找官网，再验证候选页面。

## Studio 按章下载

在漫画详情勾选章节后点击「下载选中章节」。章节下载完会由 Docker 自动打包。归档状态和文件名显示在章节旁，亦可点击「刷新归档状态」。Komga 扫描输出目录后会收录文件。

使用 `POST /api/manga/:id/komga`，请求体为 `{"chapterIds":["30","31"]}`。可用 `GET /api/manga/:id/komga?chapterIds=30,31` 查询各章归档状态。旧卷号提交返回 HTTP `409`。

## DSH 和 Docker 进度

将 DSH 接入 Studio 使用的同一归档服务，为 DSH 配置 `LN_VOLUME_ARCHIVE_URL`，或经由 `mangaConnectionFile` 提供。Agent 先通过 `manga_komga_status` 确认可归档的章节 ID，再用 `manga_komga_download` 提交。详见 [Agent 约束](DSH-MANGA-ARCHIVE-RULES.md)。

`waiting_archive` 表示 Suwayomi 下载完、等待 Docker 写入 CBZ。`archived` 和返回的文件名确认单章文件已生成。`in_legacy_volume` 指该章节已保存在旧卷包。`archive_failed` 表示打包失败。只有 Suwayomi 提供了队列百分比时，才会在 `task.percent` 返回进度值。

归档容器还提供内部只读 `GET http://suwayomi-volume-cbz:8788/downloads`，返回 Suwayomi 的当前队列。容器每 15 秒查看一次队列，只在状态或百分比变化时记录日志。运行 `docker compose -f docker/volume-cbz/compose.yml logs -f volume-cbz` 可以查看下载进度和 CBZ 生成记录。

## Docker 部署

用现有 Suwayomi 实例的 Docker 网络。创建专用输出目录，例如 Komga 已扫描的漫画目录，让归档容器运行用户可写且让 Komga 可读。让 Studio 和归档容器使用相同的 UID/GID，以读取共享设置和卷目录。现有部署若曾以 UID 1000 运行，请沿用已配置的 UID/GID，并核对挂载文件所有者。Docker 归档容器仅挂载此子目录，认证 JSON 以只读方式挂载。认证文件需要运行用户能读取，建议权限 `0600`，无需提交到仓库。可以复用 DSH 的连接 JSON，文件字段为 `LN_SUWAYOMI_URL`，若 Suwayomi 启用了 Basic 认证，再填写 `LN_SUWAYOMI_USERNAME` 和 `LN_SUWAYOMI_PASSWORD`。URL 应为容器可访问的 HTTP(S) origin，例如 `http://suwayomi:4567`。

将以下变量写入本地 `.env` 或通过运行环境传入。

```dotenv
SUWAYOMI_VOLUME_NETWORK=dsh-lightnovel-net
SUWAYOMI_VOLUME_CONNECTION_FILE=/path/to/suwayomi.json
SUWAYOMI_VOLUME_OUTPUT_DIR=/path/to/komga/manga
SUWAYOMI_VOLUME_UID=1001
SUWAYOMI_VOLUME_GID=1001
```

```sh
docker compose --env-file .env -f docker/volume-cbz/compose.yml up -d
docker compose --env-file .env -f docker/volume-cbz/compose.yml logs volume-cbz
```

在 Studio 的环境变量中设置 `LN_VOLUME_ARCHIVE_URL=http://suwayomi-volume-cbz:8788`。Studio 与归档服务需加入同一个内部 Docker 网络，归档状态端口无需对宿主机发布。升级现有实例时，使用 `docker compose -f docker-compose.web.yml up -d --build web` 更新内置 BangumiKomga，再重启归档容器。

首次启动会检查已下载的章节。停止归档服务后，已经生成的 CBZ 仍可阅读。`DOWNLOAD_AS_CBZ` 是 Suwayomi 自己的单话打包设置，归档支持 Suwayomi 以图片目录或 CBZ 保存的下载。

## 本地验证

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s docker/volume-cbz -v
```
