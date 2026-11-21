# 下载后打包为 CBZ

独立归档服务每 60 秒查看 Suwayomi 已下载的章节。WebUI、DSH 以及 Suwayomi 自己的下载都由同一个服务归档。归档通过 Suwayomi 的 `/api/v1/chapter/{id}/download` 读取已完成的数据，沿用原始图片格式和页序。归档文件含连续页号和供 Komga 读取的 `ComicInfo.xml`。

- 每章下载完成后自动生成一个 CBZ。带卷号的分话也逐章生成，无需等待同卷的其他章节。
- 例如 `第001话 [7350].cbz`。末尾是 Suwayomi 章节 ID，可区分同话的不同版本。无话号的独立章节用 `章节 [7350].cbz`。
- 来源若只提供整卷条目，须换成提供分话的来源。旧卷包保留，已在旧卷包中的章节不会自动再写一份。
- CBZ 直接写入所选漫画目录下以作品名命名的文件夹。来源与作品 ID 保存在隐藏标记中。同名冲突时以来源和作品 ID 区分目录。

## Studio 按章下载

在漫画详情勾选章节后点击「下载选中章节」。章节下载完会由 Docker 自动打包。归档状态和文件名显示在章节旁，亦可点击「刷新归档状态」。Komga 扫描输出目录后会收录文件。

使用 `POST /api/manga/:id/komga`，请求体为 `{"chapterIds":["30","31"]}`。可用 `GET /api/manga/:id/komga?chapterIds=30,31` 查询各章归档状态。旧卷号提交返回 HTTP `409`。

## DSH 和 Docker 进度

将 DSH 接入 Studio 使用的同一归档服务，为 DSH 配置 `LN_VOLUME_ARCHIVE_URL`，或经由 `mangaConnectionFile` 提供。Agent 先通过 `manga_komga_status` 确认可归档的章节 ID，再用 `manga_komga_download` 提交。详见 [Agent 约束](DSH-MANGA-ARCHIVE-RULES.md)。

`waiting_archive` 表示 Suwayomi 下载完、等待 Docker 写入 CBZ。`archived` 和返回的文件名确认单章文件已生成。`in_legacy_volume` 指该章节已保存在旧卷包。`archive_failed` 表示打包失败。只有 Suwayomi 提供了队列百分比时，才会在 `task.percent` 返回进度值。

归档容器还提供内部只读 `GET http://suwayomi-volume-cbz:8788/downloads`，返回 Suwayomi 的当前队列。容器每 15 秒查看一次队列，只在状态或百分比变化时记录日志。运行 `docker compose -f docker/volume-cbz/compose.yml logs -f volume-cbz` 可以查看下载进度和 CBZ 生成记录。

## Docker 部署

用现有 Suwayomi 实例的 Docker 网络。创建专用输出目录，例如 Komga 已扫描的漫画目录，让归档容器运行用户可写且让 Komga 可读。NAS 上可以让这两个容器使用同一 UID/GID。Docker 归档容器仅挂载此子目录，认证 JSON 以只读方式挂载。认证文件需要运行用户能读取，建议权限 `0600`，无需提交到仓库。可以复用 DSH 的连接 JSON，文件字段为 `LN_SUWAYOMI_URL`，若 Suwayomi 启用了 Basic 认证，再填写 `LN_SUWAYOMI_USERNAME` 和 `LN_SUWAYOMI_PASSWORD`。URL 应为容器可访问的 HTTP(S) origin，例如 `http://suwayomi:4567`。

将以下变量写入本地 `.env` 或通过运行环境传入。

```dotenv
SUWAYOMI_VOLUME_NETWORK=dsh-lightnovel-net
SUWAYOMI_VOLUME_CONNECTION_FILE=/path/to/suwayomi.json
SUWAYOMI_VOLUME_OUTPUT_DIR=/path/to/komga/manga
SUWAYOMI_VOLUME_UID=1000
SUWAYOMI_VOLUME_GID=1000
```

```sh
docker compose --env-file .env -f docker/volume-cbz/compose.yml up -d
docker compose --env-file .env -f docker/volume-cbz/compose.yml logs volume-cbz
```

在 Studio 的环境变量中设置 `LN_VOLUME_ARCHIVE_URL=http://suwayomi-volume-cbz:8788`。Studio 与归档服务需加入同一个内部 Docker 网络，归档状态端口无需对宿主机发布。

首次启动会检查已下载的章节。停止归档服务后，已经生成的 CBZ 仍可阅读。`DOWNLOAD_AS_CBZ` 是 Suwayomi 自己的单话打包设置，归档支持 Suwayomi 以图片目录或 CBZ 保存的下载。

## 本地验证

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s docker/volume-cbz -v
```
