import { MetadataError } from './bangumi-komga.mjs'
import { sameBangumiTitle } from './bangumi-title.mjs'

export const maxSourceListingBytes = 512 * 1024

function invalidListing() {
  return new MetadataError(400, 'INVALID_SOURCE_LISTING', '请选择有效的 Manga Downloader 章节目录 JSON 文件。')
}

export function sourceListingWorkUrl(value) {
  if (typeof value !== 'string' || value.length > 1024) return null
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null
    url.hash = ''
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.href
  } catch { return null }
}

const label = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
const validChapter = (row) => row && label(row.title, 512) &&
  Number.isFinite(row.number) && /^(?:0|[1-9]\d{0,3})(?:\.\d{1,4})?$/.test(String(row.number)) &&
  (row.volume === undefined || (Number.isSafeInteger(row.volume) && row.volume > 0 && row.volume <= 9999)) &&
  (row.id === undefined || label(row.id, 256)) && (row.language === undefined || label(row.language, 48)) &&
  (row.group === undefined || label(row.group, 256)) &&
  (row.unnumbered === undefined || typeof row.unnumbered === 'boolean') &&
  (row.locked === undefined || typeof row.locked === 'boolean')

// This consumes the published CLI JSON format as evidence. Neither the URL nor its contents are fetched here.
export function auditMangaSourceListing(manga, { sourceUrl, listing } = {}, verified = []) {
  const url = sourceListingWorkUrl(sourceUrl)
  if (String(manga.sourceId) === '0' || !url || url !== sourceListingWorkUrl(manga.url)) {
    throw new MetadataError(409, 'VOLUME_SOURCE_MISMATCH', '导出的作品地址与当前漫画源不一致，请重新核对版本。')
  }
  if (!listing || typeof listing !== 'object' || Array.isArray(listing) || !label(listing.title, 300) ||
      !listing.title.trim() || !label(listing.grabber, 80) || !listing.grabber.trim() ||
      !Array.isArray(listing.chapters) || listing.chapters.length > 5000 || !listing.chapters.every(validChapter)) {
    throw invalidListing()
  }
  if (!sameBangumiTitle(listing.title, manga.title)) {
    throw new MetadataError(409, 'VOLUME_SOURCE_TITLE_MISMATCH', '导出目录的作品名与 Suwayomi 当前条目不一致。')
  }

  const confirmed = new Map(verified.filter((entry) => entry.confirmed === true).map((entry) => [entry.number, entry.chapters]))
  const groups = new Map()
  const appearances = new Map()
  let unassigned = 0
  for (const row of listing.chapters) {
    const number = row.unnumbered ? null : String(row.number)
    if (number !== null) appearances.set(number, (appearances.get(number) ?? 0) + 1)
    if (!row.volume) { unassigned += 1; continue }
    const releases = groups.get(row.volume) ?? []
    releases.push({ number, id: row.id ?? null, name: row.title, language: row.language ?? '',
      group: row.group ?? '', locked: Boolean(row.locked) })
    groups.set(row.volume, releases)
  }
  const volumes = Array.from(groups, ([number, releases]) => {
    const chapters = new Set(releases.flatMap((row) => row.number === null ? [] : [row.number]))
    const ambiguous = releases.some((row) => row.number === null || appearances.get(row.number) > 1)
    const expected = confirmed.get(number)
    const missing = expected?.filter((chapter) => !chapters.has(chapter)) ?? []
    const extra = expected ? [...chapters].filter((chapter) => !expected.includes(chapter)) : []
    const comparison = ambiguous ? 'ambiguous' : !expected ? 'unverified' : missing.length || extra.length ? 'differs' : 'matches'
    return { number, comparison, missing, extra, releases }
  }).sort((a, b) => a.number - b.number)
  return { sourceUrl: url, sourceId: String(manga.sourceId), title: listing.title, grabber: listing.grabber, unassigned, volumes }
}
