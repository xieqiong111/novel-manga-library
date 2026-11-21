import { constants } from 'node:fs'
import { link, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { MetadataError } from './bangumi-komga.mjs'
import { sameBangumiTitle } from './bangumi-title.mjs'

const mangaIdPattern = /^[1-9]\d{0,9}$/
const mangaBindings = (settingsFile) => path.join(path.dirname(settingsFile), 'bangumi-manga')

export async function readMangaBangumiBinding(settingsFile, mangaId) {
  if (!settingsFile || !mangaIdPattern.test(mangaId)) return null
  try {
    const file = await open(path.join(mangaBindings(settingsFile), mangaId + '.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if ((await file.stat()).size > 4096) throw new Error('Invalid Bangumi binding')
      const record = JSON.parse(await file.readFile('utf8'))
      if (record?.mangaId !== mangaId || !Number.isSafeInteger(record.subjectId) ||
          record.subjectId <= 0 || record.subjectId >= 10 ** 10 || typeof record.title !== 'string' || !record.title.trim()) {
        throw new Error('Invalid Bangumi binding')
      }
      return record
    } finally { await file.close() }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function resolveDownloadSubject(metadata, kind, sourceTitles, id) {
  const { subject } = await metadata('identity', { kind, query: sourceTitles[0], subjectId: id })
  if (!subject) {
    throw new MetadataError(409, 'BANGUMI_SUBJECT_REQUIRED', '请先按作品名查询 Bangumi，确认对应的系列条目后再下载。')
  }
  if (!sourceTitles.some((title) => [subject.title, ...subject.aliases].some((name) => sameBangumiTitle(title, name)))) {
    throw new MetadataError(409, 'BANGUMI_SOURCE_MISMATCH', '下载源的作品名与所选 Bangumi 条目及其别名不符，请核对作品和版本。')
  }
  return { id: subject.id, title: subject.title }
}

// Publish the complete binding before Suwayomi can start downloading the chapter.
export async function bindMangaTitle(settingsFile, manga, subject) {
  if (!settingsFile || !path.isAbsolute(settingsFile)) {
    throw new MetadataError(503, 'BANGUMI_ARCHIVE_SETTINGS_REQUIRED', 'Studio 与归档服务需要共用下载设置目录。')
  }
  const mangaId = String(manga.id)
  if (!mangaIdPattern.test(mangaId)) throw new MetadataError(400, 'INVALID_MANGA_ID', '漫画 ID 无效。')
  const directory = mangaBindings(settingsFile)
  const target = path.join(directory, mangaId + '.json')
  const temporary = path.join(directory, '.' + randomUUID() + '.tmp')
  const record = { mangaId, sourceId: String(manga.sourceId), subjectId: subject.id, title: subject.title }
  try {
    await mkdir(directory, { recursive: true, mode: 0o755 })
    await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o644 })
    try { await link(temporary, target) } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const existing = await readMangaBangumiBinding(settingsFile, mangaId)
    if (Object.keys(record).some((key) => record[key] !== existing?.[key])) {
      throw new MetadataError(409, 'BANGUMI_BINDING_CONFLICT', '这个漫画来源已有其他 Bangumi 命名记录，请先核对绑定。')
    }
  } catch (error) {
    if (error instanceof MetadataError) throw error
    throw new MetadataError(503, 'BANGUMI_BINDING_UNAVAILABLE', '无法保存归档所需的 Bangumi 命名记录。')
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}
