import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { folderWithin } from '../dist/core/download-folders.js'
import { atomicWriteJson } from '../dist/util/json.js'
import { validArchiveFile } from './manga-volume-client.mjs'
import { MetadataError } from './bangumi-komga.mjs'

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

async function indexedSeries(client, libraryId, target, file) {
  let series
  for (let page = 0; !series; page += 1) {
    const result = await client.series({ libraryId, activeOnly: true, includePaths: true, page, size: 100 })
    series = result.content.find((item) => localPath(item.path) === target)
    if (result.page.number !== page || (result.page.last && !series)) return null
  }
  for (let page = 0; ; page += 1) {
    const result = await client.metadataBooks(series.id, page, { includePaths: true })
    if (result.books.some((book) => localPath(book.path) === file)) return series
    if (result.last || result.page !== page) return null
  }
}

export async function openKomgaPostDownload({ settings, archiveHistory, logger, now = Date.now }) {
  const libraryMount = localPath(settings.mangaStorageLabel || settings.mangaStorageRoot)
  if (!libraryMount || !settings.mangaStorageRoot || !archiveHistory || !settings.config?.dataDir) return null
  const file = path.join(settings.config.dataDir, 'komga-post-download.json')
  let state = { after: 0, jobs: [] }
  try {
    state = JSON.parse(await readFile(file, 'utf8'))
    if (!Number.isSafeInteger(state.after) || state.after < 0 || !Array.isArray(state.jobs)) {
      throw Error('Invalid Komga follow-up state')
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
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

  async function run({ currentKomga, metadata, scan }) {
    const jobs = new Map(state.jobs.map((job) => [job.folder, job]))
    const configured = preferences()
    const events = await archiveHistory.events(state.after).catch(() => {
      logger.warn('komga', 'archive_events_unavailable')
      return []
    })
    for (const event of events) {
      if (configured.refresh || configured.scrape) {
        const folder = path.posix.dirname(event.file)
        jobs.delete(folder)
        jobs.set(folder, { folder, file: event.file, phase: 'queued', attempts: 0, nextAt: now() })
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
        const target = path.posix.join(libraryMount, job.folder)
        const targetFile = path.posix.join(libraryMount, job.file)
        libraries ??= (await client.libraries({ includePaths: true })).libraries
          .map((library) => ({ id: library.id, root: localPath(library.root) }))
          .filter((library) => library.root)
          .sort((a, b) => b.root.length - a.root.length)
        const library = libraries.find(({ root }) => within(root, target))
        if (!library) throw new MetadataError(409, 'KOMGA_LIBRARY_MISSING', '下载目录不在 Komga 已配置的漫画书库内。')
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
        const series = await indexedSeries(client, library.id, target, targetFile)
        if (!series) throw new MetadataError(409, 'KOMGA_INDEX_PENDING', 'Komga 尚未收录该 CBZ。')
        job.phase = 'scraping'
        if (options.scrape) {
          const input = { libraryId: library.id, seriesId: series.id, kind: 'manga' }
          let fallback = false
          let result
          try {
            result = await metadata('auto-series', input, ensureCurrent)
          } catch (error) {
            if (!connectErrors.has(error?.code) || !settings.integrations?.bangumiArchiveAvailable ||
                settings.integrations.bangumi?.sourceMode !== 'live') throw error
            ensureCurrent()
            result = await metadata('auto-series', input, ensureCurrent, { sourceMode: 'archive', accessToken: '', proxyUrl: '' })
            fallback = true
          }
          job.message = result.updated ? 'Komga 已收录，元数据已更新。'
            : `Komga 已收录，${result.reason ?? '没有可写入的元数据'}。`
          if (result.cover?.status === 'failed') job.message += '封面写入失败。'
          if (fallback) job.message += '实时 API 不通，使用了 Bangumi 官方离线档案。'
        } else {
          job.message = 'Komga 已收录该 CBZ。'
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
