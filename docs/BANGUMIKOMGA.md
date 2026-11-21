# 在 DSH 中刮削 Komga 元数据

Studio 在 Web 容器内运行 [BangumiKomga](https://github.com/chu-shen/BangumiKomga) 的转换模块获取 Bangumi 元数据。Docker 镜像固定上游源码版本。DSH 工具可以搜索候选、列出系列的单册、预览改动，并将已确认的变更写到 Komga。支持漫画和轻小说，以及系列和单册。

单次操作只处理一个明确选定的条目。系列可更新标题、简介、出版社、别名、标签和链接。单册可更新简介、作者、发行日期、标签和链接。已有的锁定字段、文件、封面、册序和阅读进度保留。已有自定义标签、作者、别名和链接会合并。若 Komga 的 `cbl` 链接指向另一条目，工具会要求重新核对。

## Docker 和 DSH 0.2.2-rc.1

1. 在 Studio「系统设置 → 服务集成」配置 Komga。写元数据需要 Komga 管理员权限，也可只通过部署时配置的 `LN_KOMGA_*` 连接。Studio 继续使用现有的 Komga 连接。 [Komga 系列接口](https://komga.org/docs/openapi/update-series-metadata/) · [Komga 单册接口](https://komga.org/docs/openapi/update-book-metadata/)
2. 在 Studio 已挂载的数据目录的 `auth` 下生成专用密钥。下例使用默认宿主机目录 `./data`，首次部署若使用其他路径，把命令里的目录改为实际值。生成后仅让 Studio 和 DSH 的运行账户读取该文件。
   ```sh
   mkdir -p ./data/auth
   (umask 077; set -C; node -e 'process.stdout.write("studio_metadata_" + require("node:crypto").randomBytes(32).toString("base64url") + "\n")' > ./data/auth/studio-metadata.token)
   ```
3. 为 Studio 配置密钥文件并构建 Web 镜像。Studio 通过进程标准输入输出调用内置转换模块。需要访问受限 Bangumi 条目时可选配服务端 `BANGUMI_ACCESS_TOKEN`。
   ```dotenv
   LN_STUDIO_METADATA_TOKEN_FILE=/data/auth/studio-metadata.token
   ```
   ```sh
   docker compose -f docker-compose.web.yml up -d --build web
   ```
4. 在 DSH 环境安装本版本插件并重启 DSH 进程。为 DSH 设置它能访问的 Studio 地址和专用密钥文件路径。独立 DSH 容器挂载该文件后使用容器内路径。已设 `LN_STUDIO_READ_URL` 时可复用其地址。现有 `studio_read` 继续使用自己的只读密钥。
   ```dotenv
   LN_STUDIO_METADATA_URL=http://lightnovel-studio-web:8080
   LN_STUDIO_METADATA_TOKEN_FILE=/data/auth/studio-metadata.token
   ```

## WebUI 设置

打开「系统设置 → 刮削」。部署了内置模块和元数据密钥文件时，刮削默认开启。关闭后，DSH 提交的搜索、预览和写入请求会返回 `BANGUMIKOMGA_DISABLED`。

自动刷新默认为「同步路径后」。可改为「仅手动刷新」，或设为「同步路径或刮削写入后」，让成功写入元数据的操作也向 Komga 提交书库扫描。搜索和预览不会触发扫描。`apply` 响应中的 `updated` 表示元数据写入成功，`scan.accepted` 单独表示 Komga 是否接受后台扫描，`scan.skipped` 表示本次未启用自动扫描。

「Bangumi 配置」可以选择官方实时 API 或已安装的官方离线档案，也可填写或清除用于实时 API 的 Bangumi 访问令牌。保存立即生效。

管理员也可以通过 `POST /api/settings/integrations` 保存这两项设置。请求带 `action: "save-komga-preferences"`、布尔值 `scrapeEnabled` 和刷新方式 `refreshMode`（`manual`、`after-sync` 或 `after-sync-or-scrape`）。

## 使用 Bangumi 官方离线档案

如果部署主机无法访问实时 API，可下载并验证 [Bangumi Archive](https://github.com/bangumi/Archive) 的公开快照。把解压后的 `subject.jsonlines` 和 `subject-relations.jsonlines` 挂载到 `web` 容器，设置 `BANGUMI_ARCHIVE_DIR` 为容器内目录。目录须允许 Studio 运行用户写入索引，或预先用同版本 BangumiKomga 生成索引再只读挂载。可同时放入 `archive_update_time.json` 并将 `last_updated` 设为快照时间。搜索和预览结果附带 `source` 和可用的档案时间。更新档案后重启 Studio 以重新加载索引。

## Agent 调用

查找 Komga 系列可用 `studio_read(resource="komga")` 和 `studio_read(resource="komgaSeries", libraryId="…")`，或者从 Komga 中获取对应 ID。

| `komga_bangumi_metadata` 的 `action` | 参数 | 行为 |
| --- | --- | --- |
| `search` | `kind` 为 `novel` 或 `manga`，`scope` 为 `series` 或 `book`，以及 `query` | 返回 Bangumi 条目 ID、中文和原文标题、简介与链接。排序分数用于排查匹配 |
| `books` | `seriesId`，可选 `page`，从 0 开始 | 返回系列下的 Komga 单册 ID 与册序 |
| `preview` | `kind`、`scope`、`seriesId`、`subjectId`，单册另填 `bookId` | 返回修改前后差异。存在改动时返回有效期 10 分钟的 `previewId` |
| `apply` | `previewId` | 用户确认后调用。写入一个条目，当前值变化时返回冲突并要求重新预览 |

HTTP 对应 `POST /api/komga/metadata/{search,books,preview,apply}`，请求 JSON 仅包含上表所列参数。使用 `Authorization: Bearer <元数据专用密钥>`。搜索和预览的状态由实际服务响应决定。写入以 Komga 返回 `204` 为准。预览由当前 Studio 进程管理，服务重启后重新生成。
