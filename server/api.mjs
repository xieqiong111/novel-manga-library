/**
 * /api/* router for the web console.
 *
 * Every handler goes straight to PluginRuntime — the same SearchEngine,
 * NovelService, TaskManager and Library that back the six Cordis tools. There
 * is no fixture/mock branch here: an empty result is an empty result.
 */
import { createReadStream } from 'node:fs'
import { lstat, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { TaskManagerError } from '../dist/core/tasks.js'
import { folderWithin } from '../dist/core/download-folders.js'
import { createSuwayomiClient } from './suwayomi-client.mjs'
import { createDownloadFoldersApi } from './download-folders-api.mjs'
import { createMangaApi } from './manga-api.mjs'
import { validArchiveFile } from './manga-volume-client.mjs'
import { createKomgaClient } from './komga-client.mjs'
import { isDshReadRoute } from './integrations.mjs'
import { createKomgaApi } from './komga-api.mjs'
import { createBangumiKomga, MetadataError } from './bangumi-komga.mjs'
import { bindMangaTitle, readMangaBangumiBinding, resolveDownloadSubject } from './bangumi-download.mjs'
import { createMangaVolumeCatalogApi } from './manga-volume-api.mjs'
import { createKomgaScanner } from './komga-scan.mjs'
import { createSavedFileHistory, readDshTasks } from './download-history.mjs'
import { authorizeStudioJob, isStudioJobCredential, studioJobRoute } from './studio-jobs.mjs'
import { createKomgaMaintenance } from './komga-maintenance.mjs'
import { rank, resolveBook } from '../dist/search.js'
import { assertSafePublicUrl } from '../dist/util/paths.js'
import {
  toActivities,
  toLibraryItem,
  toLibraryStats,
  toNovel,
  toSources,
  toStatus,
  toTask,
  toVolume,
} from './mapping.mjs'

const MAX_BODY = 64 * 1024

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } })
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 64 KB')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Expected a JSON object')
  }
}

function tokenMatches(req, expected) {
  if (!expected) return true
  const candidates = [
    req.headers['x-ln-token'],
    /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1],
  ].filter(Boolean)
  const wanted = Buffer.from(expected)
  return candidates.some((value) => {
    const given = Buffer.from(String(value))
    return given.length === wanted.length && timingSafeEqual(given, wanted)
  })
}

/** Volume ids are `${bookId}#v${index}`; fall back to exact names, then "all". */
function volumeSelector(ids, names) {
  const indices = []
  for (const id of ids) {
    const match = /#v(\d+)$/.exec(String(id)) || /^v?(\d+)$/.exec(String(id))
    if (!match) return null
    const index = Number(match[1])
    if (!Number.isInteger(index) || index < 1) return null
    indices.push(index)
  }
  if (indices.length > 0) return [...new Set(indices)].sort((a, b) => a - b).join(',')
  if (names.length === 0) return 'all'
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 120 || /[\\/\r\n]|\.\./.test(name)) {
      throw new HttpError(400, 'INVALID_VOLUME_NAME', 'Volume names contain unsupported characters')
    }
  }
  return names.join(',')
}

export function createApi(
  runtime,
  settings,
  logger,
  mangaClient = runtime.suwayomi ?? createSuwayomiClient(),
  komgaClient = runtime.komga ?? createKomgaClient(),
) {
  const currentKomga = () => settings.integrations?.client ?? komgaClient
  const scan = createKomgaScanner()
  const metadata = createBangumiKomga({
    url: settings.bangumiKomgaUrl,
    requestMetadata: settings.bangumiWorker?.request,
    komga: currentKomga,
    getManga: async (id) => mangaClient.getManga(id),
    getOptions: () => settings.integrations?.preferences?.scrapeOptions,
    getBangumiProxy: () => settings.integrations?.bangumi?.proxyUrl,
    scanAfterApply: async (client, libraryId) => settings.integrations?.preferences?.refreshMode === 'after-sync-or-scrape'
      ? await scan(client, libraryId)
      : { accepted: false, skipped: true, message: '已跳过自动刷新。' },
  })
  const mangaVolumes = createMangaVolumeCatalogApi({ settings, mangaClient, metadata })
  const handleKomgaMaintenance = createKomgaMaintenance({ settings, currentKomga, metadata, scan })
  const handleMangaApi = createMangaApi(mangaClient, logger, {
    missingBffAuth: settings.mangaCredentialsConfigured && !settings.token && !settings.auth,
    archiveHistory: settings.archiveHistory,
    mangaVolumes,
    postDownload: settings.postDownload?.status,
    async locateArchive(relativePath) {
      if (!settings.mangaStorageRoot || !validArchiveFile(relativePath)) return null
      try {
        const directory = await folderWithin(settings.mangaStorageRoot, path.posix.dirname(relativePath))
        const storagePath = path.join(directory, path.posix.basename(relativePath))
        return await savedLocation(relativePath, storagePath, settings.mangaStorageLabel)
      } catch { return null }
    },
    async bindBangumi(mangaId, id, sourceTitle) {
      const manga = await mangaClient.getManga(mangaId)
      const existing = await readMangaBangumiBinding(settings.config?.downloadFoldersFile, mangaId)
      const subject = existing?.sourceId === String(manga.sourceId) && (id === undefined || id === existing.subjectId)
        ? { id: existing.subjectId, title: existing.title }
        : await resolveDownloadSubject(metadata, 'manga', [manga.title], id, sourceTitle)
      if (!existing || existing.subjectId !== subject.id || existing.sourceId !== String(manga.sourceId)) {
        await bindMangaTitle(settings.config?.downloadFoldersFile, manga, subject)
      }
      await mangaVolumes.prepare(manga, { subjectId: subject.id })
      return subject
    },
  })

  async function savedLocation(relativePath, storagePath, label) {
    if (!(await lstat(storagePath)).isFile()) return null
    return { relativePath, storagePath, ...(label && path.posix.isAbsolute(label)
      ? { nasPath: path.posix.join(label, relativePath) } : {}) }
  }

  async function libraryItem(entry) {
    const item = toLibraryItem(entry)
    try {
      const storagePath = await runtime.library.filePath(entry)
      const configured = entry.storageFolder !== undefined
      const relativePath = configured ? path.posix.join(entry.storageFolder, entry.relativePath) : entry.relativePath
      const location = await savedLocation(relativePath, storagePath, configured ? settings.novelStorageLabel : '')
      return location ? { ...item, location } : item
    } catch { return item }
  }
  const savedFileHistory = createSavedFileHistory(settings, runtime, logger)
  const dshHistory = () => readDshTasks(settings.novelTaskHistoryDir).catch(() => {
    logger.warn('downloads', 'dsh_history_unavailable')
    return []
  })
  settings.postDownload?.start({ currentKomga, metadata, scan, mangaVolumes })
  const handleDownloadFolders = createDownloadFoldersApi(settings, currentKomga, scan)
  const handleKomgaApi = createKomgaApi({
    status: () => currentKomga().status(),
    libraries: () => currentKomga().libraries(),
    series: (options) => currentKomga().series(options),
    thumbnail: (id) => currentKomga().thumbnail(id),
  }, logger, {
    missingBffAuth: settings.komgaCredentialsConfigured && !settings.token && !settings.auth,
  })
  const searchUrlConfigured = Boolean(
    process.env.LN_BILINOVEL_SEARCH_URL || process.env.LN_WENKU8_SEARCH_URL,
  )

  async function listNovels(params, jobsCredential) {
    const query = (params.get('query') ?? '').trim()
    const sources = (params.get('sources') ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    const status = params.get('status') ?? 'all'
    const limit = Math.min(50, Math.max(1, Number(params.get('limit')) || (jobsCredential ? 10 : 20)))
    const statusFilter = status === 'all' ? undefined : status

    if (query) {
      const outcome = await runtime.search.search({
        query,
        sources,
        status: statusFilter,
        limit,
        refresh: params.get('refresh') === 'true',
      })
      if (jobsCredential) return outcome
      return {
        results: outcome.results.map(toNovel),
        total: outcome.total,
        degradedSources: outcome.degradedSources.map(
          (id) => `${id}：该源未返回关键词命中（可能未提供公开搜索端点）`,
        ),
        mocked: false,
        tookMs: outcome.tookMs,
        sourcesQueried: outcome.sourcesQueried,
      }
    }

    // Empty keyword = dashboard/featured view. Never touches the network: only
    // the local index and offline sources are listed, ranked deterministically.
    await runtime.index.load()
    const allowed = new Set(sources.length ? sources : runtime.registry.enabled.map((s) => s.info.id))
    const candidates = runtime.index.all().filter((book) => allowed.has(book.sourceId))
    for (const adapter of runtime.registry.enabled) {
      if (adapter.info.live || !allowed.has(adapter.info.id)) continue
      const books = await adapter.search('', {
        config: runtime.config,
        fetcher: runtime.fetcher,
        logger: runtime.logger,
      })
      candidates.push(...books)
    }
    const hits = rank(candidates, '', statusFilter, limit)
    return {
      results: hits.map(toNovel),
      total: hits.length,
      degradedSources: [],
      mocked: false,
      tookMs: 0,
      sourcesQueried: ['local-index', ...runtime.registry.enabled.filter((s) => !s.info.live).map((s) => s.info.id)],
    }
  }

  async function findBook(id) {
    try {
      return resolveBook(runtime.index, runtime.registry, { bookId: id }).book
    } catch {
      throw new HttpError(404, 'BOOK_NOT_FOUND', `Unknown book id: ${id}`)
    }
  }

  async function novelDetail(id) {
    const indexed = runtime.index.find(id)
    if (!indexed) await findBook(id) // validates the id even without an index row
    if (runtime.dartAvailable) {
      try {
        // includeVolumes keeps volumeCount truthful; the /volumes endpoint uses
        // the same Dart command and returns the chapter-level detail.
        const result = await runtime.novels.details({ bookId: id }, true)
        return result.novel
      } catch (error) {
        logger.warn('webapi', 'details_fallback', { bookId: id, error: String(error) })
      }
    }
    if (indexed) return indexed
    return findBook(id)
  }

  async function novelVolumes(id) {
    await findBook(id)
    if (!runtime.dartAvailable) return []
    try {
      const result = await runtime.novels.volumes({ bookId: id })
      return result.volumes.map((volume) => toVolume(id, volume))
    } catch (error) {
      logger.warn('webapi', 'volumes_failed', { bookId: id, error: String(error) })
      throw new HttpError(502, 'VOLUMES_FAILED', String(error))
    }
  }

  async function createTask(body, jobsCredential) {
    const bookId = typeof body.bookId === 'string' ? body.bookId.trim() : ''
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    if (!bookId && !url) {
      throw new HttpError(400, 'EMPTY_BOOK_REFERENCE', 'bookId or url is required')
    }
    if (!runtime.dartAvailable) {
      throw new HttpError(503, 'DART_UNAVAILABLE', 'Dart headless core is unavailable; downloads are disabled')
    }
    const selections = Array.isArray(body.volumes) ? body.volumes : null
    const legacy = typeof body.volumes === 'string' ? body.volumes.trim() : null
    if (!selections?.length && !legacy) {
      throw new HttpError(400, 'EMPTY_VOLUMES', 'Select at least one volume')
    }
    const names = Array.isArray(body.volumeNames)
      ? body.volumeNames.map((name) => String(name ?? '').trim()).filter(Boolean)
      : []
    const selector = selections ? volumeSelector(selections, names) : legacy
    if (!selector) throw new HttpError(400, 'INVALID_VOLUMES', 'Unrecognised volume ids')
    const segments = selector === 'all' ? [] : selector.split(',')
    if (legacy && segments.some((segment) => !segment.trim() || segment.length > 160 || /[\\/\r\n]|\.\./.test(segment))) {
      throw new HttpError(400, 'INVALID_VOLUMES', 'Unrecognised volume selector')
    }
    if (Math.max(selections?.length ?? 0, names.length, segments.length) > runtime.config.maxVolumesPerTask) {
      throw new HttpError(400, 'TOO_MANY_VOLUMES', `At most ${runtime.config.maxVolumesPerTask} volumes per task`)
    }

    const { book, adapter } = resolveBook(runtime.index, runtime.registry, {
      bookId,
      ...(url ? { url } : {}),
      source: typeof body.source === 'string' ? body.source : undefined,
    })
    if (adapter.info.access === 'restricted') {
      throw new HttpError(403, 'RESTRICTED_SOURCE', 'Login/paywall sources are never used by this console')
    }
    if (runtime.config.offlineOnly && book.sourceId !== 'fixture') {
      throw new HttpError(403, 'OFFLINE_ONLY', 'offlineOnly=true permits only the fixture source')
    }
    if (!book.sourceUrl.startsWith('fixture://')) {
      assertSafePublicUrl(book.sourceUrl, adapter.hosts)
    }

    let work = book
    let bangumi
    if (jobsCredential || body.bangumiSubjectId !== undefined) {
      if (!runtime.index.find(book.id)) work = (await runtime.novels.details({ bookId: book.id }, false)).novel
      bangumi = await resolveDownloadSubject(metadata, 'novel', [work.title, ...(work.aliases ?? [])],
        body.bangumiSubjectId, body.sourceTitle)
    }
    const task = await runtime.tasks.start({
      bookId: book.id,
      sourceId: book.sourceId,
      source: book.source,
      sourceUrl: book.sourceUrl,
      title: work.title,
      author: work.author,
      ...(bangumi ? { bangumi } : {}),
      volumes: selector,
      volumeNames: names.length ? names : selector === 'all' ? [] : selector.split(','),
      combine: body.combine === true,
      addChapterTitle: body.addChapterTitle !== false,
    })
    logger.info('webapi', 'task_created', { taskId: task.id, bookId: book.id, volumes: selector })
    return toTask(task)
  }

  async function libraryFile(id, req, res) {
    const entry = runtime.library.get(id)
    if (!entry) throw new HttpError(404, 'FILE_NOT_FOUND', `Unknown library entry: ${id}`)
    const absolute = await runtime.library.filePath(entry).catch(() => {
      throw new HttpError(404, 'FILE_MISSING', 'EPUB file is missing from disk')
    })
    const info = await stat(absolute).catch(() => {
      throw new HttpError(404, 'FILE_MISSING', 'EPUB file is missing from disk')
    })
    const name = path.basename(entry.relativePath)
    res.writeHead(200, {
      'content-type': 'application/epub+zip',
      'content-length': info.size,
      'content-disposition': `attachment; filename="download.epub"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(absolute)
      .on('error', () => res.destroy())
      .pipe(res)
  }

  /** Returns true when the request was handled as /api/*. */
  return async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/')) return false
    const jobsCredential = isStudioJobCredential(req.headers.authorization)
    if (jobsCredential && !(studioJobRoute(req.method, url.pathname) && await authorizeStudioJob(req.headers.authorization, settings.jobTokenFile))) {
      sendError(res, 403, 'JOB_AUTH_REQUIRED', '此请求需要有效且有对应权限的 Studio 任务密钥。')
      return true
    }
    if (settings.auth && await settings.auth.handle(req, res, url)) return true
    if (req.method === 'GET' && url.pathname === '/api/auth/status') {
      sendJson(res, 200, { enabled: false })
      return true
    }
    const metadataRoute = /^\/api\/komga\/metadata\/(search|books|preview|apply)$/.exec(url.pathname)
    if (metadataRoute && req.method === 'POST') {
      try {
        if (!(settings.bangumiWorker || settings.bangumiKomgaUrl) || !settings.metadataTokenFile) {
          throw new HttpError(503, 'BANGUMIKOMGA_UNCONFIGURED', '请配置 BangumiKomga 服务和元数据密钥文件。')
        }
        let secret
        try { secret = (await readFile(settings.metadataTokenFile, 'utf8')).trim() } catch {
          throw new HttpError(503, 'METADATA_TOKEN_UNAVAILABLE', '无法读取元数据密钥文件。')
        }
        if (!/^studio_metadata_[A-Za-z0-9_-]{43}$/.test(secret)) {
          throw new HttpError(503, 'METADATA_TOKEN_INVALID', '元数据密钥文件格式无效。')
        }
        const supplied = /^Bearer (studio_metadata_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1]
        if (!supplied || !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))) {
          throw new HttpError(403, 'METADATA_AUTH_REQUIRED', '此接口需要独立的元数据密钥。')
        }
        if (settings.integrations?.preferences?.scrapeEnabled === false) {
          throw new HttpError(403, 'BANGUMIKOMGA_DISABLED', '管理员已在 Studio 设置中关闭 Bangumi 元数据刮削。')
        }
        sendJson(res, 200, await metadata(metadataRoute[1], await readBody(req)))
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 500
        sendError(res, status, error?.code || 'METADATA_ERROR', status === 500 ? '元数据操作失败。' : error.message)
      }
      return true
    }
    const dshAllowed = settings.integrations?.authorizeDsh(req) ?? false
    if (dshAllowed && !isDshReadRoute(req.method, url.pathname)) {
      sendError(res, 403, 'READ_ONLY_TOKEN', 'DSH 密钥仅可读取书库、连接和下载状态。')
      return true
    }
    const tokenAllowed = (!settings.auth || Boolean(settings.token)) && tokenMatches(req, settings.token)
    if (!jobsCredential && !dshAllowed && !tokenAllowed && !settings.auth?.sessionAllowed(req)) {
      sendError(res, 401, 'UNAUTHORIZED', settings.auth ? '请先登录。' : 'Missing or invalid X-LN-Token')
      return true
    }

    if (settings.integrations && await settings.integrations.handle(req, res, url, { sendJson, sendError, readBody })) return true
    if (await handleDownloadFolders(req, res, url)) return true
    if (await handleMangaApi(req, res, url, jobsCredential)) return true
    if (await handleKomgaMaintenance(req, res, url, { sendJson, sendError, readBody })) return true
    if (await handleKomgaApi(req, res, url)) return true

    const segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => {
        try {
          return decodeURIComponent(segment)
        } catch {
          throw new HttpError(400, 'INVALID_PATH', 'Malformed percent-encoding')
        }
      })
    const method = req.method ?? 'GET'

    try {
      if (method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true, dart: runtime.dartAvailable, uptime: Math.round(process.uptime()) })
        return true
      }
      if (method === 'GET' && url.pathname === '/api/bangumi/title') {
        const id = url.searchParams.get('subjectId')
        sendJson(res, 200, await metadata('identity', { kind: url.searchParams.get('kind'),
          query: url.searchParams.get('query'), ...(id === null ? {} : { subjectId: Number(id) }) }))
        return true
      }
      if (method === 'GET' && url.pathname === '/api/status') {
        sendJson(res, 200, toStatus(runtime, settings))
        return true
      }
      if (method === 'GET' && url.pathname === '/api/sources') {
        sendJson(res, 200, toSources(runtime, searchUrlConfigured))
        return true
      }
      if (method === 'GET' && url.pathname === '/api/activities') {
        sendJson(res, 200, toActivities(logger))
        return true
      }

      if (url.pathname === '/api/novels' && method === 'GET') {
        sendJson(res, 200, await listNovels(url.searchParams, jobsCredential))
        return true
      }
      if (url.pathname === '/api/novel-catalog' && method === 'GET') {
        const reference = {
          bookId: url.searchParams.get('bookId') || undefined,
          url: url.searchParams.get('url') || undefined,
          source: url.searchParams.get('source') || undefined,
        }
        if (!reference.bookId && !reference.url) throw new HttpError(400, 'EMPTY_BOOK_REFERENCE', 'bookId or url is required')
        const result = url.searchParams.get('mode') === 'volumes' ? await runtime.novels.volumes(reference)
          : await runtime.novels.details(reference, url.searchParams.get('includeVolumes') === 'true')
        sendJson(res, 200, result)
        return true
      }
      if (segments[1] === 'novels' && segments.length === 3 && method === 'GET') {
        const novel = toNovel(await novelDetail(segments[2]))
        sendJson(res, 200, novel)
        return true
      }
      if (segments[1] === 'novels' && segments.length === 4 && segments[3] === 'volumes' && method === 'GET') {
        sendJson(res, 200, await novelVolumes(segments[2]))
        return true
      }

      if (url.pathname === '/api/tasks' && method === 'GET') {
        const state = url.searchParams.get('state')
        const records = runtime.tasks.list({ limit: 200 })
        if (state === 'interrupted') {
          sendJson(res, 200, records.filter((task) => task.state === 'interrupted').map(toTask))
          return true
        }
        const incoming = records.map(toTask)
        const ids = new Set(incoming.map((task) => task.id))
        const past = (await dshHistory()).filter((task) => !ids.has(task.id)).map((task) => ({
          ...toTask({ ...task, id: 'dsh:' + task.id }), origin: 'dsh',
        }))
        const tasks = [...incoming, ...past].sort((a, b) => b.updatedTime - a.updatedTime)
        sendJson(res, 200, state ? tasks.filter((task) => task.state === state) : tasks)
        return true
      }
      if (url.pathname === '/api/tasks/files' && method === 'GET') {
        sendJson(res, 200, await savedFileHistory())
        return true
      }
      if (url.pathname === '/api/tasks' && method === 'POST') {
        sendJson(res, 201, await createTask(await readBody(req), jobsCredential))
        return true
      }
      if (segments[1] === 'tasks' && segments.length === 3 && method === 'GET') {
        const id = segments[2]
        const live = id.startsWith('dsh:') ? null : runtime.tasks.get(id)
        const historical = !live
        const task = live ?? (await dshHistory()).find((entry) => entry.id === id || 'dsh:' + entry.id === id)
        if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', 'No matching download task')
        const entries = historical ? [] : runtime.library.list({ limit: 200 }).filter((entry) => entry.taskId === task.id)
        sendJson(res, 200, {
          ...toTask({ ...task, id: historical ? 'dsh:' + task.id : id }), ...(historical ? { origin: 'dsh' } : {}),
          progress: task.progress, downloadedChapters: task.downloadedChapters, downloadedVolumes: task.downloadedVolumes,
          artifacts: await Promise.all(entries.map(libraryItem)),
        })
        return true
      }
      if (segments[1] === 'tasks' && segments.length === 4 && method === 'POST') {
        const record =
          segments[3] === 'cancel'
            ? await runtime.tasks.cancel(segments[2])
            : segments[3] === 'retry'
              ? await runtime.tasks.retry(segments[2])
              : null
        if (!record) throw new HttpError(404, 'UNKNOWN_ACTION', `Unknown task action: ${segments[3]}`)
        sendJson(res, 200, toTask(record))
        return true
      }

      if (url.pathname === '/api/library' && method === 'GET') {
        await runtime.library.load()
        const entries = runtime.library.list({ query: url.searchParams.get('query') ?? '', limit: 200 })
        sendJson(res, 200, await Promise.all(entries.map(libraryItem)))
        return true
      }
      if (url.pathname === '/api/library/stats' && method === 'GET') {
        await runtime.library.load()
        sendJson(res, 200, toLibraryStats(runtime))
        return true
      }
      if (url.pathname === '/api/library/verify' && method === 'POST') {
        const results = await runtime.library.verify()
        sendJson(res, 200, { results, allOk: results.every((entry) => entry.ok), verified: results.length })
        return true
      }
      if (segments[1] === 'library' && segments.length === 4 && segments[3] === 'verify' && method === 'POST') {
        const results = await runtime.library.verify(segments[2])
        const result = results[0]
        if (!result) throw new HttpError(404, 'FILE_NOT_FOUND', `Unknown library entry: ${segments[2]}`)
        sendJson(res, 200, {
          ok: result.ok,
          id: result.id,
          integrity: result.ok ? 'passed' : 'failed',
          problems: result.problems,
          sha256Changed: result.sha256Changed,
        })
        return true
      }
      if (segments[1] === 'library' && segments.length === 3 && method === 'GET') {
        const entry = runtime.library.get(segments[2])
        if (!entry) throw new HttpError(404, 'FILE_NOT_FOUND', 'Unknown library entry')
        sendJson(res, 200, await libraryItem(entry))
        return true
      }
      if (segments[1] === 'library' && segments.length === 4 && segments[3] === 'file' && ['GET', 'HEAD'].includes(method)) {
        await libraryFile(segments[2], req, res)
        return true
      }
      if (segments[1] === 'library' && segments.length === 3 && method === 'DELETE') {
        if (!settings.allowDelete) {
          throw new HttpError(403, 'DELETE_DISABLED', 'Set LN_BFF_ALLOW_DELETE=true to enable EPUB deletion')
        }
        const removed = await runtime.library.remove(segments[2])
        if (!removed) throw new HttpError(404, 'FILE_NOT_FOUND', `Unknown library entry: ${segments[2]}`)
        sendJson(res, 200, { ok: true, id: segments[2] })
        return true
      }

      sendError(res, 404, 'NOT_FOUND', `No endpoint for ${method} ${url.pathname}`)
      return true
    } catch (error) {
      if (error instanceof HttpError || error instanceof MetadataError) {
        sendError(res, error.status, error.code, error.message)
        return true
      }
      if (error instanceof TaskManagerError) {
        const status = error.code === 'TASK_NOT_FOUND' ? 404 : 409
        sendError(res, status, error.code, error.message)
        return true
      }
      logger.error('webapi', 'request_failed', { method, path: url.pathname, error: String(error) })
      sendError(res, 500, 'INTERNAL_ERROR', String(error))
      return true
    }
  }
}

