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

export function createMangaVolumeClient(value = process.env.LN_VOLUME_ARCHIVE_URL) {
  if (!value) return null
  let origin
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) && url.href === `${url.origin}/`) origin = url.origin
  } catch {
    // Keep the other manga and novel routes available on invalid configuration.
  }
  return async function getVolumes(mangaId, selection = {}) {
    try {
      if (!origin || !idPattern.test(mangaId)) throw new Error('Invalid endpoint')
      const url = new URL(`/manga/${mangaId}/volumes`, origin)
      if (selection.chapterIds?.length) url.searchParams.set('chapterIds', selection.chapterIds.join(','))
      if (selection.offset !== undefined) url.searchParams.set('offset', String(selection.offset))
      if (selection.limit !== undefined) url.searchParams.set('limit', String(selection.limit))
      const init = { redirect: 'error', signal: AbortSignal.timeout(12000) }
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
      typeof chapter.number !== 'string' || !/^\d{1,4}(?:\.\d{1,4})?$/.test(chapter.number) ||
      (chapter.archiveFailed !== undefined && typeof chapter.archiveFailed !== 'boolean')) return false
  const [whole, fraction] = chapter.number.split('.')
  const label = fraction === undefined ? whole.padStart(3, '0') : `${whole.padStart(3, '0')}.${fraction}`
  return chapter.filename === null || chapter.filename === `第${label}话 [${chapter.id}].cbz`
}
