import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { Library } from '../../src/core/library.js'
import { createLogger } from '../../src/util/logger.js'
import { createApi } from '../../server/api.mjs'
import type { LibraryEntry } from '../../src/types.js'

it('filters and sorts before pagination and returns old task artifacts beyond the first 200 rows', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ln-page-'))
  const libraryDir = path.join(directory, 'library')
  const logger = createLogger(path.join(directory, 'logs'))
  try {
    const taskId = 'task_0000000000000000'
    const date = (index: number) => new Date(1_710_000_000_000 + index * 1000).toISOString()
    const entries: LibraryEntry[] = Array.from({ length: 1001 }, (_, i) => ({
      id: 'lib_' + String(i).padStart(16, '0'), bookId: 'fixture:' + i, sourceId: 'fixture',
      title: i < 3 ? 'Old match' : 'Recent novel', author: 'Author', chapterCount: 1,
      relativePath: `series/${i}.epub`, volumeNames: ['Volume'], bytes: i + 1, sha256: 'a'.repeat(64),
      createdAt: date(i), taskId: i < 3 ? taskId : 'task_new', integrity: i < 3 ? 'failed' : 'ok',
    }))
    const tasks = entries.map((entry, i) => ({
      id: i === 0 ? taskId : 'task_' + String(i).padStart(16, '0'), request: { title: entry.title },
      state: i < 3 ? 'failed' : 'completed', createdAt: date(i), updatedAt: date(i), artifacts: [],
    }))
    await mkdir(libraryDir)
    await writeFile(path.join(libraryDir, 'index.json'), JSON.stringify({ version: 1, entries }))
    const library = new Library(libraryDir, logger)
    await library.load()
    const handler = createApi({ library, tasks: { records: () => tasks, get: (id: string) => tasks.find((item) => item.id === id) } }, {}, logger)
    async function get(route: string) {
      let status = 0
      let data
      await handler({ method: 'GET', headers: {} }, {
        writeHead(code: number) { status = code },
        end(body: string) { data = JSON.parse(body) },
      }, new URL(route, 'http://studio.test'))
      return { status, data }
    }
    const legacy = await get('/api/library')
    expect(legacy.status).toBe(200)
    expect(legacy.data).toHaveLength(200)
    const filtered = await get('/api/library?offset=1&limit=1&query=Old&sort=size&integrity=failed')
    expect(filtered.data).toMatchObject({ total: 3, nextOffset: 2, items: [{ id: entries[1]!.id }] })
    const deepPage = await get('/api/library?offset=1000&limit=40')
    expect(deepPage.data).toMatchObject({ total: 1001, nextOffset: null, items: [{ id: entries[0]!.id }] })
    const failedTasks = await get('/api/tasks?offset=0&limit=3&state=failed&sort=oldest')
    expect(failedTasks.data).toMatchObject({ total: 3, counts: { failed: 3, completed: 998 }, items: [{ id: taskId }, {}, {}] })
    const detail = await get('/api/tasks/' + taskId)
    expect(detail.data).toMatchObject({ artifacts: entries.slice(0, 3).map(({ id }) => ({ id })) })
    expect((await get('/api/tasks?offset=-1')).status).toBe(400)
  } finally {
    await logger.close()
    await rm(directory, { recursive: true, force: true })
  }
})
