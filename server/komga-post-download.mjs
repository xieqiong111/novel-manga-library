import { link, lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { folderWithin } from '../dist/core/download-folders.js'
import { atomicWriteJson } from '../dist/util/json.js'
import { validArchiveFile } from './manga-volume-client.mjs'
import { MetadataError } from './bangumi-komga.mjs'
import { readMangaBangumiBinding } from './bangumi-download.mjs'

const interval = 20_000
const maxAttempts = 10
const connectErrors = new Set(['BANGUMI_TIMEOUT', 'BANGUMI_CONNECTION_FAILED', 'BANGUMI_PROXY_FAILED', 'BANGUMI_TLS_FAILED'])

function localPath(value) {
  if (typeof value !== 'string') return null
  try {
    const file = value.startsWith('file:') ? fileURLToPath(value, { windows: false }) : value
    return path.posix.isAbsolute(file) ? path.posix.normalize(file).replace(/\/$/, '') || '/' : null
  } catch { return null }
}

function within(parent, child) {
  const relative = path.posix.relative(parent, child)
  return relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative)
}

async function isVolumeFolder(folder, mangaId, sourceId) {
  const marker = path.join(path.dirname(folder), '.studio-series.json')
  try {
    const stat = await lstat(marker)
    if (!stat.isFile() || stat.size > 1024) return false
    const work = JSON.parse(await readFile(marker, 'utf8'), (key, value, context) =>
      key === 'sourceId' && typeof value === 'number' ? context.source : value)
    return String(work.mangaId) === mangaId && (!sourceId || work.sourceId === sourceId)
  } catch { return false }
}

const archivedChapter = /^(?:第[0-9]{3,4}(?:\.[0-9]{1,4})?话|章节) \[\d+\]\.cbz$|^第[0-9]{2,4}卷\.cbz$/u

async function projectVolumeFolder(folder, relativeFolder, requestedFile, previousCover) {
  const work = path.dirname(folder)
  const prefix = path.basename(folder) + ' - '
  const files = (await readdir(folder, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && archivedChapter.test(entry.name))
    .map((entry) => entry.name).sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
  if (!files.includes(requestedFile)) {
    throw new MetadataError(409, 'ARCHIVE_NOT_FOUND', '分卷归档中未找到待收录的 CBZ。')
  }
  for (const name of files) {
    const source = path.join(folder, name)
    const target = path.join(work, prefix + name)
    try { await link(source, target) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const [current, original] = await Promise.all([lstat(target, { bigint: true }), lstat(source, { bigint: true })])
      if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino) {
        throw new MetadataError(409, 'KOMGA_PROJECTION_CONFLICT', '作品目录中有同名文件，无法安全建立 Komga 入口。')
      }
    }
  }
  const coverFile = files.includes(previousCover) ? previousCover : files[0]
  const seriesFolder = path.posix.dirname(relativeFolder)
  return { seriesFolder, file: path.posix.join(seriesFolder, prefix + requestedFile),
    coverFile, coverPath: path.posix.join(seriesFolder, prefix + coverFile) }
}

async function indexedSeries(client, libraryId, target, file, coverPath) {
  let series
  for (let page = 0; !series; page += 1) {
    const result = await client.series({ libraryId, activeOnly: true, includePaths: true, page, size: 100 })
    series = result.content.find((item) => localPath(item.path) === target)
    if (result.page.number !== page || (result.page.last && !series)) return null
  }
  let indexed = false
  let coverBook
  for (let page = 0; ; page += 1) {
    const result = await client.metadataBooks(series.id, page, { includePaths: true })
    indexed ||= result.books.some((book) => localPath(book.path) === file)
    coverBook ??= coverPath ? result.books.find((book) => localPath(book.path) === coverPath) : undefined
    if (indexed && (!coverPath || coverBook)) return { ...series, coverBook }
    if (result.last || result.page !== page) return null
  }
}

export async function openKomgaPostDownload({ settings, archiveHistory, logger, now = Date.now }) {
  const libraryMount = localPath(settings.mangaStorageLabel || settings.mangaStorageRoot)
  if (!libraryMount || !settings.mangaStorageRoot || !archiveHistory || !settings.config?.dataDir) return null
  const file = path.join(settings.config.dataDir, 'komga-post-download.json')
  let state = { after: 0, jobs: [], collections: {} }
  try {
    state = JSON.parse(await readFile(file, 'utf8'))
    if (!Number.isSafeInteger(state.after) || state.after < 0 || !Array.isArray(state.jobs)) {
      throw Error('Invalid Komga follow-up state')
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  state.collections ??= {}
  let current = null
  let timer
  let stopped = false

  function preferences() {
    const options = settings.integrations?.preferences
    return {
      refresh: options?.postDownloadRefresh === true,
      scrape: options?.postDownloadScrape === true && options?.scrapeEnabled === true,
    }
  }

  async function run({ currentKomga, metadata, scan, mangaVolumes }) {
    const jobs = new Map(state.jobs.map((job) => [job.folder, job]))
    const configured = preferences()
    const events = await archiveHistory.events(state.after).catch(() => {
      logger.warn('komga', 'archive_events_unavailable')
      return []
    })
    for (const event of events) {
      if (configured.refresh || configured.scrape) {
        const folder = path.posix.dirname(event.file)
        const coverFile = jobs.get(folder)?.coverFile
        jobs.delete(folder)
        jobs.set(folder, { folder, file: event.file, mangaId: event.mangaId, phase: 'queued', attempts: 0, nextAt: now(), coverFile })
      }
      state.after = event.seq
    }
    const pending = [...jobs.values()].filter((job) => ['queued', 'indexing', 'scraping'].includes(job.phase))
    const finished = [...jobs.values()].filter((job) => !pending.includes(job)).slice(-250)
    state.jobs = [...finished, ...pending]
    if (events.length) await atomicWriteJson(file, state)
    const due = pending.filter((job) => job.nextAt <= now()).slice(0, 8)
    if (!due.length) return
    const client = currentKomga()
    const scans = new Map()
    let libraries
    for (const job of due) {
      const options = preferences()
      const settingsSnapshot = JSON.stringify([settings.integrations?.preferences, settings.integrations?.bangumi])
      const ensureCurrent = () => {
        if (currentKomga() !== client || JSON.stringify([settings.integrations?.preferences, settings.integrations?.bangumi]) !== settingsSnapshot) {
          throw new MetadataError(409, 'SETTINGS_CHANGED', 'Komga 或刮削设置已改变，稍后重试。')
        }
      }
      try {
        if (!options.refresh && !options.scrape) {
          job.phase = 'skipped'
          job.message = '下载后的刷新与刮削已关闭。'
          continue
        }
        if (!validArchiveFile(job.file)) throw new MetadataError(409, 'ARCHIVE_PATH_INVALID', 'CBZ 路径无效。')
        const folder = await folderWithin(settings.mangaStorageRoot, job.folder)
        if (!(await lstat(path.join(folder, path.posix.basename(job.file)))).isFile()) {
          throw new MetadataError(409, 'ARCHIVE_NOT_FOUND', '原下载位置的 CBZ 不可读取。')
        }
        const binding = await readMangaBangumiBinding(settings.config.downloadFoldersFile, job.mangaId)
        const leaf = path.posix.basename(job.folder)
        const numbered = /^第([0-9]{2,4})卷$/.exec(leaf)
        const nested = (numbered || leaf === '未分卷') && await isVolumeFolder(folder, job.mangaId, binding?.sourceId)
        const volume = binding && nested && numbered
        const archivedFolder = path.posix.join(libraryMount, job.folder)
        libraries ??= (await client.libraries({ includePaths: true })).libraries
          .map((library) => ({ id: library.id, root: localPath(library.root) }))
          .filter((library) => library.root)
          .sort((a, b) => b.root.length - a.root.length)
        const library = libraries.find(({ root }) => within(root, archivedFolder))
        if (!library) throw new MetadataError(409, 'KOMGA_LIBRARY_MISSING', '下载目录不在 Komga 已配置的漫画书库内。')
        const projection = nested ? await projectVolumeFolder(folder, job.folder, path.posix.basename(job.file), job.coverFile) : null
        if (projection) {
          const work = path.posix.join(libraryMount, projection.seriesFolder)
          if (!within(library.root, work)) {
            throw new MetadataError(409, 'KOMGA_LIBRARY_MISSING', '作品目录需处于同一个 Komga 漫画书库。')
          }
          ensureCurrent()
          await client.excludeVolumeFolder(library.id, archivedFolder)
          job.coverFile = projection.coverFile
        }
        const target = projection ? path.posix.join(libraryMount, projection.seriesFolder) : archivedFolder
        const targetFile = path.posix.join(libraryMount, projection?.file ?? job.file)
        ensureCurrent()
        if (job.phase === 'queued' && options.refresh) {
          if (!scans.has(library.id)) scans.set(library.id, await scan(client, library.id))
          const result = scans.get(library.id)
          if (!result.accepted) throw new MetadataError(502, 'KOMGA_SCAN_FAILED', result.message)
          job.phase = 'indexing'
          job.nextAt = now() + interval
          job.message = 'Komga 已接受扫描，等待收录该 CBZ。'
          continue
        }
        const coverPath = volume && projection ? path.posix.join(libraryMount, projection.coverPath) : undefined
        const series = await indexedSeries(client, library.id, target, targetFile, coverPath)
        if (!series) {
          if (projection && options.refresh && !scans.has(library.id)) scans.set(library.id, await scan(client, library.id))
          throw new MetadataError(409, 'KOMGA_INDEX_PENDING', 'Komga 尚未收录该 CBZ。')
        }
        job.phase = 'scraping'
        const runMetadata = async (task) => {
          try {
            return await task()
          } catch (error) {
            if (!connectErrors.has(error?.code) || !settings.integrations?.bangumiArchiveAvailable ||
                settings.integrations.bangumi?.sourceMode !== 'live') throw error
            ensureCurrent()
            const result = await task({ sourceMode: 'archive', accessToken: '', proxyUrl: '' })
            return result ? { ...result, fallback: true } : result
          }
        }
        if (options.scrape && (!nested || binding)) {
          const input = { libraryId: library.id, seriesId: series.id, kind: 'manga', ...(job.mangaId ? { mangaId: job.mangaId } : {}),
            ...(binding ? { confirmedSubjectId: binding.subjectId } : {}) }
          const result = await runMetadata((connection) => connection ? metadata('auto-series', input, ensureCurrent, connection)
            : metadata('auto-series', input, ensureCurrent))
          job.message = result.updated ? (nested ? 'Komga 已收录，作品元数据已更新。' : 'Komga 已收录，元数据已更新。')
            : `Komga 已收录，${result.reason ?? '没有可写入的字段'}。`
          if (result.cover?.status === 'failed') job.message += '作品封面写入失败。'
          if (result.fallback) job.message += '使用了 Bangumi 官方离线档案。'
          if (volume && mangaVolumes) {
            const number = Number(volume[1])
            const volumeResult = await runMetadata(async (connection) => {
              const subjectId = await mangaVolumes.volumeSubject(job.mangaId, binding, number, connection)
              if (!subjectId) return null
              const result = await metadata('auto-volume', { libraryId: library.id, seriesId: series.id,
                bookId: series.coverBook.id, subjectId }, ensureCurrent, connection)
              await mangaVolumes.rememberVolume(job.mangaId, binding, number, result)
              return result
            })
            if (!volumeResult) job.message += '此卷暂无确定的 Bangumi 单行本条目。'
            else if (volumeResult.cover?.status === 'failed') job.message += '卷封面写入失败。'
            else if (volumeResult.cover?.status === 'unavailable') job.message += '当前数据源无卷封面。'
            else job.message += '已核对作品下的卷元数据。'
          }
        } else {
          job.message = nested ? 'Komga 已合并到同一作品。' : 'Komga 已收录该 CBZ。'
        }
        job.phase = 'done'
      } catch (error) {
        if (error?.code === 'SCRAPE_LIBRARY_EXCLUDED') {
          job.phase = 'skipped'
          job.message = 'Komga 已收录。刮削设置未允许这个书库。'
          continue
        }
        job.attempts += 1
        job.nextAt = now() + Math.min(interval * job.attempts, 120_000)
        job.message = error?.status ? error.message : '暂时无法处理下载后的书库更新。'
        if (job.attempts >= maxAttempts) job.phase = 'failed'
      }
    }
    await atomicWriteJson(file, state)
  }

  function tick(dependencies) {
    if (!current) current = run(dependencies).finally(() => { current = null })
    return current
  }

  return {
    tick,
    status: (relative) => {
      const folder = path.posix.dirname(relative)
      const job = state.jobs.find((entry) => entry.folder === folder)
      return job ? { phase: job.phase, message: job.message ?? '等待刷新和刮削。' } : null
    },
    start(dependencies) {
      const poll = async () => {
        try { await tick(dependencies) }
        catch { logger.warn('komga', 'download_follow_up_unavailable') }
        if (!stopped) {
          timer = setTimeout(poll, interval)
          timer.unref()
        }
      }
      void poll()
    },
    async stop() {
      stopped = true
      clearTimeout(timer)
      await current?.catch(() => {})
    },
  }
}
