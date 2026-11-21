# Native DSH manga tools

The plugin exposes manga tools alongside the existing light-novel tools. They call the shared Suwayomi client used by the web backend, so both surfaces use the same server URL, authentication, GraphQL operations, and normalized results. The Studio read-only API is a separate connection.

## Install and configure

Use DSH **0.2.2-rc.1** and Node.js **24.9 or newer**. Until this feature is published to npm, build and install the package tarball from this branch:

```bash
npm ci
npm run build
npm pack
dsh plugin --profile myprofile add ./dsh-plugin-lightnovel-1.0.0.tgz
```

Configure Suwayomi in the environment available to the DSH process or its container. The client reads these variables:

```bash
export LN_SUWAYOMI_URL="http://suwayomi:4567"
# Optional, when the server requires HTTP Basic authentication:
export LN_SUWAYOMI_USERNAME="…"
export LN_SUWAYOMI_PASSWORD="…"
# Optional request timeout in milliseconds (default 8000; bounded to 1000–30000):
export LN_SUWAYOMI_TIMEOUT_MS="8000"
```

The unprefixed `SUWAYOMI_URL`, `SUWAYOMI_USERNAME`, `SUWAYOMI_PASSWORD`, and `SUWAYOMI_TIMEOUT_MS` are also supported. The URL must be an HTTP(S) origin, without a path, query, fragment, or embedded credentials, and should be reachable from the host or container running DSH. Set both username and password or leave both empty. Credentials are read by the server-side client and are not tool arguments. When deploying all three containers, see the shared Docker network instructions in [MANGA.md](./MANGA.md). Keep the existing light-novel `lightnovel` row in `cordis.patch.yml`; the manga tools are registered by that same plugin.

## Available tools

| Tool | Operation |
|---|---|
| `manga_search` | Search installed sources or browse popular/latest manga. Use `nextOffset` with `resultId` on the same `page` before advancing. |
| `manga_details` | Read normalized metadata for one manga id. |
| `manga_chapters` | List chapters and their read/download metadata with pagination. |
| `manga_download` | Enqueue explicitly selected chapter ids in Suwayomi. |
| `manga_tasks` | Read the download queue or dequeue selected chapter ids. |
| `manga_library` | List manga currently in the Suwayomi library. |
| `manga_sources` | List installed Suwayomi sources. |
| `manga_subscribe` | Set Suwayomi's `inLibrary` flag for one manga. |
| `manga_komga_download` | Submit explicit chapter IDs for automatic CBZ export. |
| `manga_komga_status` | Check eligible chapters, progress, and confirmed CBZ files. |
| `studio_read` | Query Studio libraries and task or archive status with a scoped read-only key. |

## 下载流程与提醒

1. 用 `manga_search` 查作品，按来源和 `mangaId` 确认版本。同名结果可能来自不同来源。
2. 用 `manga_komga_status(mangaId)` 确认可单独归档的章节，下载参数填写实际章节 ID。
3. 用 `manga_komga_download(chapterIds=…)` 提交。每章下载结束后，Docker 自己生成一个 CBZ。
4. 先报告队列确认，再用 `manga_komga_status` 核对 CBZ 文件名。详细约束见 [Agent 按章归档](DSH-MANGA-ARCHIVE-RULES.md)。

| 状态 | 如何向用户说明 |
|---|---|
| `queued` / `downloading` | Suwayomi 已排队或正在下载 |
| `waiting_archive` | Suwayomi 下载齐了，正在等待归档 |
| `archived` | 归档服务确认了 CBZ 文件名。Komga 是否已索引需要另查 |
| `failed` / `archive_failed` | 下载失败或打包失败，分别检查 Suwayomi 队列和归档服务日志 |

工具会在每次查询或提交后返回状态提示。队列里找不到任务时，从章节状态或实际 CBZ 文件核对。追更开关由 `manga_subscribe(inLibrary=…)` 使用 Suwayomi 的书架成员状态。

## Komga archive and Studio read API

For per-chapter archive tools, set `LN_VOLUME_ARCHIVE_URL` to the internal archive service and keep the Suwayomi connection configured. See [archive deployment and progress APIs](MANGA-VOLUME-CBZ.md). You can supply these service settings through a private JSON file using `LN_MANGA_CONNECTION_FILE`.

For Bangumi search, metadata preview, and scoped writes to Komga series or books, see [BangumiKomga setup](BANGUMIKOMGA.md) and the `komga_bangumi_metadata` tool.

For `studio_read`, generate a read-only key in Studio under **系统设置 → 服务集成**. Save it to a private file readable by DSH and set `LN_STUDIO_READ_URL` to the Studio origin and `LN_STUDIO_READ_TOKEN_FILE` to that file's path inside the DSH container. Use `studio_read(resource="mangaArchive", mangaId="22")` for the equivalent read-only Studio API, optionally filtered by chapter IDs. To list other operations and supported arguments, see [Studio integrations](../web/README.md#komga-api-和-dsh-只读密钥).

## Verify native loading

From the repository root:

```bash
npm ci
npm run build
npx vitest run test/integration/dsh-manga-tools.test.ts test/integration/dsh-cli.test.ts
npx vitest run test/integration/dsh-runtime.test.ts -t 'DSH loading'
```

`dsh-runtime.test.ts` mounts the built package in the real Cordis context with DSH's `ToolsService` and native executor, then checks that all novel and manga tools are registered with compiled schemas. The `DSH loading` filter avoids the existing novel EPUB workflow, which separately needs the compiled Dart binary. `dsh-manga-tools.test.ts` dispatches each manga tool through the real executor against a fake Suwayomi client, so it does not make server changes. `dsh-cli.test.ts` checks profile bundle composition using the locked DSH CLI dependency.
