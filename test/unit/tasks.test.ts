import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Config, resolveConfig } from '../../src/config.js'
import type { DartBridge, DartRequest } from '../../src/core/bridge.js'
import { Library } from '../../src/core/library.js'
import { TaskStore } from '../../src/core/store.js'
import { TaskManager } from '../../src/core/tasks.js'
import { SourceRegistry } from '../../src/sources/registry.js'
import type { DownloadRequest } from '../../src/types.js'
import { createLogger } from '../../src/util/logger.js'

const request: DownloadRequest = {
  bookId: 'fixture:one', sourceId: 'fixture', source: 'fixture', title: 'One', sourceUrl: 'fixture://one',
  author: 'Author', volumes: '1', volumeNames: ['Vol 1'], combine: false, addChapterTitle: false,
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function makeTasks(run: (request: DartRequest) => Promise<unknown>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ln-attempt-test-'))
  const config = resolveConfig(Config({ dataDir: dir, offlineOnly: true }), dir, dir)
  const logger = createLogger(config.logsDir)
  const store = new TaskStore(config.tasksDir, logger)
  const tasks = new TaskManager(config, store, { run } as unknown as DartBridge,
    new Library(config.libraryDir, logger), new SourceRegistry(config, logger), logger)
  cleanups.push(async () => {
    await tasks.dispose()
    await logger.close()
    await rm(dir, { recursive: true, force: true })
  })
  await tasks.init()
  return tasks
}

it('does not allow retry before a cancelled downloader exits, and only starts one new attempt', async () => {
  let finish!: () => void
  let first!: DartRequest
  const run = vi.fn()
    .mockImplementationOnce((request: DartRequest) => {
      first = request
      return new Promise((resolve) => { finish = () => resolve({ data: { artifacts: [] } }) })
    })
    .mockResolvedValue({ data: { artifacts: [] } })
  const tasks = await makeTasks(run)
  const old = await tasks.start(request)
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  const cancelling = tasks.cancel(old.id)
  try {
    await vi.waitFor(() => expect(tasks.get(old.id)?.state).toBe('cancelling'))
    expect(first.signal?.aborted).toBe(true)
    await expect(tasks.retry(old.id)).rejects.toMatchObject({ code: 'NOT_RETRYABLE' })
  } finally {
    finish()
  }
  await expect(cancelling).resolves.toMatchObject({ state: 'cancelled' })
  const retries = await Promise.allSettled([tasks.retry(old.id), tasks.retry(old.id)])
  expect(retries.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  await vi.waitFor(() => expect(tasks.get(old.id)).toMatchObject({ state: 'failed', error: { code: 'NO_ARTIFACTS' } }))
  const latest = tasks.get(old.id)!
  first.onProgress?.({ type: 'progress', phase: 'chapter', chapter: 'stale result' })
  expect(latest.attemptId).not.toBe(old.attemptId)
  expect(run.mock.calls[1]?.[0].outputDir).not.toBe(first.outputDir)
  expect(run).toHaveBeenCalledTimes(2)
  expect(tasks.get(old.id)?.downloadedChapters).toEqual([])
})
