# 漫画下载记录、入库与刮削

漫画下载任务页同时读取 Suwayomi 当前队列与 Docker 归档服务保留的完成记录。完成记录根据 Suwayomi 确认的已下载章节建立，保存在漫画输出挂载中的隐藏数据库。首次运行会补录仍能确认的旧章节。保存路径、CBZ 状态与 Komga 收录分别显示。记录时间是 Studio 首次确认该章节完成的时间。

## 开启下载后的处理

在「刮削」设置的「漫画下载完成后」分别开启刷新与自动刮削。Komga 需要能够读取和扫描相同的 NAS 漫画目录。刷新在 CBZ 写入后发起，自动刮削在 Komga 确认已索引同一路径的 CBZ 后运行。它只修改该文件对应的漫画系列，并遵守已有 Bangumi 关联、锁定字段和书库限制。实时 Bangumi 连接失败时，有可用的官方离线档案才会继续尝试，并在任务记录显示数据来源。

## API

- `GET /api/manga/downloads` 继续返回 `queue`，同时返回 `history` 和 `nextBefore`。传入 `before` 可查看较早记录，`limit` 为每页 1 到 100 条。
- DSH 的 `manga_tasks` 也返回完成历史及归档路径，可通过 `mangaId` 筛选，并将 `nextBefore` 用作下一页的 `before`。
- `/api/settings/integrations` 的 `save-komga-preferences` 操作接受布尔选项 `postDownloadRefresh` 和 `postDownloadScrape`。省略时保留设置。新安装可按需开启。
