# 让 DSH 通过 Studio 执行任务

启用托管模式后，DSH 原生工具通过 Studio API 搜索、提交下载、管理订阅、查询进度和核对产物。轻小说继续使用 Studio 的 Dart EPUB 引擎。漫画由 Suwayomi 下载，归档服务为每个下载完成的章节生成一个 CBZ。Studio 依照刮削设置执行漫画归档后的 Bangumi 和 Komga 操作。

## 配置

1. 在部署主机上生成任务密钥文件。文件包含前缀 `studio_jobs_` 后接 32 个随机字节的无填充 Base64URL 编码。只允许部署账号和对应容器读取文件。示例使用 Node。

   ```sh
   (umask 077; set -C; node -e 'process.stdout.write("studio_jobs_" + require("node:crypto").randomBytes(32).toString("base64url") + "\\n")' > studio-jobs.token)
   ```

2. 将该文件以只读方式挂载到 Studio 与 DSH。分别在两个容器里设置 `LN_STUDIO_JOB_TOKEN_FILE`，值为对应容器内的绝对路径。Compose 还需在服务的 `volumes` 下添加文件的只读挂载。
3. 在 DSH 设置 `LN_STUDIO_TASK_MODE=managed` 及 `LN_STUDIO_READ_URL=https://studio.example.org`。地址使用 DSH 可访问的 Studio 根地址。部署在同一 Docker 网络时可以使用服务名和容器端口。
4. 如需展示 DSH 原有轻小说任务，将原 `tasks` 目录单独只读挂载给 Studio，并设置 `LN_STUDIO_NOVEL_TASK_HISTORY_DIR` 为容器内路径。旧任务带 `dsh:` 前缀。下载页也会识别 NAS 下载目录里的旧 EPUB 和 CBZ，并标记为「从保存目录恢复」。

任务密钥使用 `Authorization: Bearer …` 请求头。它能提交与取消下载、查询进度和书库、管理漫画订阅及校验 EPUB。管理员操作和元数据写入各有自己的认证。原有 `studio_read` 只读密钥继续可用。

## 任务和下一步

输入作品名后，`novel_search` 和 `manga_search` 会先查询 Bangumi 的同类型系列。确定条目后，Studio 优先用 Bangumi 中文名搜索下载源，条目没有中文名时使用原名。源站未找到匹配作品时再试 Bangumi 列出的别名。碰到多个同名条目时，先选定正确的 `bangumiSubjectId` 并重新搜索。

下载时同时使用源站的作品 ID 和搜索结果中的 `bangumi.id`。新作品文件夹使用 Bangumi 名称，自动替换文件系统不支持的字符。已归档文件保留在原目录。相同名称的其他版本占用目标目录时，Studio 返回冲突并保留原文件。漫画归档容器须与 Studio 共用下载设置目录，以便下载前确认命名。

| DSH 工具 | Studio API | 下一步 |
| --- | --- | --- |
| `novel_search` 或 `manga_search` | `GET /api/bangumi/title`，传入 `kind` 和 `query` | 保留 Bangumi 系列 ID、源站作品 ID 和来源 |
| `novel_download` | `POST /api/tasks`，`volumes` 可传如 `"1,2"` 的卷号或网页提供的卷 ID 数组 | 保留响应中的任务 ID |
| `novel_tasks` | `GET /api/tasks/:id` | 查看实际进度，完成后从 `artifacts[].downloadPath` 下载 EPUB |
| `novel_library` | `GET /api/library/:id`、`POST /api/library/:id/verify` | 核对单个 EPUB 的校验结果 |
| `manga_download` 或 `manga_komga_download` | `POST /api/manga/:id/komga`，`chapterIds` 为漫画源返回的章节 ID | 保留作品 ID 和选中的章节 ID |
| `manga_tasks` 和 `manga_komga_status` | `GET /api/manga/downloads?mangaId=:id`、`GET /api/manga/:id/komga` | 分别查看下载队列、CBZ 文件及 Komga 后续处理状态 |

如果提交时 Studio 连接中断，先从任务列表核对服务是否已经接单。托管模式遇到配置或连接错误时会返回明确的错误，DSH 等待 Studio 恢复后再处理。
