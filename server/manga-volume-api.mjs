import { readDownloadFolders } from '../dist/core/download-folders.js'
import { chineseMangaSummary, mangaVolumeSynopsis, MetadataError } from './bangumi-komga.mjs'
import { bindMangaTitle, readMangaBangumiBinding, resolveDownloadSubject } from './bangumi-download.mjs'
import { sameBangumiTitle } from './bangumi-title.mjs'
import { bangumiCoverUrl } from './bangumi-cover.mjs'
import { mangaVolumePreferences, publishedMangaVolumes, readVolumeCatalog, saveMangaVolumeCatalog } from './manga-volume-catalog.mjs'
import { findPublisherVolumes, readPublisherVolume } from './manga-publisher.mjs'
import { openTomeVolumes } from './opentome-volumes.mjs'

function volumeNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 9999) throw new MetadataError(400, 'INVALID_MANGA_VOLUME', '请输入有效的单行本卷号。')
  return value
}

function relatedVolumes(data) {
  if (!Array.isArray(data?.volumes) || data.volumes.length > 500) {
    throw new MetadataError(502, 'INVALID_VOLUME_RELATIONS', 'Bangumi 未返回有效的单行本关联。')
  }
  const volumes = new Map()
  const conflict = new Set()
  for (const row of data.volumes) {
    const match = /(?:\(|（|第)([1-9]\d{0,3})(?:\)|）|巻|卷)$/u.exec(String(row.name ?? '').normalize('NFKC'))
    if (!match || !Number.isSafeInteger(row.id) || row.id <= 0) continue
    const number = Number(match[1])
    if (volumes.has(number) && volumes.get(number).subjectId !== row.id) conflict.add(number)
    volumes.set(number, { number, subjectId: row.id })
  }
  return [...volumes.values()].filter((row) => !conflict.has(row.number))
}

function publisherTitle(value) {
  return value.trim().replace(/\s*[,，]?\s*Vol(?:ume)?\.?\s*(\d+)\s*\(manga\)\s*$/i, '').trim()
}

function isbnOf(value) {
  return typeof value === 'string' ? value.replace(/[^0-9]/g, '') : ''
}

async function matchedCatalog(file, mangaId) {
  const [record, binding] = await Promise.all([readVolumeCatalog(file, mangaId), readMangaBangumiBinding(file, mangaId)])
  return record && binding && record.subjectId === binding.subjectId && record.sourceId === binding.sourceId &&
    record.mangaId === mangaId ? { record, binding } : null
}

export async function readMangaVolumeSynopsis(file, mangaId, subjectId) {
  const matched = await matchedCatalog(file, mangaId)
  return matched?.record.volumeMetadata?.find((row) => row.subjectId === subjectId)?.localizedSynopsis
}

export function createMangaVolumeCatalogApi({ settings, mangaClient, metadata, fetchImpl = fetch }) {
  const file = settings.config?.downloadFoldersFile
  const pending = new Map()
  const preferences = async () => mangaVolumePreferences((await readDownloadFolders(file)).mangaArchive)

  function serialize(id, operation) {
    const task = (pending.get(id) ?? Promise.resolve()).catch(() => {}).then(operation)
    pending.set(id, task)
    return task.finally(() => { if (pending.get(id) === task) pending.delete(id) })
  }

  const related = async (subjectId, connection) =>
    relatedVolumes(await metadata('related-volumes', { subjectId }, undefined, connection))

  async function prepare(manga, binding) {
    if (!file || !(await preferences()).enabled) return
    return serialize(String(manga.id), async () => {
      const result = await saveMangaVolumeCatalog(file, manga, binding)
      if (!process.env.LN_OPENTOME_SQLITE || !(await preferences()).sources.includes('opentome') ||
          result.volumes.some((row) => row.confirmed)) return result
      try {
        const rows = await related(binding.subjectId)
        const first = rows.find((row) => row.number === 1)
        if (!first) return result
        const detail = await metadata('volume-detail', { subjectId: first.subjectId })
        const isbn = isbnOf(detail?.isbn)
        if (!/^\d{13}$/.test(isbn)) return result
        const lookup = openTomeVolumes(process.env.LN_OPENTOME_SQLITE, isbn, 1)
        return await saveMangaVolumeCatalog(file, manga, binding, lookup.volumes, rows)
      } catch (error) {
        if (error instanceof MetadataError) return result
        throw error
      }
    })
  }

  async function get(mangaId) {
    const [config, record] = await Promise.all([preferences(), readVolumeCatalog(file, mangaId)])
    return { enabled: config.enabled, sources: config.sources, openTomeConfigured: Boolean(process.env.LN_OPENTOME_SQLITE),
      bound: Boolean(record), volumes: (record?.volumes ?? []).filter((entry) => config.sources.includes(entry.source)),
      volumeMetadata: record?.volumeMetadata ?? [] }
  }

  async function edition(mangaId, number, cover = false) {
    const matched = await matchedCatalog(file, mangaId)
    const row = matched?.record.volumeMetadata?.find((entry) => entry.number === number)
    if (!row) {
      throw new MetadataError(404, 'VOLUME_METADATA_UNMATCHED', '这一卷尚未匹配 Bangumi 单行本。')
    }
    if (cover) return metadata('volume-cover', { subjectId: row.subjectId })
    const detail = await metadata('volume-detail', { subjectId: row.subjectId, includeCover: true })
    if (detail?.subject?.id !== row.subjectId) throw new MetadataError(502, 'INVALID_METADATA_RESPONSE', 'Bangumi 返回的单行本条目不符。')
    const string = (value, max = 300) => typeof value === 'string' ? value.trim().slice(0, max) : ''
    const chinese = (value, max) => {
      const text = string(value, max)
      return /\p{Script=Han}/u.test(text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) ? text : ''
    }
    let synopsis = mangaVolumeSynopsis(detail, row.localizedSynopsis)
    if (!synopsis.summary) synopsis = mangaVolumeSynopsis(detail, null,
      chineseMangaSummary(await mangaClient.getManga(mangaId).catch(() => null)))
    return { number, subjectId: row.subjectId, title: chinese(detail.subject.nameCn) || `${matched.binding.title} · 第 ${number} 卷`,
      isbn: isbnOf(detail.isbn) || row.isbn || null, date: string(detail.subject.date, 20) || row.date || null,
      ...synopsis, hasCover: Boolean(bangumiCoverUrl(detail.coverUrl)) }
  }

  async function update(mangaId, body) {
    if (!file) throw new MetadataError(503, 'MANGA_VOLUME_SETTINGS_REQUIRED', '未配置共享下载设置目录。')
    const config = await preferences()
    const action = body.action ?? 'resolve'
    if (!['resolve', 'opentome', 'search-publisher', 'verify-publisher'].includes(action)) {
      throw new MetadataError(400, 'INVALID_VOLUME_ACTION', '卷目录操作无效。')
    }
    const source = action === 'opentome' ? 'opentome' : action === 'resolve' ? null : 'publisher'
    if (source && !config.sources.includes(source)) throw new MetadataError(403, 'VOLUME_SOURCE_DISABLED', '该卷目录来源已在设置中关闭。')
    if (pending.size >= 8) throw new MetadataError(429, 'VOLUME_CATALOG_BUSY', '卷目录查询繁忙，请稍后重试。')
    return serialize(mangaId, async () => {
      const manga = await mangaClient.getManga(mangaId)
      let binding = await readMangaBangumiBinding(file, mangaId)
      if (!binding || (body.bangumiSubjectId !== undefined && body.bangumiSubjectId !== binding.subjectId)) {
        const subject = await resolveDownloadSubject(metadata, 'manga', [manga.title], body.bangumiSubjectId, body.sourceTitle)
        await bindMangaTitle(file, manga, subject)
        binding = await readMangaBangumiBinding(file, mangaId)
      }
      if (!binding || binding.sourceId !== String(manga.sourceId)) {
        throw new MetadataError(409, 'BANGUMI_SOURCE_MISMATCH', '卷目录与当前漫画版本不符。')
      }
      const existing = await readVolumeCatalog(file, mangaId)
      if (action === 'resolve') {
        await saveMangaVolumeCatalog(file, manga, binding, [], await related(binding.subjectId))
        return get(mangaId)
      }
      const number = volumeNumber(body.volume)
      const relation = (await related(binding.subjectId)).find((row) => row.number === number)
      const detail = relation ? await metadata('volume-detail', { subjectId: relation.subjectId }) : null
      const isbn = isbnOf(detail?.isbn)
      const edition = relation ? [{ ...relation, isbn: isbn || null, date: detail?.subject?.date ?? null }] : []
      if (action === 'opentome') {
        if (!/^\d{13}$/.test(isbn)) throw new MetadataError(409, 'VOLUME_ISBN_REQUIRED', 'Bangumi 此卷缺少 ISBN，无法核对 OpenTomeDB 版本。')
        const result = openTomeVolumes(process.env.LN_OPENTOME_SQLITE, isbn, number)
        await saveMangaVolumeCatalog(file, manga, binding, result.volumes, edition, existing)
        return { ...await get(mangaId), openTomeLine: result.line }
      }
      if (action === 'search-publisher') {
        const identity = await metadata('identity', { kind: 'manga', subjectId: binding.subjectId, query: manga.title })
        const title = detail?.subject?.name?.replace(/\s*[(（]\d+[)）]$/, '') || manga.title
        const aliases = [manga.title, ...(identity?.subject?.aliases ?? [])]
        if (publishedMangaVolumes(manga, binding, ['reference']).length) aliases.unshift('Konosuba')
        const results = await findPublisherVolumes(title, isbn, { aliases, volume: number, fetchImpl })
        const known = publishedMangaVolumes(manga, binding, ['publisher']).find((row) => row.number === number)
        if (known) results.unshift({ search: known.url, candidates: [{ title: manga.title + ' · 第 ' + number + ' 卷', url: known.url }] })
        return { status: 'candidates', volume: number, isbn: isbn || null, results }
      }
      if (typeof body.publisherUrl !== 'string' || body.publisherUrl.length > 512) {
        throw new MetadataError(400, 'INVALID_PUBLISHER_PAGE', '请提供出版社单行本页面。')
      }
      const page = await readPublisherVolume(body.publisherUrl, fetchImpl)
      const pinned = publishedMangaVolumes(manga, binding, ['publisher']).some((row) => row.number === number && row.url === page.url)
      const candidate = /Vol(?:ume)?\.?\s*(\d+)\s*\(manga\)\s*$/i.exec(page.title)
      const identity = candidate && Number(candidate[1]) === number && !pinned
        ? await metadata('identity', { kind: 'manga', subjectId: binding.subjectId, query: manga.title }) : null
      const titleConfirmed = identity?.subject?.id === binding.subjectId &&
        [identity.subject.title, ...identity.subject.aliases].some((title) => sameBangumiTitle(title, publisherTitle(page.title)))
      if (!pinned && !titleConfirmed && (!isbn || isbn !== page.isbn)) {
        throw new MetadataError(409, 'PUBLISHER_EDITION_UNCONFIRMED', '官网页面与同卷 ISBN、漫画标题或已确认版本未匹配。')
      }
      if (!page.chapters.length) return { status: 'no-publisher-contents', volume: number, candidate: page }
      await saveMangaVolumeCatalog(file, manga, binding, [{
        number, chapters: page.chapters, source: 'publisher', url: page.url, confirmed: true,
      }], edition, existing)
      const catalog = await get(mangaId)
      const matched = catalog.volumes.find((row) => row.number === number)
      return { status: matched?.confirmed ? 'confirmed' : 'conflict', ...catalog }
    })
  }

  async function volumeSubject(mangaId, binding, number, connection) {
    const record = await readVolumeCatalog(file, mangaId)
    if (record?.subjectId === binding.subjectId && record.sourceId === binding.sourceId) {
      const cached = record.volumeMetadata?.find((row) => row.number === number)
      if (cached) return cached.subjectId
    }
    return (await related(binding.subjectId, connection)).find((row) => row.number === number)?.subjectId ?? null
  }

  async function rememberVolume(mangaId, binding, number, result) {
    return serialize(mangaId, async () => {
      const manga = await mangaClient.getManga(mangaId)
      await saveMangaVolumeCatalog(file, manga, binding, [], [{
        number, subjectId: result.subjectId, isbn: result.isbn, date: result.date, summary: result.summary,
      }])
    })
  }

  return { get, edition, update, prepare, volumeSubject, rememberVolume, isEnabled: async () => (await preferences()).enabled }
}
