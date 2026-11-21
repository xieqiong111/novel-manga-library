import { SuwayomiError } from './suwayomi-client.mjs'

const idPattern = /^[1-9]\d{0,9}$/
const maxCatalogBytes = 2 * 1024 * 1024

async function readCatalog(response) {
  const chunks = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > maxCatalogBytes) throw new Error('Archive catalog too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function archiveOrigin(value) {
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) && url.href === `${url.origin}/`) return url.origin
  } catch { /* Invalid configuration remains isolated from Suwayomi. */ }
  return null
}

const archiveRequest = { redirect: 'error' }
export function createMangaVolumeClient(value = process.env.LN_VOLUME_ARCHIVE_URL) {
  if (!value) return null
  const origin = archiveOrigin(value)
  return async function getVolumes(mangaId, selection = {}) {
    try {
      if (!origin || !idPattern.test(mangaId)) throw new Error('Invalid endpoint')
      const url = new URL(`/manga/${mangaId}/volumes`, origin)
      if (selection.chapterIds?.length) url.searchParams.set('chapterIds', selection.chapterIds.join(','))
      if (selection.offset !== undefined) url.searchParams.set('offset', String(selection.offset))
      if (selection.limit !== undefined) url.searchParams.set('limit', String(selection.limit))
      const init = { ...archiveRequest, signal: AbortSignal.timeout(12000) }
      let response = await fetch(url, init)
      if (response.status === 404 && url.search) {
        await response.body?.cancel()
        url.search = ''
        response = await fetch(url, init)
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('Archive lookup failed')
      }
      const result = await readCatalog(response)
      if (!Array.isArray(result.volumes) || result.volumes.length > 5000 || !result.volumes.every(validVolume)) {
        throw new Error('Invalid volume catalog')
      }
      if (result.archiveMode === undefined) return result.volumes
      if (!['volume', 'chapter', 'unsupported'].includes(result.archiveMode) ||
          !Number.isInteger(result.chapterCount) || result.chapterCount < 0 || result.chapterCount > 5000 ||
          !Array.isArray(result.chapters) || result.chapters.length > 100 ||
          result.chapters.length > result.chapterCount || !result.chapters.every(validChapter)) {
        throw new Error('Invalid chapter archive catalog')
      }
      return result
    } catch {
      throw new SuwayomiError('VOLUME_ARCHIVE_UNAVAILABLE', 'Komga 归档服务暂不可用。', 503)
    }
  }
}

const archiveStates = ['waiting_archive', 'archived', 'archive_failed', 'legacy', 'unsupported']
const validSequence = (n) => Number.isSafeInteger(n) && n > 0 && n < 10 ** 15
export const validArchiveFile = (file) => typeof file === 'string' && file.length <= 512 &&
  file.endsWith('.cbz') && file.includes('/') && file.split('/').every((part) =>
    part && !part.startsWith('.') && !/[\\:\x00-\x1f\x7f]/.test(part))

export function createMangaArchiveHistory(value = process.env.LN_VOLUME_ARCHIVE_URL) {
  if (!value) return null
  const origin = archiveOrigin(value)
  async function read(pathname, params) {
    if (!origin) throw Error('Invalid archive endpoint')
    const url = new URL(pathname, origin)
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value))
    const response = await fetch(url, { ...archiveRequest, signal: AbortSignal.timeout(8000) })
    if (!response.ok) {
      await response.body?.cancel()
      throw Error('Archive history request failed')
    }
    return readCatalog(response)
  }
  return {
    async page({ before, limit = 50, mangaId } = {}) {
      const { history, nextBefore } = await read('/history', { before, limit, mangaId })
      if (!Array.isArray(history) || history.length > limit || !(nextBefore === null || validSequence(nextBefore)) ||
          history.some((row) => !validSequence(row?.seq) || !idPattern.test(row.chapterId) || !idPattern.test(row.mangaId) ||
            (mangaId !== undefined && row.mangaId !== mangaId) || typeof row.title !== 'string' || typeof row.chapterName !== 'string' ||
            !Number.isSafeInteger(row.observedAt) || row.observedAt <= 0 || !archiveStates.includes(row.archiveState) ||
            (['archived', 'legacy'].includes(row.archiveState) ? !validArchiveFile(row.file) : row.file !== null))) {
        throw Error('Invalid archive history')
      }
      return { history: history.map((row) => ({
        id: row.chapterId, chapterId: row.chapterId, mangaId: row.mangaId, title: row.title, chapterName: row.chapterName,
        state: 'completed', upstreamState: 'FINISHED', percent: null, observedAt: row.observedAt,
        archive: { state: row.archiveState, file: row.file },
      })), nextBefore }
    },
    async events(after) {
      const { events } = await read('/archive-events', { after })
      if (!Array.isArray(events) || events.length > 100 || events.some((row, index) =>
        !validSequence(row?.seq) || row.seq <= (index > 0 ? events[index - 1].seq : after) ||
        !idPattern.test(row.mangaId) || !validArchiveFile(row.file))) throw Error('Invalid archive events')
      return events
    },
  }
}

function validVolume(volume) {
  return volume && Number.isInteger(volume.number) && volume.number > 0 && volume.number <= 9999
    && Array.isArray(volume.chapterIds) && volume.chapterIds.length > 0 && volume.chapterIds.length <= 5000
    && volume.chapterIds.every((id) => typeof id === 'string' && idPattern.test(id))
    && Number.isInteger(volume.downloaded) && volume.downloaded >= 0 && volume.downloaded <= volume.chapterIds.length
    && (volume.archiveFailed === undefined || typeof volume.archiveFailed === 'boolean')
    && (volume.filename === null || volume.filename === `第${String(volume.number).padStart(2, '0')}卷.cbz`)
}

function validChapter(chapter) {
  if (!chapter || typeof chapter.id !== 'string' || !idPattern.test(chapter.id) ||
      typeof chapter.name !== 'string' || typeof chapter.downloaded !== 'boolean' ||
      (chapter.number !== null && (typeof chapter.number !== 'string' || !/^\d{1,4}(?:\.\d{1,4})?$/.test(chapter.number))) ||
      (chapter.legacyVolume !== undefined && (typeof chapter.legacyVolume !== 'string' || !/^第\d{2,4}卷\.cbz$/.test(chapter.legacyVolume))) ||
      (chapter.archiveFailed !== undefined && typeof chapter.archiveFailed !== 'boolean')) return false
  if (chapter.number === null) {
    return chapter.filename === null || chapter.filename === `章节 [${chapter.id}].cbz`
  }
  const [whole, fraction] = chapter.number.split('.')
  const label = fraction === undefined ? whole.padStart(3, '0') : `${whole.padStart(3, '0')}.${fraction}`
  return chapter.filename === null || chapter.filename === `第${label}话 [${chapter.id}].cbz`
}
