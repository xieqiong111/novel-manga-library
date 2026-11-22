# DSH 漫画下载与自动打包约束

1. **区分轻小说与漫画。** 小说用 `novel_*`，输出 EPUB。漫画用 `manga_*`，经 Suwayomi 下载后输出 CBZ。搜索时保留来源和作品 ID。同名结果有多个版本时先确认。
2. **统一按章。** 先通过 `manga_komga_status` 核对可归档的实际章节 ID，再调用 `manga_komga_download`。一批可以提交多章，每章独立完成、独立打包。就算条目写有卷号，只要它是一条单独章节，也按章处理。只有整卷条目的来源请换成分话来源。
3. **服务自动打包。** 启用归档服务后，Suwayomi 每下载完一章，归档服务就会生成该章的 CBZ。Agent 只提交并查询状态，禁止调用 Docker、终端、ZIP 工具或脚本手动打包。
4. **报告真实文件。** `waiting_archive` 是已下载、待打包。`archived` 加实际返回的 `filename` 才确认单章文件。`in_legacy_volume` 表示已在旧卷包。保存位置见 `manga_komga_status` 的 `chapters[].location` 或 `manga_tasks` 的 `history[].archive.location`。其中 `nasPath` 是配置了 NAS 主机目录时的绝对路径，`storagePath` 是 Studio 容器路径。路径缺失时报告尚未核实。Komga 是否收录另查。
5. **如实报告异常。** 队列确认只表示提交或下载状态，出队也可能是取消。下载失败、打包失败和归档服务未启用要分别说明。提交结果不确定时先查队列及章节，再决定是否重试。
