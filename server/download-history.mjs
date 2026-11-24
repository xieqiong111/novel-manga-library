import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import path from 'node:path'

const dshTaskId = /^task_[a-f0-9]{16}$/
const archiveImages = /\.(?:jpe?g|png|webp|gif|avif|bmp|jxl)$/i

export async function readDshTasks(directory) {
  if (!directory || !path.isAbsolute(directory)) return []
  const entries = await readdir(directory, { withFileTypes: true })
  const candidates = entries.filter((entry) =>
    entry.isFile() && dshTaskId.test(path.basename(entry.name, '.json')) && entry.name.endsWith('.json'))
  const readOne = async ({ name }) => {
    try {
      const file = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        if ((await file.stat()).size > 2 * 1024 ** 2) return null
        const task = JSON.parse(await file.readFile('utf8'))
        if (task?.id !== path.basename(name, '.json') || task.state !== 'completed' ||
            typeof task.request?.title !== 'string' || !Number.isFinite(Date.parse(task.updatedAt))) return null
        const names = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
        return {
          id: task.id, state: task.state, updatedAt: task.updatedAt,
          request: { title: task.request.title, bookId: task.request.bookId, volumeNames: names(task.request.volumeNames) },
          progress: task.progress,
          downloadedVolumes: names(task.downloadedVolumes), downloadedChapters: names(task.downloadedChapters),
          artifacts: Array.isArray(task.artifacts) ? task.artifacts.map((entry) => ({ bytes: entry?.bytes })) : [],
        }
      } finally {
        await file.close()
      }
    } catch { return null }
  }
  const results = []
  for (let offset = 0; offset < candidates.length; offset += 32) {
    const batch = await Promise.all(candidates.slice(offset, offset + 32).map(readOne))
    results.push(...batch.filter(Boolean))
  }
  return results
}

async function readBytes(file, length, position) {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await file.read(buffer, 0, length, position)
  return bytesRead === length ? buffer : null
}

// Look at the central directory without reading or decompressing the book data.
async function savedArchive(filePath, type) {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size < 22) return null
    const tail = await readBytes(file, Math.min(info.size, 65557), Math.max(0, info.size - 65557))
    if (!tail) return null
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) !== 0x06054b50 || i + 22 + tail.readUInt16LE(i + 20) !== tail.length) continue
      // No multi-disk archives. The central directory of ordinary EPUBs and CBZs is small.
      if (tail.readUInt32LE(i + 4) !== 0) return null
      const entries = tail.readUInt16LE(i + 10)
      const size = tail.readUInt32LE(i + 12)
      const offset = tail.readUInt32LE(i + 16)
      if (!entries || size > 4 * 1024 ** 2 || offset + size > info.size - tail.length + i) return null
      const central = await readBytes(file, size, offset)
      if (!central) return null
      let images = false, container = false, mime = false
      let cursor = 0
      for (let n = 0; n < entries; n += 1) {
        if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) return null
        const nameLength = central.readUInt16LE(cursor + 28)
        const end = cursor + 46 + nameLength
        if (end > central.length || central.readUInt16LE(cursor + 8) & 1) return null
        const name = central.toString('utf8', cursor + 46, end)
        images ||= archiveImages.test(name) && central.readUInt32LE(cursor + 24) > 0
        container ||= name === 'META-INF/container.xml'
        mime ||= name === 'mimetype'
        cursor = end + central.readUInt16LE(cursor + 30) + central.readUInt16LE(cursor + 32)
      }
      return (type === 'novel' ? container && mime : images) ? info : null
    }
    return null
  } finally {
    await file.close()
  }
}

async function findFiles(root, type, claimed) {
  if (!root || !path.isAbsolute(root)) return []
  const groups = new Map()
  const extension = type === 'novel' ? '.epub' : '.cbz'
  async function walk(relative) {
    const directory = path.join(root, relative)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || /[\\\x00-\x1f]/.test(entry.name)) continue
      const saved = path.join(relative, entry.name)
      if (entry.isDirectory()) await walk(saved)
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== extension || claimed.has(saved)) continue
      const info = await savedArchive(path.join(root, saved), type).catch(() => null)
      if (!info) continue
      const group = relative || saved
      let item = groups.get(group)
      if (!item) {
        item = {
          id: 'file:' + createHash('sha256').update(type + '\0' + group).digest('hex').slice(0, 20), type,
          title: relative ? path.basename(relative) : path.basename(entry.name, path.extname(entry.name)),
          observedAt: 0, files: [],
        }
        groups.set(group, item)
      }
      item.observedAt = Math.max(info.mtimeMs, item.observedAt)
      item.files.push({ path: saved, bytes: info.size })
    }
  }
  await walk('')
  return [...groups.values()].sort((a, b) => b.observedAt - a.observedAt)
}

export function createSavedFileHistory(settings, runtime, logger) {
  let cache
  let expires = 0
  return async function savedFiles() {
    if (!cache || Date.now() >= expires) {
      expires = Date.now() + 60_000
      const indexed = new Set(runtime.library?.archivedPaths() ?? [])
      cache = Promise.allSettled([
        findFiles(settings.config?.novelStorageRoot, 'novel', indexed),
        findFiles(settings.mangaStorageRoot, 'manga', new Set()),
      ]).then((results) => ({
        files: results.flatMap((entry) => entry.status === 'fulfilled' ? entry.value : []),
        errors: results.flatMap((entry, index) => {
          if (entry.status === 'fulfilled') return []
          const type = index === 0 ? '轻小说' : '漫画'
          logger.warn('downloads', 'saved_files_unavailable', { type })
          return [`无法读取${type}保存目录。`]
        }),
      }))
    }
    return cache
  }
}
