#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const schema = `
  CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, snapshot_sha256 TEXT NOT NULL);
  CREATE TABLE works (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('novel', 'manga')), title TEXT NOT NULL) STRICT;
  CREATE TABLE editions (
    id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), language TEXT, version_identifier TEXT
  ) STRICT;
  CREATE TABLE source_bindings (
    edition_id TEXT PRIMARY KEY REFERENCES editions(id), source_id TEXT NOT NULL, source_work_id TEXT NOT NULL
  ) STRICT;
  CREATE TABLE metadata_bindings (
    work_id TEXT NOT NULL REFERENCES works(id), provider TEXT NOT NULL, subject_id INTEGER NOT NULL,
    PRIMARY KEY (provider, subject_id)
  ) STRICT;
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, edition_id TEXT NOT NULL REFERENCES editions(id), state TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, legacy_json TEXT NOT NULL CHECK(json_valid(legacy_json))
  ) STRICT;
  CREATE TABLE job_attempts (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), state TEXT NOT NULL, attempt_number INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE volumes (
    id INTEGER PRIMARY KEY, edition_id TEXT NOT NULL REFERENCES editions(id), label TEXT NOT NULL,
    UNIQUE (edition_id, label)
  ) STRICT;
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY, edition_id TEXT NOT NULL REFERENCES editions(id), job_id TEXT REFERENCES jobs(id),
    storage_folder TEXT, relative_path TEXT NOT NULL, sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL, legacy_json TEXT NOT NULL CHECK(json_valid(legacy_json))
  ) STRICT;
  CREATE TABLE artifact_volumes (
    artifact_id TEXT NOT NULL REFERENCES artifacts(id), position INTEGER NOT NULL,
    volume_id INTEGER NOT NULL REFERENCES volumes(id), PRIMARY KEY(artifact_id, position)
  ) STRICT;
  CREATE INDEX job_state_updated ON jobs(state, updated_at DESC, id);
  CREATE INDEX artifact_location ON artifacts(storage_folder, relative_path);
  CREATE INDEX source_work ON source_bindings(source_id, source_work_id);
`

const digest = (value) => createHash('sha256').update(value).digest('hex')
const key = (...parts) => digest(JSON.stringify(parts))
const present = (value) => typeof value === 'string' && value.length > 0

function safeArchivePath(value) {
  return present(value) && !path.posix.isAbsolute(value) && !/[\\:\x00-\x1f]/.test(value) &&
    value.split('/').every((segment) => segment && segment !== '..' && segment !== '.')
}

async function readFileSnapshot(root, relative) {
  const file = path.join(root, relative)
  if (await realpath(file) !== file) throw new Error(`Symlink in snapshot: ${relative}`)
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Expected a JSON file: ${relative}`)
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

async function readSnapshot(source) {
  const records = new Map([['library/index.json', await readFileSnapshot(source, 'library/index.json')]])
  const tasks = path.join(source, 'tasks')
  if (await realpath(tasks) !== tasks) throw new Error('Symlink in task snapshot')
  const files = (await readdir(tasks)).filter((name) => name.endsWith('.json')).sort()
  for (const name of files) records.set('tasks/' + name, await readFileSnapshot(source, 'tasks/' + name))
  const fingerprint = digest(JSON.stringify([...records].map(([name, bytes]) => [name, digest(bytes)])))
  return { records, fingerprint }
}

function populate(db, records, fingerprint) {
  const catalog = JSON.parse(records.get('library/index.json').toString('utf8'))
  if (catalog?.version !== 1 || !Array.isArray(catalog.entries)) throw new Error('Unsupported legacy library index')
  db.exec('BEGIN IMMEDIATE')
  db.exec(schema)
  const work = db.prepare("INSERT OR IGNORE INTO works VALUES (?, 'novel', ?)")
  const edition = db.prepare('INSERT OR IGNORE INTO editions VALUES (?, ?, ?, ?)')
  const binding = db.prepare('INSERT OR IGNORE INTO source_bindings VALUES (?, ?, ?)')
  const metadata = db.prepare("INSERT OR IGNORE INTO metadata_bindings VALUES (?, 'bangumi', ?)")
  const job = db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?)')
  const attempt = db.prepare('INSERT INTO job_attempts VALUES (?, ?, ?, ?)')
  const artifact = db.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  const volume = db.prepare('INSERT OR IGNORE INTO volumes(edition_id, label) VALUES (?, ?)')
  const volumeId = db.prepare('SELECT id FROM volumes WHERE edition_id = ? AND label = ?')
  const artifactVolume = db.prepare('INSERT INTO artifact_volumes VALUES (?, ?, ?)')
  const jobs = new Set()

  function saveIdentity(record, subject) {
    const { sourceId, bookId, title, language, editionId } = record
    if (![sourceId, bookId, title].every(present)) throw new Error('Snapshot contains a record without source, work ID, or title')
    const bangumi = Number.isSafeInteger(subject) && subject > 0 ? subject : null
    const workId = bangumi ? 'bangumi:' + bangumi : key('novel', sourceId, bookId)
    const id = key(workId, sourceId, bookId, language ?? null, editionId ?? null)
    work.run(workId, title)
    edition.run(id, workId, language ?? null, editionId ?? null)
    binding.run(id, sourceId, bookId)
    if (bangumi) metadata.run(workId, bangumi)
    return id
  }

  for (const [file, contents] of records) {
    if (!file.startsWith('tasks/')) continue
    const row = JSON.parse(contents.toString('utf8'))
    const states = ['queued', 'running', 'verifying', 'importing', 'completed', 'cancelling', 'cancelled', 'failed', 'interrupted']
    if (!row || !present(row.id) || file !== `tasks/${row.id}.json` || !states.includes(row.state) ||
        ![row.createdAt, row.updatedAt].every(present) || !row.request) throw new Error(`Invalid task snapshot: ${file}`)
    const identity = saveIdentity(row.request, row.request.bangumi?.id)
    job.run(row.id, identity, row.state, row.createdAt, row.updatedAt, contents.toString('utf8'))
    jobs.add(row.id)
    if (present(row.attemptId)) attempt.run(row.attemptId, row.id, row.state, row.retryCount ?? 0)
  }

  for (const entry of catalog.entries) {
    if (!entry || !present(entry.id) || !safeArchivePath(entry.relativePath) ||
        (entry.storageFolder != null && entry.storageFolder !== '' && !safeArchivePath(entry.storageFolder)) ||
        !/^[a-f0-9]{64}$/i.test(entry.sha256) || !present(entry.createdAt) ||
        !Array.isArray(entry.volumeNames) || !entry.volumeNames.every(present)) throw new Error('Invalid novel library entry')
    // Legacy entries without explicit Bangumi identity are preserved under their confirmed source identity.
    const editionId = saveIdentity(entry, entry.bangumiSubjectId)
    artifact.run(entry.id, editionId, jobs.has(entry.taskId) ? entry.taskId : null, entry.storageFolder ?? null,
      entry.relativePath, entry.sha256, entry.createdAt, JSON.stringify(entry))
    entry.volumeNames.forEach((label, position) => {
      volume.run(editionId, label)
      artifactVolume.run(entry.id, position, volumeId.get(editionId, label).id)
    })
  }
  db.prepare('INSERT INTO schema_migrations VALUES (1, ?)').run(fingerprint)
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Foreign key validation failed')
  db.exec('PRAGMA user_version = 1; COMMIT')
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLite integrity validation failed')
  return { jobs: jobs.size, artifacts: catalog.entries.length }
}

export async function migrateNovelState(sourceInput, destinationInput) {
  const source = await realpath(sourceInput)
  for (const operation of ['import', 'removal']) {
    if (await lstat(path.join(source, 'library', `.pending-epub-${operation}.json`)).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })) throw new Error(`The snapshot contains a pending EPUB ${operation}. Recover it before exporting a new snapshot.`)
  }
  const destination = path.join(await realpath(path.dirname(path.resolve(destinationInput))), path.basename(destinationInput))
  const relative = path.relative(source, destination)
  if (!relative || !(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) {
    throw new Error('Choose an output directory outside the source snapshot')
  }
  const { records, fingerprint } = await readSnapshot(source)
  const existing = await lstat(destination).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
  if (existing) {
    if (!existing.isDirectory()) throw new Error('Output path already exists')
    const file = path.join(destination, 'novel-state.sqlite')
    if (!(await lstat(file)).isFile()) throw new Error('Existing migration database is not a regular file')
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const version = db.prepare('SELECT snapshot_sha256 FROM schema_migrations WHERE version = 1').get()
      if (version?.snapshot_sha256 !== fingerprint || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') {
        throw new Error('Output already contains a different or damaged snapshot')
      }
      return { unchanged: true, fingerprint }
    } finally { db.close() }
  }
  const staging = await mkdtemp(destination + '.staging-')
  try {
    for (const [file, bytes] of records) {
      const backup = path.join(staging, 'json-backup', file)
      await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 })
      await writeFile(backup, bytes, { flag: 'wx', mode: 0o600, flush: true })
    }
    const database = path.join(staging, 'novel-state.sqlite')
    const db = new DatabaseSync(database, { timeout: 5000 })
    let result
    try {
      db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL')
      result = populate(db, records, fingerprint)
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally { db.close() }
    await chmod(database, 0o600)
    if ((await readSnapshot(source)).fingerprint !== fingerprint) throw new Error('Source changed during migration')
    // A completed destination is nonempty, so concurrent publication cannot replace it.
    await rename(staging, destination)
    return { ...result, fingerprint }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [source, destination, extra] = process.argv.slice(2)
  if (!source || !destination || extra) {
    console.error('Usage: node scripts/migrate-novel-state.mjs <stopped-data-snapshot> <new-output-directory>')
    process.exitCode = 1
  } else {
    try { console.log(JSON.stringify(await migrateNovelState(source, destination))) }
    catch (error) { console.error(error.message); process.exitCode = 1 }
  }
}
