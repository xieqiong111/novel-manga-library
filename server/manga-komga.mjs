import { createMangaArchiveHistory, createMangaVolumeClient } from './manga-volume-client.mjs'
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
  const archiveHistory = createMangaArchiveHistory(archiveUrl)

  async function load(mangaId, selection) {
    if (!getVolumes) throw new SuwayomiError('VOLUME_ARCHIVE_DISABLED', '尚未配置 Komga 归档服务。', 503)
    const catalog = await getVolumes(mangaId, selection)
    return Array.isArray(catalog) ? { volumes: catalog } : catalog
  }

  return {
    async history(mangaId, before) {
      if (mangaId) requireCatalog(mangaId)
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 1 || before >= 10 ** 15)) {
        throw new SuwayomiError('INVALID_HISTORY_CURSOR', '请使用上一页返回的 nextBefore。', 400)
      }
      if (!archiveHistory) return null
      try {
        return await archiveHistory.page({ mangaId: mangaId ?? undefined, before })
      } catch {
        return { historyError: '漫画完成记录暂不可用。' }
      }
    },
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
        ...(catalog.bangumiSubjectId ? { bangumiSubjectId: catalog.bangumiSubjectId, folderTitle: catalog.folderTitle } : {}),
        chapters: chapters.map((chapter) => {
          const task = tasks.get(chapter.id) ?? null
          const state = !chapter.filename && chapter.legacyVolume ? 'in_legacy_volume'
            : progress(chapter.filename, Number(chapter.downloaded), 1, task ? [task] : [], chapter.archiveFailed)
          return { ...chapter, task, state }
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
      throw new SuwayomiError('VOLUME_DOWNLOAD_DISABLED', '漫画下载现按章进行，请使用章节 ID。', 409)
    },

    async downloadChapters(mangaId, ids, bindBangumi) {
      requireCatalog(mangaId)
      const chapterIds = chapterSelection(ids)
      let catalog = await load(mangaId, { chapterIds })
      if (catalog.archiveMode !== 'chapter') {
        throw new SuwayomiError('CHAPTER_ARCHIVE_UNAVAILABLE',
          '这个来源未提供可单独归档的章节，请选择提供分话目录的来源。', 409)
      }
      if (chapterIds.some((id) => !catalog.chapters.some((chapter) => chapter.id === id))) {
        throw new SuwayomiError('CHAPTER_ARCHIVE_SELECTION_INVALID', '选择中含整卷或无效条目，请选实际章节。', 409)
      }
      const bangumi = bindBangumi ? await bindBangumi() : null
      if (bangumi) {
        catalog = await load(mangaId, { chapterIds })
        if (catalog.bangumiSubjectId !== bangumi.id) {
          throw new SuwayomiError('BANGUMI_ARCHIVE_UNCONFIRMED', '归档服务还未确认 Bangumi 文件夹名称，未提交下载。', 503)
        }
      }
      const entries = new Map(catalog.chapters.map((chapter) => [chapter.id, chapter]))
      if (chapterIds.some((id) => !entries.has(id))) {
        throw new SuwayomiError('CHAPTER_ARCHIVE_SELECTION_INVALID', '确认保存目录时章节列表发生变化，请重新选择。', 409)
      }
      const requested = chapterIds.filter((id) => !entries.get(id).downloaded && !entries.get(id).filename && !entries.get(id).legacyVolume)
      const skipped = chapterIds.filter((id) => !requested.includes(id))
      const archived = chapterIds.flatMap((id) => {
        const { filename } = entries.get(id)
        return filename ? [{ chapterId: id, filename }] : []
      })
      if (!requested.length) return { ...emptyDownload(skipped), archived, ...(bangumi ? { bangumi } : {}) }
      const result = await client.download({ mangaId, chapterIds: requested })
      return { ...result, skipped: [...skipped, ...result.skipped], filename: null, archived, ...(bangumi ? { bangumi } : {}) }
    },
  }
}
