# 工作台的 Komga 书库

工作台展示所选 Komga 书库的前四个系列。点击「查看完整书库」可继续浏览同一个书库。

选中书库后点击「一键刮削并刷新」，确认后 Studio 会使用当前配置的 Bangumi 数据源处理该书库。只有搜索结果中有唯一同名条目、匹配分数达标、且系列还未关联 Bangumi 或 CBL 时才会写入元数据。锁定字段会保留。单册仍可通过独立的预览与确认流程处理。

刮削结束后，Studio 会向 Komga 请求扫描该书库。工作台分别显示检查、更新、跳过和失败数量，以及 Komga 是否接受扫描请求。

浏览器管理员会话可以调用以下接口：

| 请求 | 行为 |
| --- | --- |
| `POST /api/komga/maintenance` | 提交 JSON `{"libraryId":"example-library"}` 启动任务，已受理时返回 HTTP `202` |
| `GET /api/komga/maintenance?libraryId=example-library` | 读取该书库是否允许刮削，以及正在运行或最近一次任务的状态 |

同一时间运行一项任务。任务状态存放在当前 Studio 进程中。
