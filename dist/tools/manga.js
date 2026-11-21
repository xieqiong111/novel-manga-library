import { defineTool } from '@deepseek-ai/dsh-tools';
import { readStudio } from '../../server/studio-reader.mjs';
import { canonical, jsonOutput, ok } from './common.js';
const MAX_PAGE_SIZE = 100;
function bounded(value, fallback, max = MAX_PAGE_SIZE) {
    return Math.min(Math.max(Math.trunc(value ?? fallback), 1), max);
}
function safeError(error) {
    if (error && typeof error === 'object') {
        const value = error;
        if (typeof value.code === 'string' && typeof value.message === 'string') {
            return {
                code: value.code,
                message: value.message,
                retryable: typeof value.retryable === 'boolean'
                    ? value.retryable
                    : typeof value.status === 'number' && value.status >= 500,
            };
        }
    }
    const message = error instanceof Error ? error.message : String(error);
    return { code: 'INTERNAL_ERROR', message, retryable: false };
}
async function runMangaTool(runtime, scope, operation) {
    try {
        await runtime.ready();
        return canonical(await operation());
    }
    catch (error) {
        const failure = safeError(error);
        runtime.logger.warn(scope, 'tool_failed', failure);
        return canonical({ ok: false, error: failure });
    }
}
function client(runtime) {
    return runtime.suwayomi;
}
function requiredId(value) {
    const id = value?.trim();
    return id ? id : null;
}
function selectedIds(input) {
    return [...new Set((input ?? []).map((id) => id.trim()).filter(Boolean))];
}
function downloadReport(result, next) {
    const unconfirmed = result.unconfirmed ?? [];
    const counts = {
        queued: result.queued.length,
        skipped: result.skipped?.length ?? 0,
        downloaded: result.completed?.length ?? 0,
        unconfirmed: unconfirmed.length,
        archived: (result.archived?.length ?? 0) + Number(Boolean(result.filename)),
    };
    const failed = (result.queue ?? []).filter((task) => task.state === 'failed' && result.queued.includes(task.chapterId)).map((task) => task.chapterId);
    const observedQueued = counts.queued - failed.length;
    const summary = [
        counts.archived ? `确认 CBZ ${counts.archived} 个` : '',
        observedQueued ? `确认在队列 ${observedQueued} 话` : '',
        counts.downloaded ? `下载完成 ${counts.downloaded} 话` : '',
        counts.skipped ? `${counts.skipped} 话无需重复提交` : '',
        failed.length ? `下载失败 ${failed.length} 话` : '',
        counts.unconfirmed ? `提交待确认 ${counts.unconfirmed} 话` : '',
    ].filter(Boolean).join('，') || '没有新增任务';
    const { queue, ...reported } = result;
    const ids = new Set([...result.queued, ...(result.skipped ?? []), ...(result.completed ?? []), ...unconfirmed]);
    const report = {
        ...reported,
        ...(queue ? { queue: queue.filter((task) => ids.has(task.chapterId)) } : {}),
        failed,
        summary,
        next,
    };
    if (unconfirmed.length || failed.length)
        return {
            ...report, ok: false, error: {
                code: unconfirmed.length ? 'MANGA_DOWNLOAD_UNCONFIRMED' : 'MANGA_DOWNLOAD_FAILED',
                message: '请先核对所选章节的实际状态，再决定是否重试。',
                retryable: false,
            },
        };
    return ok(report);
}
function archiveNotice(status, volume) {
    if (!status.available)
        return 'Komga 归档服务未配置。可以用 manga_chapters 和 manga_tasks 检查 Suwayomi 下载。';
    if (volume !== undefined && status.volumes.length === 0 && status.archiveMode === 'chapter') {
        return '该来源按话归档。请查章节或使用章节 ID 查询；话号不能作为卷号。';
    }
    if (volume !== undefined && status.volumes.length === 0)
        return '所查的卷号不在当前来源的分卷目录中。';
    const mode = status.archiveMode ?? (status.volumes.length ? 'volume' : 'unknown');
    if (mode === 'unsupported')
        return '当前来源没有可确认的分卷或分话归档计划。仍可通过 Suwayomi 下载选定章节。';
    if (mode === 'unknown')
        return '归档服务未返回分话信息。请更新归档服务，并使用 Suwayomi 工具核对下载。';
    const rows = mode === 'volume' ? status.volumes : status.chapters ?? [];
    const counts = (state) => rows.filter((row) => row.state === state).length;
    const summary = [
        `已归档 ${counts('archived')}`, `待打包 ${counts('waiting_archive')}`,
        `下载中 ${counts('downloading')}`, `排队 ${counts('queued')}`,
        `下载失败 ${counts('failed')}`, `归档失败 ${counts('archive_failed')}`,
    ].join('，');
    return `按${mode === 'volume' ? '卷' : '话'}归档。本次查询${summary}。归档成功表示 CBZ 已写入，Komga 扫描状态需另查。`;
}
function queueNotice(queue, cancelled) {
    if (cancelled)
        return '已回读取消请求后的队列。章节离开队列不代表已下载或已归档，请查询章节和 CBZ 状态。';
    if (!queue.length)
        return '当前没有匹配的队列记录。请查 manga_chapters 确认下载，查 manga_komga_status 确认 CBZ。';
    return `队列中有 ${queue.length} 个匹配任务。进度为 null 表示来源未提供百分比。请通过归档状态确认 CBZ。`;
}
/** Register the independent manga tool family against the shared Suwayomi client. */
export function registerMangaTools(ctx, runtime, komga = runtime.mangaKomga) {
    ctx.tools.register(defineTool({
        name: 'studio_read',
        description: 'Read Studio through its scoped read-only API. Resources: health, novels, novelTasks, manga, mangaTasks, komga, komgaSeries (requires libraryId), mangaArchive (requires mangaId, optional volume or chapterIds).',
        parameters: {
            resource: { type: 'string', required: true, description: 'Studio resource name.' },
            libraryId: { type: 'string', description: 'Komga library ID for komgaSeries.' },
            mangaId: { type: 'string', description: 'Suwayomi manga ID for mangaArchive.' },
            volume: { type: 'number', description: 'Optional volume number.' },
            chapterIds: { type: 'array', items: { type: 'string' }, description: 'Optional chapter IDs for mangaArchive.' },
        },
        output: jsonOutput(),
        async execute(args) {
            return runMangaTool(runtime, 'studio_read', async () => ok({ data: await readStudio({
                    ...args, url: process.env.LN_STUDIO_READ_URL, tokenFile: process.env.LN_STUDIO_READ_TOKEN_FILE,
                }) }));
        },
    }));
    ctx.tools.register(defineTool({
        name: 'manga_komga_status',
        description: 'Inspect the selected manga source before downloading. Reports volume or chapter archive mode, actual queue state and confirmed CBZ files. A volume is decided by source labels; a displayed chapter number is not a volume number or a chapter ID.',
        parameters: {
            mangaId: { type: 'string', required: true, description: 'Suwayomi manga ID from manga_search.' },
            volume: { type: 'number', description: 'A real volume number from this tool. Omit to discover archive mode.' },
            chapterIds: { type: 'array', items: { type: 'string' }, description: 'Optional actual chapter IDs for per-chapter archive status.' },
            offset: { type: 'number', description: 'Optional zero-based chapter archive page offset from chapterPage.nextOffset.' },
            limit: { type: 'number', description: 'Optional chapter archive page size, up to 100.' },
        },
        output: jsonOutput(),
        async execute(args) {
            return runMangaTool(runtime, 'manga_komga_status', async () => {
                const mangaId = args.mangaId.trim();
                const selection = args.chapterIds !== undefined || args.offset !== undefined || args.limit !== undefined
                    ? { chapterIds: args.chapterIds === undefined ? undefined : selectedIds(args.chapterIds), offset: args.offset, limit: args.limit }
                    : undefined;
                const status = selection ? await komga.status(mangaId, args.volume, selection) : await komga.status(mangaId, args.volume);
                return ok({ ...status, notice: archiveNotice(status, args.volume) });
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'manga_komga_download',
        description: 'After checking manga_komga_status, submit one real volume or explicit chapter IDs on a per-chapter source. Specify exactly one. Report confirmed queue results immediately, then use manga_komga_status to confirm the CBZ.',
        parameters: {
            mangaId: { type: 'string', required: true, description: 'The selected Suwayomi manga ID, including its source.' },
            volume: { type: 'number', description: 'Volume number returned by manga_komga_status for a volume source.' },
            chapterIds: { type: 'array', items: { type: 'string' }, description: 'Actual IDs from manga_chapters or manga_komga_status, up to 100. Do not enter displayed chapter numbers.' },
        },
        output: jsonOutput(),
        async execute(args) {
            return runMangaTool(runtime, 'manga_komga_download', async () => {
                const mangaId = args.mangaId.trim();
                const chapterIds = selectedIds(args.chapterIds);
                if ((args.volume === undefined && !chapterIds.length) || (args.volume !== undefined && args.chapterIds !== undefined)) {
                    return { ok: false, error: { code: 'MANGA_ARCHIVE_SELECTION_REQUIRED', message: '请提供一个卷号，或一组选中的章节 ID。' } };
                }
                if (args.volume !== undefined) {
                    const result = await komga.download(mangaId, args.volume);
                    return downloadReport(result, { tool: 'manga_komga_status', args: { mangaId, volume: args.volume } });
                }
                const result = await komga.downloadChapters(mangaId, chapterIds);
                return downloadReport(result, { tool: 'manga_komga_status', args: { mangaId, chapterIds } });
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'manga_search',
        description: [
            'Search manga through the configured Suwayomi server and its installed sources.',
            'Keep source and manga IDs together. Confirm the edition with the user when multiple sources match.',
            'Search types are SEARCH, POPULAR, and LATEST; pagination is one-based.',
        ].join(' '),
        parameters: {
            query: { type: 'string', description: 'Optional search phrase; required for SEARCH and ignored for POPULAR/LATEST.' },
            sourceId: { type: 'string', description: 'Optional Suwayomi source id to limit the search.' },
            type: { type: 'string', description: 'SEARCH (default), POPULAR, or LATEST.' },
            page: { type: 'number', description: 'One-based source page (default 1).' },
            offset: { type: 'number', description: 'Within an upstream page, reuse nextOffset from the previous result (default 0).' },
            resultId: { type: 'string', description: 'Reuse resultId when requesting a nonzero offset on the same page.' },
            limit: { type: 'number', description: 'Maximum results to return (1-50, default 20).' },
        },
        output: jsonOutput(),
        async execute(args) {
            return runMangaTool(runtime, 'manga_search', async () => {
                const type = (args.type ?? 'SEARCH').trim().toUpperCase();
                if (!['SEARCH', 'POPULAR', 'LATEST'].includes(type)) {
                    return { ok: false, error: { code: 'UNKNOWN_SEARCH_TYPE', message: 'type must be SEARCH, POPULAR, or LATEST.' } };
                }
                const query = args.query?.trim() ?? '';
                if (type === 'SEARCH' && !query) {
                    return { ok: false, error: { code: 'QUERY_REQUIRED', message: 'Provide query for SEARCH.' } };
                }
                const result = await client(runtime).searchManga({
                    query,
                    sourceId: args.sourceId?.trim() || undefined,
                    type: type,
                    page: Math.max(Math.trunc(args.page ?? 1), 1),
                    offset: Math.max(Math.trunc(args.offset ?? 0), 0),
                    resultId: args.resultId?.trim() || undefined,
                    limit: bounded(args.limit, 20, 50),
                });
                return ok({ ...result, notice: '请按作品 ID 和来源确认版本，再查询章节和归档方式。同名结果可能来自不同来源。' });
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'manga_details',
        description: 'Get normalized metadata for one manga from the configured Suwayomi server. Provide the id from manga_search or manga_library.',
        parameters: { mangaId: { type: 'string', required: true, description: 'Suwayomi manga id.' } },
        output: jsonOutput(),
        async execute(args) {
            return runMangaTool(runtime, 'manga_details', async () => {
                const mangaId = requiredId(args.mangaId);
                if (!mangaId)
                    return { ok: false, error: { code: 'MANGA_ID_REQUIRED', message: 'Provide mangaId.' } };
                return ok({ manga: await client(runtime).getManga(mangaId), notice: '下载前请查 manga_komga_status 确认按卷或按话。' });
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'manga_chapters',
        description: 'List source chapter entries and their actual IDs, display numbers and download state. Some entries are whole volumes. Use manga_komga_status to determine volume grouping.',
        parameters: {
            mangaId: { type: 'string', required: true, description: 'Suwayomi manga id.' },
            limit: { type: 'number', description: 'Maximum chapters to return (1-100, default 50).' },
            offset: { type: 'number', description: 'Zero-based chapter offset (default 0).' },
        },
        output: jsonOutput(),
        async execute(args) {
            return runMangaTool(runtime, 'manga_chapters', async () => {
                const mangaId = requiredId(args.mangaId);
                if (!mangaId)
                    return { ok: false, error: { code: 'MANGA_ID_REQUIRED', message: 'Provide mangaId.' } };
                const result = await client(runtime).getChapters(mangaId, {
                    limit: bounded(args.limit, 50),
                    offset: Math.max(Math.trunc(args.offset ?? 0), 0),
                });
                return ok({ ...result, notice: 'number 是来源标注的话号；下载参数 chapterIds 使用 id。是否组成卷以 manga_komga_status 为准。' });
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'manga_download',
        description: [
            'Queue explicitly selected Suwayomi chapters for download.',
            'This only enqueues chapter downloads; it does not fetch page images into this DSH process.',
            'Use the actual chapter IDs from manga_chapters. Inspect manga_tasks for progress and manga_komga_status for CBZ output.',
        ].join(' '),
        parameters: {
            mangaId: { type: 'string', required: true, description: 'Suwayomi manga id that owns all selected chapters.' },
            chapterIds: {
                type: 'array', required: true, items: { type: 'string' },
                description: 'Chapter ids returned by manga_chapters. Select only the chapters to enqueue.',
            },
        },
        output: jsonOutput(),
        async execute(args) {
            return runMangaTool(runtime, 'manga_download', async () => {
                const mangaId = requiredId(args.mangaId);
                if (!mangaId)
                    return { ok: false, error: { code: 'MANGA_ID_REQUIRED', message: 'Provide mangaId.' } };
                const chapterIds = selectedIds(args.chapterIds);
                if (chapterIds.length === 0) {
                    return { ok: false, error: { code: 'CHAPTER_IDS_REQUIRED', message: '请使用 manga_chapters 返回的章节 ID。' } };
                }
                const result = await client(runtime).download({ mangaId, chapterIds });
                return downloadReport(result, { tool: 'manga_tasks', args: { mangaId } });
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'manga_tasks',
        description: [
            'Inspect the Suwayomi download queue or cancel queued chapters.',
            'Actions are status (default), list, and cancel. Cancel requires chapterIds from the queue.',
        ].join(' '),
        parameters: {
            action: { type: 'string', description: 'status (default), list, or cancel.' },
            mangaId: { type: 'string', description: 'Optional media ID to filter displayed queue entries.' },
            chapterIds: { type: 'array', items: { type: 'string' }, description: 'Chapter ids to dequeue; required for cancel.' },
        },
        output: jsonOutput(),
        async execute(args) {
            return runMangaTool(runtime, 'manga_tasks', async () => {
                const action = (args.action ?? 'status').trim().toLowerCase();
                if (!['status', 'list', 'cancel'].includes(action)) {
                    return { ok: false, error: { code: 'UNKNOWN_ACTION', message: 'action must be status, list, or cancel.' } };
                }
                const chapterIds = selectedIds(args.chapterIds);
                if (action === 'cancel' && chapterIds.length === 0) {
                    return { ok: false, error: { code: 'CHAPTER_IDS_REQUIRED', message: 'Provide chapterIds to cancel.' } };
                }
                const result = await client(runtime).tasks({ action: action, chapterIds });
                const mangaId = requiredId(args.mangaId);
                const queue = mangaId ? result.queue.filter((task) => task.mangaId === mangaId) : result.queue;
                return ok({ ...result, queue, count: queue.length, notice: queueNotice(queue, action === 'cancel') });
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'manga_library',
        description: 'List manga currently in the Suwayomi library. Results are paginated; use manga_subscribe to add or remove an item.',
        parameters: {
            limit: { type: 'number', description: 'Maximum manga to return (1-100, default 50).' },
            offset: { type: 'number', description: 'Zero-based result offset (default 0).' },
        },
        output: jsonOutput(),
        async execute(args) {
            return runMangaTool(runtime, 'manga_library', async () => {
                return ok({ ...(await client(runtime).library({
                        limit: bounded(args.limit, 50),
                        offset: Math.max(Math.trunc(args.offset ?? 0), 0),
                    })) });
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'manga_sources',
        description: 'List sources installed in Suwayomi, including source ids and languages. Use a source id with manga_search.',
        parameters: {},
        output: jsonOutput(),
        async execute() {
            return runMangaTool(runtime, 'manga_sources', async () => ok({ ...(await client(runtime).sources()) }));
        },
    }));
    ctx.tools.register(defineTool({
        name: 'manga_subscribe',
        description: [
            'Add a manga to or remove it from the Suwayomi library using the server’s in-library flag.',
            'Suwayomi exposes library membership here, not a separate recurring subscription schedule.',
        ].join(' '),
        parameters: {
            mangaId: { type: 'string', required: true, description: 'Suwayomi manga id from manga_search or manga_details.' },
            inLibrary: { type: 'boolean', required: true, description: 'true adds it to the library; false removes it.' },
        },
        output: jsonOutput(),
        async execute(args) {
            return runMangaTool(runtime, 'manga_subscribe', async () => {
                const mangaId = requiredId(args.mangaId);
                if (!mangaId)
                    return { ok: false, error: { code: 'MANGA_ID_REQUIRED', message: 'Provide mangaId.' } };
                return ok({ manga: await client(runtime).setLibrary({ mangaId, inLibrary: args.inLibrary }) });
            });
        },
    }));
}
//# sourceMappingURL=manga.js.map