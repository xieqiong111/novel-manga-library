import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PluginRuntime } from '../runtime.js'
import { readStudio } from '../../server/studio-reader.mjs'
import { searchStudioWork, studioDelegated, studioJob } from '../../server/studio-jobs.mjs'
import type { MangaArchiveStatus, MangaKomga } from '../../server/manga-komga.mjs'
import type { SuwayomiClient, SuwayomiTask } from '../../server/suwayomi-client.mjs'
import { canonical, jsonOutput, ok } from './common.js'

type MangaRuntime = PluginRuntime & { suwayomi: SuwayomiClient }

const MAX_PAGE_SIZE = 100
const archivePolicy = {
  mode: 'automatic-per-chapter',
  agentAction: 'poll-only',
  instruction: '每话下载完成后由归档服务自动生成一个 CBZ。Agent 只提交下载和查询状态，不调用 Docker、终端、ZIP 或脚本手动打包。归档失败时报告错误。',
}

const automaticArchive = [
  'In managed mode Studio owns all task execution. Follow the reported API results and do not start a local downloader.',
  'The archive service automatically packages each completed chapter as one CBZ. Your only follow-up is to poll the Studio tools. Do not call Docker, shell commands, zip utilities, or scripts to package files. Report archive failures.',
  'Use actual chapter IDs. Select individually downloadable chapters even when their names contain volume markers. If a source only has whole-volume entries, choose a source with separate chapters.',
  'The files appear directly in the work-title folder under the configured manga output directory. Existing volume archives are preserved.',
  'Use manga_komga_status for the archived state and location.nasPath when present. A name without a verified location is insufficient to claim an absolute path. Confirm Komga indexing separately.',
].join(' ')

function bounded(value: number | undefined, fallback: number, max = MAX_PAGE_SIZE): number {
  return Math.min(Math.max(Math.trunc(value ?? fallback), 1), max)
}

function safeError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown; retryable?: unknown; status?: unknown }
    if (typeof value.code === 'string' && typeof value.message === 'string') {
      return {
        code: value.code,
        message: value.message,
        retryable: typeof value.retryable === 'boolean'
          ? value.retryable
          : value.code !== 'STUDIO_JOB_UNCONFIRMED' && typeof value.status === 'number' && value.status >= 500,
      }
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'INTERNAL_ERROR', message, retryable: false }
}

async function runMangaTool(
  runtime: PluginRuntime,
  scope: string,
  operation: () => Promise<unknown>,
) {
  try {
    if (!studioDelegated()) await runtime.ready()
    return canonical(await operation())
  } catch (error) {
    const failure = safeError(error)
    runtime.logger.warn(scope, 'tool_failed', failure)
    return canonical({ ok: false, error: failure })
  }
}

function client(runtime: PluginRuntime): SuwayomiClient {
  return (runtime as MangaRuntime).suwayomi
}

function requiredId(value: string | undefined): string | null {
  const id = value?.trim()
  return id ? id : null
}

function selectedIds(input: string[] | undefined): string[] {
  return [...new Set((input ?? []).map((id) => id.trim()).filter(Boolean))]
}

type DownloadResult = Omit<Awaited<ReturnType<MangaKomga['download']>>, 'filename'> & { filename?: string | null }

function downloadReport(
  result: DownloadResult,
  next: { tool: string; args: object },
) {
  const unconfirmed = result.unconfirmed ?? []
  const counts = {
    queued: result.queued.length,
    skipped: result.skipped?.length ?? 0,
    downloaded: result.completed?.length ?? 0,
    unconfirmed: unconfirmed.length,
    archived: (result.archived?.length ?? 0) + Number(Boolean(result.filename)),
  }
  const failed = (result.queue ?? []).filter((task) =>
    task.state === 'failed' && result.queued.includes(task.chapterId)).map((task) => task.chapterId)
  const observedQueued = counts.queued - failed.length
  const summary = [
    counts.archived ? `确认 CBZ ${counts.archived} 个` : '',
    observedQueued ? `确认在队列 ${observedQueued} 话` : '',
    counts.downloaded ? `下载完成 ${counts.downloaded} 话` : '',
    counts.skipped ? `${counts.skipped} 话无需重复提交` : '',
    failed.length ? `下载失败 ${failed.length} 话` : '',
    counts.unconfirmed ? `提交待确认 ${counts.unconfirmed} 话` : '',
  ].filter(Boolean).join('，') || '没有新增任务'
  const { queue, ...reported } = result
  const ids = new Set([...result.queued, ...(result.skipped ?? []), ...(result.completed ?? []), ...unconfirmed])
  const report = {
    ...reported,
    ...(queue ? { queue: queue.filter((task) => ids.has(task.chapterId)) } : {}),
    failed,
    summary,
    next,
    archivePolicy,
    archiveNotice: '用 manga_komga_status 核对已归档章节和 location.nasPath。路径缺失时说明尚未核实。',
  }
  if (unconfirmed.length || failed.length) return {
    ...report, ok: false, error: {
      code: unconfirmed.length ? 'MANGA_DOWNLOAD_UNCONFIRMED' : 'MANGA_DOWNLOAD_FAILED',
      message: '请先核对所选章节的实际状态，再决定是否重试。',
      retryable: false,
    },
  }
  return ok(report)
}

function archiveNotice(status: MangaArchiveStatus): string {
  if (!status.available) return 'Docker 归档服务未配置。可以用 manga_chapters 和 manga_tasks 检查 Suwayomi 下载。'
  if (status.archiveMode === 'unsupported') return '该来源没有可单独归档的章节，请选择有分话目录的来源。'
  if (status.archiveMode !== 'chapter') return '归档服务尚未启用按章模式，请检查服务版本。'
  const chapters = status.chapters ?? []
  const counts = (state: typeof chapters[number]['state']) => chapters.filter((row) => row.state === state).length
  const summary = [
    `已归档 ${counts('archived')}`, `待打包 ${counts('waiting_archive')}`,
    `下载中 ${counts('downloading')}`, `排队 ${counts('queued')}`,
    `下载失败 ${counts('failed')}`, `归档失败 ${counts('archive_failed')}`,
    `已在旧卷包 ${counts('in_legacy_volume')}`,
  ].join('，')
  return `每章下载后 Docker 自动生成一个 CBZ。本次查询${summary}。请用实际文件名确认归档，Komga 收录状态需另查。`
}

function queueNotice(queue: SuwayomiTask[], cancelled: boolean): string {
  if (cancelled) return '已回读取消请求后的队列。章节离开队列不代表已下载或已归档，请查询章节和 CBZ 状态。'
  if (!queue.length) return '当前没有匹配的队列记录。请查 manga_chapters 确认下载，查 manga_komga_status 确认 CBZ。'
  return `队列中有 ${queue.length} 个匹配任务。进度为 null 表示来源未提供百分比。请通过归档状态确认 CBZ。`
}

/** Register the independent manga tool family against the shared Suwayomi client. */
export function registerMangaTools(ctx: Context, runtime: PluginRuntime, komga: MangaKomga = runtime.mangaKomga): void {
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
      }) }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'manga_komga_status',
    description: [
      'Inspect the selected manga source before and after downloading. Saved files include location.nasPath when configured. Use the returned location instead of guessing or searching Docker.',
      'waiting_archive means the pages have downloaded but the CBZ is pending. archive_failed means packaging failed.',
      'If unavailable or unsupported, report the limitation. An empty queue does not prove download or archive completion.',
    ].join(' '),
    parameters: {
      mangaId: { type: 'string', required: true, description: 'Suwayomi manga ID from manga_search.' },
      chapterIds: { type: 'array', items: { type: 'string' }, description: 'Optional actual chapter IDs for per-chapter archive status.' },
      offset: { type: 'number', description: 'Optional zero-based chapter archive page offset from chapterPage.nextOffset.' },
      limit: { type: 'number', description: 'Optional chapter archive page size, up to 100.' },
    },
    output: jsonOutput(),
    async execute(args) {
      return runMangaTool(runtime, 'manga_komga_status', async () => {
        const mangaId = args.mangaId.trim()
        const selection = args.chapterIds !== undefined || args.offset !== undefined || args.limit !== undefined
          ? { chapterIds: args.chapterIds === undefined ? undefined : selectedIds(args.chapterIds), offset: args.offset, limit: args.limit }
          : undefined
        const status = studioDelegated()
          ? await studioJob<MangaArchiveStatus>(`/api/manga/${encodeURIComponent(mangaId)}/komga`, {
            query: { ...selection, chapterIds: selection?.chapterIds?.join(',') },
          })
          : selection ? await komga.status(mangaId, undefined, selection) : await komga.status(mangaId)
        return ok({ ...status, archivePolicy, notice: archiveNotice(status) })
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'manga_komga_download',
    description: [
      'After checking manga_komga_status, submit only actual IDs of the requested chapters.',
      'In Studio mode pass the confirmed Bangumi series ID from manga_search. Studio chooses the official work folder name.',
      'Keep the manga ID and source together. Never build a volume archive or use display numbers as chapter IDs.',
      automaticArchive,
    ].join(' '),
    parameters: {
      mangaId: { type: 'string', required: true, description: 'The selected Suwayomi manga ID, including its source.' },
      bangumiSubjectId: { type: 'number', description: 'Bangumi series ID reported by manga_search in Studio mode.' },
      sourceTitle: { type: 'string', description: 'Exact source title for an unlisted alias. Use it with bangumiSubjectId after confirming the same work.' },
      chapterIds: { type: 'array', required: true, items: { type: 'string' }, description: 'Actual chapter IDs from manga_komga_status, up to 100 per request.' },
    },
    output: jsonOutput(),
    async execute(args) {
      return runMangaTool(runtime, 'manga_komga_download', async () => {
        const mangaId = args.mangaId.trim()
        const chapterIds = selectedIds(args.chapterIds)
        if (!chapterIds.length) {
          return { ok: false, error: { code: 'MANGA_ARCHIVE_SELECTION_REQUIRED', message: '请选择要下载的章节 ID。' } }
        }
        const result = studioDelegated()
          ? await studioJob<DownloadResult>(`/api/manga/${encodeURIComponent(mangaId)}/komga`,
            { method: 'POST', body: { chapterIds, bangumiSubjectId: args.bangumiSubjectId, sourceTitle: args.sourceTitle } })
          : await komga.downloadChapters(mangaId, chapterIds)
        return downloadReport(result, { tool: 'manga_komga_status', args: { mangaId, chapterIds } })
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'manga_search',
    description: [
      'Search manga through the configured Suwayomi server and its installed sources.',
      'Keep source and manga IDs together. Confirm the edition with the user when multiple sources match.',
      'Studio tries the Bangumi title first. It can also search source names, Traditional Chinese and supplied translations. The download folder uses the confirmed Bangumi series name.',
      'Search types are SEARCH, POPULAR, and LATEST; pagination is one-based.',
    ].join(' '),
    parameters: {
      query: { type: 'string', description: 'Optional search phrase; required for SEARCH and ignored for POPULAR/LATEST.' },
      sourceId: { type: 'string', description: 'Optional Suwayomi source id to limit the search.' },
      bangumiSubjectId: { type: 'number', description: 'Confirmed Bangumi series ID when choosing among candidates.' },
      alternateNames: { type: 'array', items: { type: 'string' }, description: 'Up to three other names for source searches, including Traditional Chinese or names absent from Bangumi.' },
      sourceQuery: { type: 'string', description: 'Exact source query returned by the previous Studio result. Pass this with pagination.' },
      type: { type: 'string', description: 'SEARCH (default), POPULAR, or LATEST.' },
      page: { type: 'number', description: 'One-based source page (default 1).' },
      offset: { type: 'number', description: 'Within an upstream page, reuse nextOffset from the previous result (default 0).' },
      resultId: { type: 'string', description: 'Reuse resultId when requesting a nonzero offset on the same page.' },
      limit: { type: 'number', description: 'Maximum results to return (1-50, default 20).' },
    },
    output: jsonOutput(),
    async execute(args) {
      return runMangaTool(runtime, 'manga_search', async () => {
        const type = (args.type ?? 'SEARCH').trim().toUpperCase()
        if (!['SEARCH', 'POPULAR', 'LATEST'].includes(type)) {
          return { ok: false, error: { code: 'UNKNOWN_SEARCH_TYPE', message: 'type must be SEARCH, POPULAR, or LATEST.' } }
        }
        const query = args.query?.trim() ?? ''
        if (type === 'SEARCH' && !query) {
          return { ok: false, error: { code: 'QUERY_REQUIRED', message: 'Provide query for SEARCH.' } }
        }
        const input = {
          query,
          sourceId: args.sourceId?.trim() || undefined,
          type: type as 'SEARCH' | 'POPULAR' | 'LATEST',
          page: Math.max(Math.trunc(args.page ?? 1), 1),
          offset: Math.max(Math.trunc(args.offset ?? 0), 0),
          resultId: args.resultId?.trim() || undefined,
          limit: bounded(args.limit, 20, 50),
        }
        const result = !studioDelegated() ? await client(runtime).searchManga(input)
          : type === 'SEARCH' ? await searchStudioWork('manga', {
            ...input, bangumiSubjectId: args.bangumiSubjectId, sourceQuery: args.sourceQuery, alternateNames: args.alternateNames,
          }) : await studioJob<Record<string, unknown>>('/api/manga/search', { query: input })
        return ok({ notice: '请按作品 ID 和来源确认版本，再查询章节和归档方式。同名结果可能来自不同来源。', ...result })
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'manga_details',
    description: 'Get normalized metadata for one manga from the configured Suwayomi server. Provide the id from manga_search or manga_library.',
    parameters: { mangaId: { type: 'string', required: true, description: 'Suwayomi manga id.' } },
    output: jsonOutput(),
    async execute(args) {
      return runMangaTool(runtime, 'manga_details', async () => {
        const mangaId = requiredId(args.mangaId)
        if (!mangaId) return { ok: false, error: { code: 'MANGA_ID_REQUIRED', message: 'Provide mangaId.' } }
        const manga = studioDelegated() ? await studioJob(`/api/manga/${encodeURIComponent(mangaId)}`) : await client(runtime).getManga(mangaId)
        return ok({ manga, notice: '下载前请用 manga_komga_status 确认可按章归档的条目。' })
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'manga_chapters',
    description: 'List source chapter entries and their actual IDs, display numbers and download state. Some providers only expose whole-volume entries. Select actual chapters with manga_komga_status.',
    parameters: {
      mangaId: { type: 'string', required: true, description: 'Suwayomi manga id.' },
      limit: { type: 'number', description: 'Maximum chapters to return (1-100, default 50).' },
      offset: { type: 'number', description: 'Zero-based chapter offset (default 0).' },
    },
    output: jsonOutput(),
    async execute(args) {
      return runMangaTool(runtime, 'manga_chapters', async () => {
        const mangaId = requiredId(args.mangaId)
        if (!mangaId) return { ok: false, error: { code: 'MANGA_ID_REQUIRED', message: 'Provide mangaId.' } }
        const page = {
          limit: bounded(args.limit, 50),
          offset: Math.max(Math.trunc(args.offset ?? 0), 0),
        }
        const result = studioDelegated()
          ? await studioJob<Record<string, unknown>>(`/api/manga/${encodeURIComponent(mangaId)}/chapters`, { query: page })
          : await client(runtime).getChapters(mangaId, page)
        return ok({ ...result, notice: 'number 是来源标注的话号；下载参数 chapterIds 使用 id。请用 manga_komga_status 确认单章归档。' })
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'manga_download',
    description: [
      'Queue explicitly selected Suwayomi chapters for download.',
      'Use actual IDs from manga_chapters. Use manga_tasks for progress. Prefer manga_komga_download for verified single-chapter archives.',
      'In Studio mode pass the confirmed Bangumi series ID so the archive uses its official folder name.',
      automaticArchive,
    ].join(' '),
    parameters: {
      mangaId: { type: 'string', required: true, description: 'Suwayomi manga id that owns all selected chapters.' },
      bangumiSubjectId: { type: 'number', description: 'Bangumi series ID reported by manga_search in Studio mode.' },
      sourceTitle: { type: 'string', description: 'Exact source title for an unlisted alias. Use it with bangumiSubjectId after confirming the same work.' },
      chapterIds: {
        type: 'array', required: true, items: { type: 'string' },
        description: 'Chapter ids returned by manga_chapters. Select only the chapters to enqueue.',
      },
    },
    output: jsonOutput(),
    async execute(args) {
      return runMangaTool(runtime, 'manga_download', async () => {
        const mangaId = requiredId(args.mangaId)
        if (!mangaId) return { ok: false, error: { code: 'MANGA_ID_REQUIRED', message: 'Provide mangaId.' } }
        const chapterIds = selectedIds(args.chapterIds)
        if (chapterIds.length === 0) {
          return { ok: false, error: { code: 'CHAPTER_IDS_REQUIRED', message: '请使用 manga_chapters 返回的章节 ID。' } }
        }
        const result = studioDelegated()
          ? await studioJob<DownloadResult>(`/api/manga/${encodeURIComponent(mangaId)}/komga`,
            { method: 'POST', body: { chapterIds, bangumiSubjectId: args.bangumiSubjectId, sourceTitle: args.sourceTitle } })
          : await client(runtime).download({ mangaId, chapterIds })
        return downloadReport(result, { tool: 'manga_komga_status', args: { mangaId, chapterIds } })
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'manga_tasks',
    description: [
      'Inspect the Suwayomi download queue and the completed chapter history, or cancel queued chapters.',
      'Actions are status (default), list, and cancel. Cancel requires chapterIds from the queue.',
      'Completed history includes archive.file and verified archive.location when available. Read archive.location.nasPath to report the NAS save location. The service handles CBZ packing automatically. Pass nextBefore as before for older records.',
    ].join(' '),
    parameters: {
      action: { type: 'string', description: 'status (default), list, or cancel.' },
      mangaId: { type: 'string', description: 'Optional media ID to filter displayed queue entries.' },
      before: { type: 'number', description: 'Optional nextBefore cursor for older completed chapters.' },
      chapterIds: { type: 'array', items: { type: 'string' }, description: 'Chapter ids to dequeue; required for cancel.' },
    },
    output: jsonOutput(),
    async execute(args) {
      return runMangaTool(runtime, 'manga_tasks', async () => {
        const action = (args.action ?? 'status').trim().toLowerCase()
        if (!['status', 'list', 'cancel'].includes(action)) {
          return { ok: false, error: { code: 'UNKNOWN_ACTION', message: 'action must be status, list, or cancel.' } }
        }
        const chapterIds = selectedIds(args.chapterIds)
        if (action === 'cancel' && chapterIds.length === 0) {
          return { ok: false, error: { code: 'CHAPTER_IDS_REQUIRED', message: 'Provide chapterIds to cancel.' } }
        }
        const mangaId = requiredId(args.mangaId)
        if (studioDelegated()) {
          const result = action === 'cancel'
            ? await studioJob<{ queue: SuwayomiTask[] }>('/api/manga/downloads/cancel', { method: 'POST', body: { chapterIds } })
            : await studioJob<{ queue: SuwayomiTask[]; history?: unknown[] }>('/api/manga/downloads', {
              query: { mangaId: mangaId ?? undefined, before: args.before },
            })
          return ok({ ...result, archivePolicy, executor: 'studio',
            notice: '仅用 Studio 查询进度。文件保存位置见 archive.location.nasPath；没有核实的路径时请如实说明。' })
        }
        const result = await client(runtime).tasks({ action: action as 'status' | 'list' | 'cancel', chapterIds })
        const queue = mangaId ? result.queue.filter((task) => task.mangaId === mangaId) : result.queue
        const history = action !== 'cancel' ? await komga.history?.(mangaId, args.before) : null
        const combined = history && 'history' in history && history.history.length > 0
          ? `本页完成记录 ${history.history.length} 章。请按实际归档状态报告文件。`
          : queueNotice(queue, action === 'cancel')
        return ok({ ...result, ...history, queue, count: queue.length, archivePolicy, notice: combined })
      })
    },
  }))

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
        const query = {
          limit: bounded(args.limit, 50),
          offset: Math.max(Math.trunc(args.offset ?? 0), 0),
        }
        return ok(studioDelegated() ? await studioJob<Record<string, unknown>>('/api/manga/library', { query })
          : await client(runtime).library(query))
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'manga_sources',
    description: 'List sources installed in Suwayomi, including source ids and languages. Use a source id with manga_search.',
    parameters: {},
    output: jsonOutput(),
    async execute() {
      return runMangaTool(runtime, 'manga_sources', async () => ok(studioDelegated()
        ? await studioJob<Record<string, unknown>>('/api/manga/sources') : await client(runtime).sources()))
    },
  }))

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
        const mangaId = requiredId(args.mangaId)
        if (!mangaId) return { ok: false, error: { code: 'MANGA_ID_REQUIRED', message: 'Provide mangaId.' } }
        const manga = studioDelegated() ? await studioJob(`/api/manga/${encodeURIComponent(mangaId)}/subscribe`, {
          method: 'POST', body: { subscribed: args.inLibrary },
        }) : await client(runtime).setLibrary({ mangaId, inLibrary: args.inLibrary })
        return ok({ manga })
      })
    },
  }))
}
