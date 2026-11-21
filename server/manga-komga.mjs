import { createMangaVolumeClient } from './manga-volume-client.mjs'
import { SuwayomiError } from './suwayomi-client.mjs'

function progress(filename, downloaded, total, tasks, archiveFailed) {
  if (filename) return 'archived'
  if (downloaded === total) return archiveFailed ? 'archive_failed' : 'waiting_archive'
  if (tasks.some((task) => task.state === 'failed')) return 'failed'
  if (tasks.some((task) => task.state === 'running')) return 'downloading'
  if (tasks.some((task) => task.state === 'queued')) return 'queued'
  return 'idle'
}

function requireCatalog(mangaId, number) {
  if (!/^[1-9]\d{0,9}$/.test(mangaId) || Number(mangaId) > 2147483647) {
    throw new SuwayomiError('INVALID_ID', '请提供有效的 Suwayomi 漫画 ID。', 400)
  }
  if (number !== undefined && (!Number.isInteger(number) || number < 1 || number > 9999)) {
    throw new SuwayomiError('INVALID_VOLUME', '请选择有效卷号。', 400)
  }
}

function chapterSelection(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 ||
      ids.some((id) => typeof id !== 'string' || !/^[1-9]\d{0,9}$/.test(id) || Number(id) > 2147483647)) {
    throw new SuwayomiError('INVALID_CHAPTERS', '请选择 1 至 100 个有效章节 ID。', 400)
  }
  return [...new Set(ids)]
}

function emptyDownload(skipped, filename = null) {
  return { queued: [], skipped, completed: [], unconfirmed: [], filename }
}

export function createMangaKomga(client, getVolumes, archiveUrl) {
  if (getVolumes === undefined) getVolumes = createMangaVolumeClient(archiveUrl)

  async function load(mangaId, selection) {
    if (!getVolumes) throw new SuwayomiError('VOLUME_ARCHIVE_DISABLED', '尚未配置 Komga 归档服务。', 503)
    const catalog = await getVolumes(mangaId, selection)
    return Array.isArray(catalog) ? { volumes: catalog } : catalog
  }

  return {
    async status(mangaId, number, selection = {}) {
      requireCatalog(mangaId, number)
      const chapterIds = selection.chapterIds === undefined ? undefined : chapterSelection(selection.chapterIds)
      const offset = selection.offset ?? 0
      const limit = selection.limit ?? 20
      if (!Number.isInteger(offset) || offset < 0 || offset > 5000 ||
          !Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new SuwayomiError('INVALID_PAGINATION', '请选择有效的章节分页。', 400)
      }
      if (number !== undefined && (chapterIds || selection.offset !== undefined || selection.limit !== undefined)) {
        throw new SuwayomiError('INVALID_ARCHIVE_SELECTION', '卷号和章节筛选请分别查询。', 400)
      }
      if (!getVolumes) return { available: false, volumes: [] }
      const catalog = await load(mangaId, { ...selection, chapterIds })
      const volumes = number === undefined ? catalog.volumes : catalog.volumes.filter((volume) => volume.number === number)
      const chapters = number === undefined ? catalog.chapters ?? [] : []
      const surveyQueue = volumes.some((volume) => !volume.filename && volume.downloaded < volume.chapterIds.length) ||
        chapters.some((chapter) => !chapter.filename && !chapter.downloaded)
      const queue = surveyQueue ? (await client.tasks({ action: 'status' })).queue : []
      const tasks = new Map(queue.filter((task) => task.mangaId === mangaId).map((task) => [task.chapterId, task]))
      const result = {
        available: true,
        volumes: volumes.map(({ chapterIds: ids, ...volume }) => {
          const active = ids.map((id) => tasks.get(id)).filter(Boolean)
          const total = ids.length
          return {
            ...volume, ...(catalog.archiveMode ? { chapterIds: ids } : {}), total, tasks: active,
            state: progress(volume.filename, volume.downloaded, total, active, volume.archiveFailed),
          }
        }),
      }
      if (!catalog.archiveMode) return result
      return {
        ...result, archiveMode: catalog.archiveMode,
        chapters: chapters.map((chapter) => {
          const task = tasks.get(chapter.id) ?? null
          return { ...chapter, task, state: progress(chapter.filename, Number(chapter.downloaded), 1, task ? [task] : [], chapter.archiveFailed) }
        }),
        ...(chapterIds ? { missingChapterIds: chapterIds.filter((id) => !chapters.some((chapter) => chapter.id === id)) }
          : number === undefined ? {
              chapterPage: { total: catalog.chapterCount, offset, nextOffset: chapters.length && offset + chapters.length < catalog.chapterCount
                ? offset + chapters.length : null },
            } : {}),
      }
    },

    async download(mangaId, number) {
      requireCatalog(mangaId, number)
      const catalog = await load(mangaId)
      const volume = catalog.volumes.find((entry) => entry.number === number)
      if (!volume) {
        const message = catalog.archiveMode === 'chapter'
          ? '该来源按话归档。请使用章节 ID 下载，话号不能当成卷号。'
          : '这一卷缺少明确的来源条目，或源目录已经变化。'
        throw new SuwayomiError('VOLUME_UNAVAILABLE', message, 409)
      }
      if (volume.filename || volume.downloaded === volume.chapterIds.length) {
        return emptyDownload(volume.chapterIds, volume.filename)
      }
      if (volume.chapterIds.length > 100) {
        throw new SuwayomiError('VOLUME_TOO_LARGE', '该卷超过 100 话，请分批下载章节，下载齐后会自动归档。', 409)
      }
      return { ...(await client.download({ mangaId, chapterIds: volume.chapterIds })), filename: null }
    },

    async downloadChapters(mangaId, ids) {
      requireCatalog(mangaId)
      const chapterIds = chapterSelection(ids)
      const catalog = await load(mangaId, { chapterIds })
      if (catalog.archiveMode !== 'chapter') {
        throw new SuwayomiError('CHAPTER_ARCHIVE_UNAVAILABLE',
          '该来源未确认按话归档。请查归档状态；按卷的作品可选卷，或在该卷内分批下载章节。', 409)
      }
      const entries = new Map(catalog.chapters.map((chapter) => [chapter.id, chapter]))
      if (chapterIds.some((id) => !entries.has(id))) {
        throw new SuwayomiError('CHAPTER_ARCHIVE_SELECTION_INVALID', '有章节不在这部作品的单话归档目录中，请重新核对章节 ID。', 409)
      }
      const requested = chapterIds.filter((id) => !entries.get(id).downloaded && !entries.get(id).filename)
      const skipped = chapterIds.filter((id) => !requested.includes(id))
      const archived = chapterIds.flatMap((id) => {
        const { filename } = entries.get(id)
        return filename ? [{ chapterId: id, filename }] : []
      })
      if (!requested.length) return { ...emptyDownload(skipped), archived }
      const result = await client.download({ mangaId, chapterIds: requested })
      return { ...result, skipped: [...skipped, ...result.skipped], filename: null, archived }
    },
  }
}
