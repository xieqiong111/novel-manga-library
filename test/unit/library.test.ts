import { mkdir, symlink, realpath, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Library } from '../../src/core/library.js'
import { createLogger } from '../../src/util/logger.js'
import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'

let dir: string
const logger = createLogger('/tmp/ln-test-logs')
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'ln-lib-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function crc32(buf: Buffer): number {
  let c = ~0
  for (const byte of buf) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
  return ~c >>> 0
}

function makeEpub(text = 'content'): Buffer {
  const names = ['mimetype', 'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/toc.ncx', 'OEBPS/chapter000001.xhtml']
  const contents = [
    Buffer.from('application/epub+zip'),
    Buffer.from('<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
    Buffer.from('<package><manifest><item id="c" href="chapter000001.xhtml" media-type="application/xhtml+xml"/></manifest><spine/></package>'),
    Buffer.from('<ncx/>'),
    Buffer.from(`<html><body><p>${text}</p></body></html>`),
  ]
  const locals: Buffer[] = [], centrals: Buffer[] = []
  let offset = 0
  names.forEach((name, i) => {
    const n = Buffer.from(name), data = contents[i]!
    const store = i === 0
    const payload = store ? data : deflateRawSync(data)
    const crc = crc32(data)
    const l = Buffer.alloc(30)
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(store ? 0 : 8, 8)
    l.writeUInt32LE(crc, 14); l.writeUInt32LE(payload.length, 18); l.writeUInt32LE(data.length, 22)
    l.writeUInt16LE(n.length, 26)
    locals.push(l, n, payload)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6)
    c.writeUInt16LE(store ? 0 : 8, 10); c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(payload.length, 20); c.writeUInt32LE(data.length, 24)
    c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42)
    centrals.push(c, n)
    offset += l.length + n.length + payload.length
  })
  const central = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(names.length, 8)
  eocd.writeUInt16LE(names.length, 10); eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, eocd])
}

async function seedEpub(): Promise<string> {
  const work = path.join(dir, 'work')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(work, { recursive: true })
  const p = path.join(work, 'novel.epub')
  await writeFile(p, makeEpub())
  return p
}

describe('Library (requirement #9)', () => {
  it('saves new files under the official Bangumi name and protects other editions', async () => {
    const lib = new Library(dir, logger)
    const source = await seedEpub()
    const input = {
      artifact: { path: source, volumeNames: ['第一卷'], chapters: 1, bytes: 0, sha256: null, integrity: 'pending' as const, integrityError: null },
      title: '源网站标题', bangumi: { id: 123, title: '正式书名 ～副标题～' },
      author: '测试作者', sourceId: 'fixture', bookId: 'fixture:one', taskId: 'task_1',
    }
    const entry = (await lib.add(input))!
    expect(entry.relativePath).toBe('正式书名 ～副标题～/第一卷.epub')
    await expect(lib.add({ ...input, bookId: 'fixture:other' })).rejects.toThrow('BANGUMI_FOLDER_CONFLICT')
    expect((await lib.verify(entry.id))[0]?.ok).toBe(true)
  })

  it('copies a verified EPUB, writes a sha256 sidecar and persists a portable index', async () => {
    const lib = new Library(dir, logger)
    await lib.load()
    const source = await seedEpub()
    const entry = await lib.add({
      artifact: { path: source, volumeNames: ['第一卷 启程'], chapters: 1, bytes: 0, sha256: null, integrity: 'pending', integrityError: null },
      title: '星海/旅途', author: '测试作者', sourceId: 'fixture', bookId: 'fixture:one', taskId: 'task_1',
    })
    expect(entry).not.toBeNull()
    expect(entry!.integrity).toBe('ok')
    expect(entry!.relativePath).not.toMatch(/^\//)
    expect(entry!.relativePath).not.toContain('..')
    const copied = path.join(dir, entry!.relativePath)
    expect((await stat(copied)).size).toBeGreaterThan(0)
    const checksum = await readFile(`${copied}.sha256`, 'utf8')
    expect(checksum).toContain(entry!.sha256)
    expect(checksum).toHaveLength(createHash('sha256').digest('hex').length + 2 + path.basename(copied).length + 1)

    // Index is reloadable and paths stay relative.
    const reloaded = new Library(dir, logger)
    await reloaded.load()
    expect(reloaded.get(entry!.id)!.title).toBe('星海/旅途')
    expect(reloaded.stats().total).toBe(1)
  })

  it('protects an unbound EPUB from simultaneous downloads of a homonymous edition', async () => {
    const source = await seedEpub()
    const library = new Library(dir, logger)
    const input = {
      artifact: { path: source, volumeNames: ['第一卷'], chapters: 1, bytes: 0, sha256: null, integrity: 'pending' as const, integrityError: null },
      title: '同名作品', author: '作者', sourceId: 'fixture', bookId: 'one', taskId: 'task_1',
    }
    const [first, conflict] = await Promise.allSettled([
      library.add(input),
      library.add({ ...input, sourceId: 'other', bookId: 'two', taskId: 'task_2' }),
    ])
    expect(first.status).toBe('fulfilled')
    expect(conflict).toMatchObject({ status: 'rejected', reason: { message: expect.stringContaining('LIBRARY_FOLDER_CONFLICT') } })
    expect(await readFile(path.join(dir, '同名作品', '第一卷.epub'))).toEqual(await readFile(source))
    await expect(library.add({ ...input, language: 'ja' })).rejects.toThrow('LIBRARY_FOLDER_CONFLICT')
    await expect(library.add({ ...input, artifact: { ...input.artifact, volumeNames: ['第一卷', '第二卷'] } }))
      .rejects.toThrow('LIBRARY_FOLDER_CONFLICT')
  })

  it('reconciles files and the index after the index write fails', async () => {
    const source = await seedEpub()
    const library = new Library(dir, logger)
    await library.load()
    const index = path.join(dir, 'index.json')
    await mkdir(index)
    const input = {
      artifact: { path: source, volumeNames: ['第一卷'], chapters: 1, bytes: 0, sha256: null, integrity: 'pending' as const, integrityError: null },
      title: '可恢复入库', author: '作者', sourceId: 'fixture', bookId: 'one', taskId: 'task_1',
    }
    await expect(library.add(input)).rejects.toThrow()
    expect(library.stats().total).toBe(0)
    const journal = path.join(dir, '.pending-epub-import.json')
    expect(JSON.parse(await readFile(journal, 'utf8')).entry.taskId).toBe('task_1')
    expect(await readFile(path.join(dir, '可恢复入库', '第一卷.epub'))).toEqual(await readFile(source))
    await rm(index, { recursive: true })
    const recovered = new Library(dir, logger)
    await recovered.load()
    expect(recovered.forTask('task_1')).toHaveLength(1)
    await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' })
    await recovered.add(input)
    expect(recovered.stats().total).toBe(1)
  })

  it('finishes an explicitly requested deletion after a crash between unlink and index update', async () => {
    const source = await seedEpub()
    const library = new Library(dir, logger)
    const entry = (await library.add({
      artifact: { path: source, volumeNames: ['第一卷'], chapters: 1, bytes: 0, sha256: null, integrity: 'pending', integrityError: null },
      title: '删除测试', author: '作者', sourceId: 'fixture', bookId: 'fixture:delete', taskId: 'task_1',
    }))!
    await writeFile(path.join(dir, '.pending-epub-removal.json'), JSON.stringify({
      version: 1, entry, observedSha256: entry.sha256,
    }))
    await rm(path.join(dir, entry.relativePath))
    const recovered = new Library(dir, logger)
    await recovered.load()
    expect(recovered.stats().total).toBe(0)
    await expect(readFile(path.join(dir, '.pending-epub-removal.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses the chosen EPUB directory and keeps old entries readable across changes', async () => {
    const source = await seedEpub()
    const root = path.join(dir, 'storage')
    const settingsFile = path.join(dir, 'folders.json')
    await mkdir(path.join(root, '小说'), { recursive: true })
    const storage = { root, settingsFile }
    const lib = new Library(dir, logger, storage)
    const input = {
      artifact: { path: source, volumeNames: ['第一卷'], chapters: 1, bytes: 0, sha256: null, integrity: 'pending' as const, integrityError: null },
      title: '星海旅途', author: '测试作者', sourceId: 'fixture', bookId: 'fixture:one', taskId: 'task_1',
    }
    const original = (await lib.add(input))!
    await writeFile(settingsFile, JSON.stringify({ novelFolder: '小说', mangaFolder: '', mangaPrevious: [] }))
    const redirected = (await lib.add(input))!
    const reloaded = new Library(dir, logger, storage)
    await reloaded.load()
    expect(reloaded.stats().total).toBe(2)
    expect(await reloaded.filePath(original)).toBe(path.join(dir, original.relativePath))
    expect(await reloaded.filePath(redirected)).toBe(path.join(await realpath(root), '小说', redirected.relativePath))
    expect((await reloaded.verify()).every((item) => item.ok)).toBe(true)
    await symlink(dir, path.join(root, 'link'))
    await writeFile(settingsFile, JSON.stringify({ novelFolder: 'link', mangaFolder: '', mangaPrevious: [] }))
    await expect(reloaded.add(input)).rejects.toThrow('must be a directory')
  })

  it('list / get / stats / checksums / remove', async () => {
    const lib = new Library(dir, logger)
    await lib.load()
    const source = await seedEpub()
    const entry = await lib.add({
      artifact: { path: source, volumeNames: ['第二卷'], chapters: 1, bytes: 0, sha256: null, integrity: 'pending', integrityError: null },
      title: '月下茶馆', author: '林小满', sourceId: 'fixture', bookId: 'fixture:two', taskId: 'task_2',
    })
    expect(lib.list({ query: '茶馆' })).toHaveLength(1)
    expect(lib.list({ query: '不存在' })).toHaveLength(0)
    expect(lib.get(entry!.id)!.integrity).toBe('ok')
    expect(lib.stats().ok).toBe(1)
    expect(await lib.readChecksums()).toHaveLength(1)
    expect((await lib.verify(entry!.id))[0]!.ok).toBe(true)
    expect(await lib.remove(entry!.id)).toBe(true)
    expect(lib.stats().total).toBe(0)
    expect(await lib.remove(entry!.id)).toBe(false)
  })

  it('re-downloading the same volume replaces its index entry instead of duplicating it', async () => {
    const lib = new Library(dir, logger)
    await lib.load()
    const source = await seedEpub()
    const input = {
      artifact: { path: source, volumeNames: ['卷一'], chapters: 1, bytes: 0, sha256: null, integrity: 'pending' as const, integrityError: null },
      title: '书', author: '作者', sourceId: 'fixture', bookId: 'fixture:3', taskId: 'task_3',
    }
    const first = await lib.add(input)
    await writeFile(source, makeEpub('revised edition'))
    const second = await lib.add({ ...input, taskId: 'task_4' })

    expect(second!.relativePath).toBe(first!.relativePath)
    expect(second!.sha256).not.toBe(first!.sha256)
    expect(lib.stats().total).toBe(1)
    expect((await lib.verify())[0]!.ok).toBe(true)

    const reloaded = new Library(dir, logger)
    await reloaded.load()
    expect(reloaded.stats().total).toBe(1)
    expect(reloaded.get(second!.id)!.sha256).toBe(second!.sha256)
  })

  it('heals a legacy index that contains duplicate entries for one EPUB path', async () => {
    const lib = new Library(dir, logger)
    await lib.load()
    const source = await seedEpub()
    const first = await lib.add({
      artifact: { path: source, volumeNames: ['卷一'], chapters: 1, bytes: 0, sha256: null, integrity: 'pending', integrityError: null },
      title: '书', author: '作者', sourceId: 'fixture', bookId: 'fixture:3', taskId: 'task_3',
    })
    // Simulate the pre-fix index: an older entry pointing at the same file,
    // but carrying the sha256 of a version that has since been overwritten.
    const current = await readFile(path.join(dir, 'index.json'), 'utf8')
    const file = JSON.parse(current) as { version: number; entries: Record<string, unknown>[] }
    file.entries.unshift({
      ...file.entries[0]!,
      id: 'lib_stale0000000001',
      sha256: 'a'.repeat(64),
      createdAt: '2020-01-01T00:00:00.000Z',
    })
    await writeFile(path.join(dir, 'index.json'), `${JSON.stringify(file, null, 2)}\n`)

    const reloaded = new Library(dir, logger)
    await reloaded.load()
    expect(reloaded.stats().total).toBe(1)
    expect(reloaded.get(first!.id)).toBeDefined()
    expect((await reloaded.verify())[0]!.ok).toBe(true)
  })

  it('verify() detects a mutated file via sha256 change', async () => {
    const lib = new Library(dir, logger)
    await lib.load()
    const source = await seedEpub()
    const entry = await lib.add({
      artifact: { path: source, volumeNames: ['卷一'], chapters: 1, bytes: 0, sha256: null, integrity: 'pending', integrityError: null },
      title: '书', author: '作者', sourceId: 'fixture', bookId: 'fixture:3', taskId: 'task_3',
    })
    await writeFile(path.join(dir, entry!.relativePath), Buffer.from('corrupted'))
    const [result] = await lib.verify(entry!.id)
    expect(result!.ok).toBe(false)
    expect(result!.sha256Changed).toBe(true)
    expect(lib.get(entry!.id)!.integrity).toBe('failed')
  })
})
