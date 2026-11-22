import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteJson } from '../dist/util/json.js'
import { MetadataError } from './bangumi-komga.mjs'
import { readDownloadFolders } from '../dist/core/download-folders.js'

export const volumeSources = ['publisher', 'reference', 'opentome']
const mangaIdPattern = /^[1-9]\d{0,9}$/
const chapterPattern = /^\d{1,4}(?:\.\d{1,4})?$/

const konosuba = {
  subjectId: 143035,
  sourceId: '774030471139699415',
  work: 'https://baozimh.org/manga/weimeihaodeshijiexianshangzhufu-xiaonatumetuntamazi',
  ends: [5, 12, 18, 24, 30, 36, 42, 48, 54, 59, 66, 73, 79, 85, 92, 98, 104, 110, 116, 122, 128, 134, 140],
  publisher: {
    1: 'https://yenpress.com/titles/9780316552561-konosuba-god-s-blessing-on-this-wonderful-world-vol-1-manga',
    3: 'https://yenpress.com/titles/9780316469333-konosuba-god-s-blessing-on-this-wonderful-world-vol-3-manga',
    21: 'https://yenpress.com/titles/9798855433692-konosuba-god-s-blessing-on-this-wonderful-world-vol-21-manga',
  },
}
const italian = 'https://it.wikipedia.org/wiki/Capitoli_di_Konosuba!_-_This_Wonderful_World'
const fandom = 'https://konosuba.fandom.com/wiki/Category:Konosuba_Chapters'

export function mangaVolumePreferences(input) {
  const sources = input?.sources
  return {
    enabled: input?.enabled === true,
    sources: Array.isArray(sources) ? volumeSources.filter((source) => sources.includes(source)) : volumeSources,
  }
}

export function canonicalWorkUrl(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return ''
    return url.origin + url.pathname.replace(/\/$/, '')
  } catch { return '' }
}

function isKonosuba(manga, binding) {
  return binding?.subjectId === konosuba.subjectId && String(manga.sourceId) === konosuba.sourceId &&
    canonicalWorkUrl(manga.url).replace(/^http:/, 'https:') === konosuba.work
}

export function publishedMangaVolumes(manga, binding, sources) {
  if (!isKonosuba(manga, binding)) return []
  return konosuba.ends.flatMap((last, i) => {
    const number = i + 1
    const publisher = sources.includes('publisher') && konosuba.publisher[number]
    if (!publisher && !sources.includes('reference')) return []
    const first = (konosuba.ends[i - 1] ?? 0) + 1
    return [{
      number,
      chapters: Array.from({ length: last - first + 1 }, (_, step) => String(first + step)),
      source: publisher ? 'publisher' : 'reference',
      url: publisher || (number <= 20 ? italian : fandom),
      confirmed: Boolean(publisher) || number <= 20,
    }]
  })
}

export function volumeCatalogPath(settingsFile, mangaId) {
  if (!settingsFile || !mangaIdPattern.test(String(mangaId))) throw new Error('Invalid volume catalog location')
  return path.join(path.dirname(settingsFile), 'manga-volume-catalogs', mangaId + '.json')
}

export async function readVolumeCatalog(settingsFile, mangaId) {
  if (!settingsFile) return null
  try {
    const file = await open(volumeCatalogPath(settingsFile, mangaId), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if ((await file.stat()).size > 256_000) throw new Error('Manga volume catalog is too large')
      return JSON.parse(await file.readFile('utf8'))
    } finally { await file.close() }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export function chapterList(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 250) return []
  const chapters = values.map(String)
  if (chapters.some((chapter) => !chapterPattern.test(chapter))) return []
  return [...new Set(chapters.map((chapter) => String(Number(chapter))))]
}

export function mergeVolumeSources(rows, sources) {
  const byVolume = new Map()
  const belongsTo = new Map()
  const conflicted = new Set()
  for (const row of rows) {
    if (!sources.includes(row.source)) continue
    const current = byVolume.get(row.number)
    if (!current || (row.confirmed && !current.confirmed)) {
      byVolume.set(row.number, row)
    } else if (row.confirmed && current.confirmed && (row.chapters.length !== current.chapters.length ||
      !row.chapters.every((chapter) => current.chapters.includes(chapter)))) {
      conflicted.add(row.number)
    }
  }
  for (const row of byVolume.values()) {
    if (!row.confirmed) continue
    for (const chapter of row.chapters) {
      const other = belongsTo.get(chapter)
      if (other && other !== row.number) {
        conflicted.add(other)
        conflicted.add(row.number)
      }
      belongsTo.set(chapter, row.number)
    }
  }
  return [...byVolume.values()].sort((a, b) => a.number - b.number).map((row) =>
    conflicted.has(row.number) ? { ...row, confirmed: false, conflict: true } : row)
}

export async function saveMangaVolumeCatalog(settingsFile, manga, binding, extra = [], volumeMetadata = [], expected = undefined) {
  const preferences = mangaVolumePreferences((await readDownloadFolders(settingsFile)).mangaArchive)
  const sourceId = String(manga.sourceId), mangaId = String(manga.id), url = canonicalWorkUrl(manga.url)
  const inFile = await readVolumeCatalog(settingsFile, mangaId)
  if (expected !== undefined && JSON.stringify(expected) !== JSON.stringify(inFile)) throw new MetadataError(409, 'VOLUME_CATALOG_CHANGED', '卷目录已更新，请重新读取后再提交。')
  const same = inFile?.subjectId === binding.subjectId && inFile.sourceId === sourceId && inFile.workUrl === url
  const previous = same ? inFile : null
  const additions = [...(previous?.additions ?? []).filter((item) =>
    !extra.some((row) => row.source === item.source && row.number === item.number)), ...extra]
  const editions = new Map((previous?.volumeMetadata ?? []).map((row) => [row.number, row]))
  for (const row of volumeMetadata) {
    const previousEdition = editions.get(row.number)
    editions.set(row.number, previousEdition?.subjectId === row.subjectId ? { ...previousEdition, ...row } : row)
  }
  const volumes = mergeVolumeSources([...publishedMangaVolumes(manga, binding, volumeSources), ...additions], preferences.sources)
  const record = { mangaId, sourceId, subjectId: binding.subjectId, workUrl: url, additions, volumeMetadata: [...editions.values()], volumes }
  if (JSON.stringify(record) !== JSON.stringify(inFile)) await atomicWriteJson(volumeCatalogPath(settingsFile, mangaId), record)
  return record
}
