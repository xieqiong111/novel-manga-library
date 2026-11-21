import { readFile } from 'node:fs/promises'
import { SuwayomiError } from './suwayomi-client.mjs'

const endpoints = {
  health: '/api/health',
  novels: '/api/library',
  novelTasks: '/api/tasks',
  manga: '/api/manga/library',
  mangaTasks: '/api/manga/downloads',
  komga: '/api/komga/libraries',
}

export async function readStudio({ url, tokenFile, resource, libraryId, mangaId, volume, chapterIds }) {
  if (!url || !tokenFile) throw new SuwayomiError('STUDIO_READER_UNCONFIGURED', 'Set LN_STUDIO_READ_URL and LN_STUDIO_READ_TOKEN_FILE.', 503)
  let pathname = endpoints[resource]
  const query = new URLSearchParams()
  if (resource === 'komgaSeries' && libraryId) {
    pathname = '/api/komga/series'
    query.set('libraryId', libraryId)
  }
  if (['mangaVolume', 'mangaArchive'].includes(resource) && /^[1-9]\d{0,9}$/.test(mangaId ?? '')) {
    pathname = `/api/manga/${mangaId}/komga`
    if (volume !== undefined) {
      if (!Number.isInteger(volume) || volume < 1 || volume > 9999) {
        throw new SuwayomiError('INVALID_VOLUME', 'Choose a volume from 1 to 9999.', 400)
      }
      query.set('volume', String(volume))
    }
    if (chapterIds !== undefined) {
      if (volume !== undefined || !Array.isArray(chapterIds) || !chapterIds.length || chapterIds.length > 100 ||
          chapterIds.some((id) => typeof id !== 'string' || !/^[1-9]\d{0,9}$/.test(id))) {
        throw new SuwayomiError('INVALID_ARCHIVE_SELECTION', 'Choose a volume or up to 100 chapter IDs.', 400)
      }
      query.set('chapterIds', chapterIds.join(','))
    }
  }
  if (typeof pathname !== 'string') throw new SuwayomiError('INVALID_RESOURCE', 'Choose a valid resource and provide its required ID.', 400)
  let token, target
  try {
    const origin = new URL(url)
    if (!['http:', 'https:'].includes(origin.protocol) || origin.href !== origin.origin + '/') throw Error()
    target = new URL(pathname, origin)
    target.search = query.toString()
    token = (await readFile(tokenFile, 'utf8')).trim()
    if (!/^studio_dsh_[A-Za-z0-9_-]{43}$/.test(token)) throw Error()
  } catch {
    throw new SuwayomiError('STUDIO_READER_CONFIG_ERROR', 'Check the Studio URL and read-token file.', 503)
  }
  try {
    const response = await fetch(target, { headers: { authorization: 'Bearer ' + token },
      redirect: 'error', signal: AbortSignal.timeout(12000) })
    if (!response.ok) {
      await response.body?.cancel()
      throw new SuwayomiError('STUDIO_HTTP_ERROR', `Studio read API returned HTTP ${response.status}.`, response.status)
    }
    return await response.json()
  } catch (error) {
    if (error instanceof SuwayomiError) throw error
    throw new SuwayomiError('STUDIO_UNAVAILABLE', 'Unable to read the Studio API.', 502)
  }
}
