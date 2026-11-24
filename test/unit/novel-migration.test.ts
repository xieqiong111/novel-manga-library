import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { migrateNovelState } from '../../scripts/migrate-novel-state.mjs'

it('backs up source JSON and publishes a verified, repeatable SQLite snapshot only after success', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ln-migrate-'))
  try {
    const source = path.join(root, 'source')
    await mkdir(path.join(source, 'library'), { recursive: true })
    await mkdir(path.join(source, 'tasks'), { recursive: true })
    const jobId = 'task_0000000000000001'
    const edition = { sourceId: 'fixture', bookId: 'fixture:novel', title: '示例作品', language: 'zh', editionId: 'translation-a' }
    const now = '2026-11-24T00:00:00.000Z'
    const task = JSON.stringify({ id: jobId, request: { ...edition, bangumi: { id: 123 } }, state: 'interrupted',
      attemptId: 'attempt-a', retryCount: 2, createdAt: now, updatedAt: now })
    const taskFile = path.join(source, 'tasks', jobId + '.json')
    await writeFile(taskFile, task)
    const index = path.join(source, 'library', 'index.json')
    const entry = {
      ...edition, id: 'lib_one', relativePath: '示例作品/第一卷.epub', sha256: 'a'.repeat(64), createdAt: now,
      bangumiSubjectId: 123, taskId: jobId, volumeNames: ['卷一', '卷二'],
    }
    const out = path.join(root, 'migration')
    await writeFile(index, JSON.stringify({ version: 1, entries: [entry, entry] }))
    await expect(migrateNovelState(source, out)).rejects.toThrow()
    await expect(readFile(path.join(out, 'novel-state.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })

    const catalog = JSON.stringify({ version: 1, entries: [entry] })
    await writeFile(index, catalog)
    await expect(migrateNovelState(source, out)).resolves.toMatchObject({ jobs: 1, artifacts: 1 })
    await expect(migrateNovelState(source, out)).resolves.toMatchObject({ unchanged: true })
    await expect(migrateNovelState(source, path.join(source, 'out'))).rejects.toThrow(/outside/)
    const db = new DatabaseSync(path.join(out, 'novel-state.sqlite'), { readOnly: true })
    try {
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(db.prepare('SELECT job_id, storage_folder FROM artifacts').get()).toMatchObject({ job_id: jobId, storage_folder: null })
      expect(db.prepare('SELECT COUNT(*) AS count FROM works').get()).toMatchObject({ count: 1 })
      expect(db.prepare('SELECT attempt_number FROM job_attempts').get()).toMatchObject({ attempt_number: 2 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM artifact_volumes').get()).toMatchObject({ count: 2 })
    } finally { db.close() }
    expect(await readFile(path.join(out, 'json-backup', 'tasks', jobId + '.json'), 'utf8')).toBe(task)
    expect(await readFile(index, 'utf8')).toBe(catalog)
    expect(await readFile(taskFile, 'utf8')).toBe(task)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
