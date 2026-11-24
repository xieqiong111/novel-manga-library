import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, open, readdir, rename, realpath, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { folderWithin, readDownloadFolders } from './download-folders.js'
import { verifyEpub } from './integrity.js'
import { paginate } from './pagination.js'
import type { DownloadRequest, LibraryEntry, LibraryIndexFile, TaskArtifact } from '../types.js'
import { atomicWriteJson, atomicWriteText, syncDirectory } from '../util/json.js'
import { assertSafeRelative, bangumiFolderName, safeResolve, sanitizeFileName } from '../util/paths.js'
import type { Logger } from '../util/logger.js'

interface EditionIdentity {
  sourceId: string
  bookId: string
  bangumiSubjectId?: number
  language?: string
  editionId?: string
}

interface ImportJournal {
  version: 1
  entry: LibraryEntry
  previousSha256: string | null
}

interface RemovalJournal {
  version: 1
  entry: LibraryEntry
  observedSha256: string | null
}

type ImportInput = Pick<DownloadRequest, 'title' | 'author' | 'sourceId' | 'bookId' | 'bangumi' | 'language' | 'editionId'> & {
  artifact: TaskArtifact
  taskId: string
  signal?: AbortSignal
}

function sameEdition(left: EditionIdentity, right: EditionIdentity): boolean {
  return left.sourceId === right.sourceId && left.bookId === right.bookId &&
    left.bangumiSubjectId === right.bangumiSubjectId && left.language === right.language && left.editionId === right.editionId
}

function locationKey(entry: Pick<LibraryEntry, 'storageFolder' | 'relativePath'>): string {
  return JSON.stringify([entry.storageFolder ?? null, entry.relativePath])
}

class LibraryConflict extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
  }
}

async function optionalJson<T>(file: string): Promise<T | undefined> {
  const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  return text === undefined ? undefined : JSON.parse(text) as T
}

async function fileInfo(file: string) {
  return lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
}

async function fileHash(file: string): Promise<string | null> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!handle) return null
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Expected a regular novel archive file')
    const hash = createHash('sha256')
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes)
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/** On-disk EPUB library with integrity verification and a portable index. */
export class Library {
  private entries = new Map<string, LibraryEntry>()
  private legacyConflicts = new Map<string, LibraryEntry[]>()
  private loading?: Promise<void>
  private mutations: Promise<unknown> = Promise.resolve()

  constructor(private readonly libraryDir: string, private readonly logger: Logger,
    private readonly storage?: { root: string; settingsFile: string }) {}

  private async root(folder: string | undefined): Promise<string> {
    if (folder === undefined) return this.libraryDir
    if (!this.storage?.root) throw new Error('Novel storage mount is unavailable')
    return folderWithin(this.storage.root, folder)
  }

  async filePath(entry: LibraryEntry): Promise<string> {
    const root = await this.root(entry.storageFolder)
    const file = safeResolve(root, assertSafeRelative(entry.relativePath))
    if (await realpath(file) !== safeResolve(await realpath(root), entry.relativePath)) {
      throw new Error('Novel archive contains a symbolic link')
    }
    return file
  }

  private get indexPath(): string {
    return safeResolve(this.libraryDir, 'index.json')
  }

  private get journalPath(): string {
    return safeResolve(this.libraryDir, '.pending-epub-import.json')
  }

  private get removalPath(): string {
    return safeResolve(this.libraryDir, '.pending-epub-removal.json')
  }

  load(): Promise<void> {
    this.loading ??= this.loadIndex().catch((error) => {
      this.loading = undefined
      throw error
    })
    return this.loading
  }

  private async loadIndex(): Promise<void> {
    const file = await optionalJson<LibraryIndexFile>(this.indexPath)
    if (file !== undefined && (file?.version !== 1 || !Array.isArray(file.entries))) throw new Error('Unsupported library index')
    const byPath = new Map<string, LibraryEntry>()
    const conflicts = new Map<string, LibraryEntry[]>()
    for (const entry of file?.entries ?? []) {
      if (!entry || typeof entry.id !== 'string' || typeof entry.relativePath !== 'string') {
        throw new Error('Invalid library index entry')
      }
      assertSafeRelative(entry.relativePath)
      const key = locationKey(entry)
      const previous = byPath.get(key)
      if (!previous) {
        byPath.set(key, entry)
      } else {
        const ambiguous = !sameEdition(previous, entry) || JSON.stringify(previous.volumeNames) !== JSON.stringify(entry.volumeNames)
        if (ambiguous || conflicts.has(key)) {
          const rows = conflicts.get(key) ?? [previous]
          rows.push(entry)
          conflicts.set(key, rows)
        }
        if ((entry.createdAt ?? '') >= (previous.createdAt ?? '')) byPath.set(key, entry)
      }
    }
    this.entries = new Map([...byPath.values()].map((entry) => [entry.id, entry]))
    this.legacyConflicts = conflicts
    await this.recoverImport()
    await this.recoverRemoval()
    if (file && byPath.size < file.entries.length) {
      // Preserve the old index on read, including ambiguous historical ownership.
      this.logger.warn('library', 'legacy_index_has_duplicate_paths', { count: file.entries.length - byPath.size })
    }
  }

  list(options: { query?: string; limit?: number } = {}): LibraryEntry[] {
    return this.page(options).items
  }

  page(options: { query?: string; limit?: number; offset?: number; integrity?: LibraryEntry['integrity'];
    sort?: 'recent' | 'name' | 'size' } = {}) {
    const query = (options.query ?? '').trim().toLowerCase()
    const byName = options.sort === 'name'
    const bySize = options.sort === 'size'
    const entries = [...this.entries.values()]
      .filter((e) => (!options.integrity || e.integrity === options.integrity) &&
        (!query || `${e.title} ${e.author} ${e.volumeNames.join(' ')}`.toLowerCase().includes(query)))
      .sort((a, b) => (byName ? a.title.localeCompare(b.title, 'zh-Hans-CN') : bySize ? b.bytes - a.bytes : 0) ||
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    return paginate(entries, options)
  }

  forTask(taskId: string): LibraryEntry[] {
    return [...this.entries.values()].filter((entry) => entry.taskId === taskId || entry.previousTaskIds?.includes(taskId))
  }

  archivedPaths(): string[] {
    return [...this.entries.values()].flatMap((entry) =>
      entry.storageFolder === undefined ? [] : [path.join(entry.storageFolder, entry.relativePath)])
  }

  get(id: string): LibraryEntry | undefined {
    return this.entries.get(id)
  }

  stats() {
    const totals = { total: this.entries.size, bytes: 0, chapters: 0, ok: 0, failed: 0 }
    const sources = new Map<string, number>()
    for (const entry of this.entries.values()) {
      totals.bytes += entry.bytes
      totals.chapters += entry.chapterCount
      if (entry.integrity === 'ok') totals.ok++
      else totals.failed++
      sources.set(entry.sourceId, (sources.get(entry.sourceId) ?? 0) + 1)
    }
    return { ...totals, bySource: Object.fromEntries(sources) }
  }

  /** One writer stages and commits one verified volume at a time. */
  add(input: ImportInput): Promise<LibraryEntry | null> {
    return this.mutate(() => this.ingest(input))
  }

  private async ingest(input: ImportInput): Promise<LibraryEntry | null> {
    input.signal?.throwIfAborted()
    const identity: EditionIdentity = {
      sourceId: input.sourceId, bookId: input.bookId, bangumiSubjectId: input.bangumi?.id,
      language: input.language, editionId: input.editionId,
    }
    if (!identity.sourceId || !identity.bookId || !input.artifact.volumeNames.length ||
        input.artifact.volumeNames.some((name) => typeof name !== 'string' || !name.trim())) {
      throw new Error('LIBRARY_IDENTITY_UNKNOWN: EPUB requires a source work and named volumes')
    }
    const base = input.bangumi ? bangumiFolderName(input.bangumi.title) : sanitizeFileName(input.title, 'novel')
    const volume = sanitizeFileName(input.artifact.volumeNames[0]!, 'volume')
    const relativePath = path.join(base, volume.toLowerCase().endsWith('.epub') ? volume : volume + '.epub')
    const storageFolder = this.storage?.root
      ? (await readDownloadFolders(this.storage.settingsFile)).novelFolder ?? undefined : undefined
    const root = await this.root(storageFolder)
    const destination = safeResolve(root, relativePath)
    const series = path.dirname(destination)
    await mkdir(series, { recursive: true })
    await this.checkSeries(root, series)

    const indexed = [...this.entries.values()].filter((entry) => entry.storageFolder === storageFolder &&
      path.dirname(entry.relativePath) === base)
    const marker = path.join(series, '.studio-novel.json')
    const markerInfo = await fileInfo(marker)
    const conflict = () => new LibraryConflict(input.bangumi ? 'BANGUMI_FOLDER_CONFLICT' : 'LIBRARY_FOLDER_CONFLICT',
      '此目录已被其他轻小说版本使用，或存在来源无法确认的 EPUB。')
    let subjectId: number | undefined
    if (markerInfo) {
      const previous = markerInfo.isFile()
        ? await optionalJson<{ subjectId: number; sourceId: string; bookId: string }>(marker) : undefined
      if (!previous || previous.subjectId !== identity.bangumiSubjectId ||
          previous.sourceId !== identity.sourceId || previous.bookId !== identity.bookId) throw conflict()
      subjectId = previous.subjectId
    }

    if (indexed.some((entry) => this.legacyConflicts.has(locationKey(entry)) ||
      !sameEdition({ ...entry, bangumiSubjectId: entry.bangumiSubjectId ?? subjectId }, identity))) {
      throw conflict()
    }
    const tracked = new Set(indexed.map((entry) => path.basename(entry.relativePath)))
    const files = await readdir(series)
    if (files.some((name) => /\.epub$/i.test(name) && !tracked.has(name))) throw conflict()
    const previous = indexed.find((entry) => entry.relativePath === relativePath)
    if (previous && JSON.stringify(previous.volumeNames) !== JSON.stringify(input.artifact.volumeNames)) throw conflict()
    const oldHash = await fileHash(destination)
    const sidecarInfo = await fileInfo(destination + '.sha256')
    if (oldHash !== (previous?.sha256 ?? null) || (sidecarInfo && (!previous || !sidecarInfo.isFile()))) {
      throw conflict()
    }

    const id = `lib_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const staging = this.stagingPath(series, id)
    let journalStarted = false
    try {
      await copyFile(input.artifact.path, staging, constants.COPYFILE_EXCL)
      const integrity = await verifyEpub(staging)
      if (!integrity.ok) return null
      if (input.artifact.sha256 && input.artifact.sha256 !== integrity.sha256) {
        throw new Error('INTEGRITY_FAILED: EPUB changed after task verification')
      }
      if (previous?.sha256 === integrity.sha256 && previous.taskId === input.taskId) return previous

      const handle = await open(staging, 'r')
      try { await handle.sync() } finally { await handle.close() }
      await syncDirectory(series)
      await syncDirectory(root)
      input.signal?.throwIfAborted()
      const entry: LibraryEntry = {
        ...identity, id, title: input.title, author: input.author, relativePath, storageFolder,
        volumeNames: input.artifact.volumeNames, chapterCount: integrity.chapters,
        bytes: integrity.bytes, sha256: integrity.sha256, createdAt: new Date().toISOString(),
        taskId: input.taskId, integrity: 'ok',
        ...(previous?.sha256 === integrity.sha256
          ? { previousTaskIds: [...new Set([previous.taskId, ...(previous.previousTaskIds ?? [])])] } : {}),
      }
      const journal: ImportJournal = { version: 1, entry, previousSha256: oldHash }
      // Once the intent may be durable, leave staging for recovery on every error.
      journalStarted = true
      await atomicWriteJson(this.journalPath, journal)
      await this.commitImport(journal)
      return entry
    } finally {
      if (!journalStarted) await rm(staging, { force: true })
    }
  }

  private async checkSeries(root: string, series: string): Promise<void> {
    if (!(await lstat(series)).isDirectory() ||
        await realpath(series) !== safeResolve(await realpath(root), path.relative(root, series))) {
      throw new Error('Novel archive contains a symbolic link')
    }
  }

  private stagingPath(series: string, id: string): string {
    if (!/^lib_[a-f0-9]{16}$/.test(id)) throw new Error('Invalid EPUB import journal identifier')
    return path.join(series, `.pending-${id}.tmp`)
  }

  private async recoverImport(): Promise<void> {
    const journal = await optionalJson<ImportJournal>(this.journalPath)
    if (journal === undefined) return
    await this.commitImport(journal)
    this.logger.info('library', 'recovered_import', { id: journal.entry.id })
  }

  private async commitImport(journal: ImportJournal): Promise<void> {
    const { entry, previousSha256 } = journal
    if (journal.version !== 1 || !entry || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        (previousSha256 !== null && !/^[a-f0-9]{64}$/.test(previousSha256))) {
      throw new Error('Invalid EPUB import journal')
    }
    const relative = assertSafeRelative(entry.relativePath)
    if (relative.split(path.sep).length !== 2 || !/\.epub$/i.test(relative)) throw new Error('Invalid EPUB import path')
    if (this.legacyConflicts.has(locationKey(entry))) {
      throw new LibraryConflict('LIBRARY_RECOVERY_CONFLICT', 'The legacy index has multiple owners for the import path')
    }
    const root = await this.root(entry.storageFolder)
    const destination = safeResolve(root, relative)
    const series = path.dirname(destination)
    const staging = this.stagingPath(series, entry.id)
    await this.checkSeries(root, series)
    const hash = await fileHash(destination)
    if (hash !== entry.sha256) {
      if (hash !== previousSha256 || await fileHash(staging) !== entry.sha256) {
        throw new Error('LIBRARY_RECOVERY_CONFLICT: EPUB import contains unexpected files; backup and inspect the journal')
      }
      if (previousSha256 === null) await link(staging, destination)
      else await rename(staging, destination)
    }
    const sidecar = destination + '.sha256'
    const sidecarInfo = await fileInfo(sidecar)
    if (sidecarInfo && !sidecarInfo.isFile()) throw new Error('Invalid EPUB checksum file')
    await atomicWriteText(sidecar, `${entry.sha256}  ${path.basename(destination)}\n`)
    const next = new Map(this.entries)
    for (const [id, other] of next) {
      if (other.storageFolder === entry.storageFolder && other.relativePath === entry.relativePath) next.delete(id)
    }
    next.set(entry.id, entry)
    await this.persist(next)
    await rm(staging, { force: true })
    await syncDirectory(series)
    await rm(this.journalPath, { force: true })
    await syncDirectory(this.libraryDir)
    this.logger.info('library', 'added', { id: entry.id, relativePath: relative })
  }

  /** Re-verify a single entry or the whole library. */
  verify(id?: string): Promise<Array<{ id: string; ok: boolean; problems: string[]; sha256Changed: boolean }>> {
    return this.mutate(() => this.verifyEntries(id))
  }

  private async verifyEntries(id?: string) {
    const next = new Map([...this.entries].map(([key, entry]) => [key, { ...entry }]))
    const targets = id ? [next.get(id)].filter((e): e is LibraryEntry => !!e) : [...next.values()]
    const results: Array<{ id: string; ok: boolean; problems: string[]; sha256Changed: boolean }> = []
    for (const entry of targets) {
      try {
        const absolute = await this.filePath(entry)
        const result = await verifyEpub(absolute)
        const sha256Changed = result.sha256 !== entry.sha256
        entry.integrity = result.ok && !sha256Changed ? 'ok' : 'failed'
        results.push({ id: entry.id, ok: entry.integrity === 'ok', problems: result.problems, sha256Changed })
      } catch (error) {
        entry.integrity = 'failed'
        results.push({ id: entry.id, ok: false, problems: [String(error)], sha256Changed: false })
      }
    }
    if (targets.length) await this.persist(next)
    return results
  }

  async readChecksums(): Promise<string[]> {
    const out: string[] = []
    for (const entry of this.entries.values()) {
      try {
        const sidecar = `${await this.filePath(entry)}.sha256`
        if (!(await lstat(sidecar)).isFile()) continue
        out.push((await readFile(sidecar, 'utf8')).trim())
      } catch { /* no sidecar for older entries */ }
    }
    return out
  }

  remove(id: string): Promise<boolean> {
    return this.mutate(() => this.removeEntry(id))
  }

  private async removeEntry(id: string): Promise<boolean> {
    const entry = this.entries.get(id)
    if (!entry) return false
    if (this.legacyConflicts.has(locationKey(entry))) {
      throw new LibraryConflict('LIBRARY_FOLDER_CONFLICT', 'The legacy index has multiple owners for this path')
    }
    const root = await this.root(entry.storageFolder)
    const file = safeResolve(root, assertSafeRelative(entry.relativePath))
    await this.checkSeries(root, path.dirname(file))
    const journal: RemovalJournal = { version: 1, entry, observedSha256: await fileHash(file) }
    await atomicWriteJson(this.removalPath, journal)
    await this.commitRemoval(journal)
    return true
  }

  private async recoverRemoval(): Promise<void> {
    const journal = await optionalJson<RemovalJournal>(this.removalPath)
    if (journal === undefined) return
    await this.commitRemoval(journal)
    this.logger.info('library', 'recovered_removal', { id: journal.entry.id })
  }

  private async commitRemoval(journal: RemovalJournal): Promise<void> {
    const { entry, observedSha256 } = journal
    if (journal.version !== 1 || !entry?.id ||
        (observedSha256 !== null && !/^[a-f0-9]{64}$/.test(observedSha256))) throw new Error('Invalid EPUB removal journal')
    const previous = this.entries.get(entry.id)
    if (this.legacyConflicts.has(locationKey(entry)) ||
        (previous && locationKey(previous) !== locationKey(entry))) throw new Error('LIBRARY_REMOVAL_CONFLICT')
    const root = await this.root(entry.storageFolder)
    const file = safeResolve(root, assertSafeRelative(entry.relativePath))
    const series = path.dirname(file)
    await this.checkSeries(root, series)
    const current = await fileHash(file)
    if (current !== null && (!previous || current !== observedSha256)) throw new Error('LIBRARY_REMOVAL_CONFLICT')
    if (previous) {
      await rm(file, { force: true })
      await rm(`${file}.sha256`, { force: true })
      await syncDirectory(series)
      const next = new Map(this.entries)
      next.delete(entry.id)
      await this.persist(next)
    }
    await rm(this.removalPath, { force: true })
    await syncDirectory(this.libraryDir)
  }

  private async persist(entries: Map<string, LibraryEntry>): Promise<void> {
    const ambiguous = [...this.legacyConflicts.values()].flat().filter((entry) => !entries.has(entry.id))
    const file: LibraryIndexFile = { version: 1, entries: [...ambiguous, ...entries.values()] }
    await atomicWriteJson(this.indexPath, file)
    this.entries = entries
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(async () => {
      await this.load()
      await this.recoverImport()
      await this.recoverRemoval()
      return operation()
    })
    this.mutations = result.catch(() => undefined)
    return result
  }
}
