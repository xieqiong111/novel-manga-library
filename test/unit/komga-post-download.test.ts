import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openKomgaPostDownload } from '../../server/komga-post-download.mjs'

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-follow-up-'))
  const folder = 'Title [test-22]'
  const target = `${folder}/第001话 [21].cbz`
  const last = `${folder}/第002话 [22].cbz`
  await mkdir(path.join(root, folder))
  await writeFile(path.join(root, target), 'chapter')
  await writeFile(path.join(root, last), 'chapter')
  const preferences = { postDownloadRefresh: true, postDownloadScrape: true, scrapeEnabled: true }
  const settings = {
    config: { dataDir: root }, mangaStorageRoot: root, mangaStorageLabel: '/configured/manga',
    integrations: { preferences, bangumi: { sourceMode: 'live' }, bangumiArchiveAvailable: true },
  }
  let clock = 100000
  const archiveHistory = { events: vi.fn(async (after: number) => [
    { seq: 1, mangaId: '22', file: target }, { seq: 2, mangaId: '22', file: last },
  ].filter(({ seq }) => seq > after)) }
  const metadata = vi.fn(async (_action, _params, ensure) => { ensure(); return { updated: true } })
  const scan = vi.fn(async () => ({ accepted: true, message: 'queued' }))
  const client = {
    async libraries() { return { libraries: [
      { id: 'different', root: '/elsewhere' }, { id: 'matching', root: 'file:///configured/manga' },
    ] } },
    series: vi.fn(async () => ({
      content: [{ id: 'other', path: '/configured/manga/Title' }, { id: 'correct', path: '/configured/manga/' + folder }],
      page: { number: 0, last: true },
    })),
    metadataBooks: vi.fn(async () => ({ books: [
      { path: '/configured/manga/' + target }, { path: '/configured/manga/' + last },
    ], last: true, page: 0 })),
  }
  return {
    target, last, preferences, metadata, scan, archiveHistory, client,
    advance(ms: number) { clock += ms },
    cleanup: () => rm(root, { recursive: true, force: true }),
    open: () => openKomgaPostDownload({ settings, archiveHistory, logger: { warn() {} }, now: () => clock }),
    dependencies: { currentKomga: () => client, metadata, scan },
  }
}

describe('after a manga CBZ is saved', () => {
  it('scans once and resumes after restart, scraping only the series at the exact indexed path', async () => {
    const f = await fixture()
    try {
      const original = (await f.open())!
      await original.tick(f.dependencies)
      expect(f.scan).toHaveBeenCalledExactlyOnceWith(f.client, 'matching')
      expect(original.status(f.target)).toMatchObject({ phase: 'indexing' })
      expect(f.metadata).not.toHaveBeenCalled()
      f.advance(20000)
      const restarted = (await f.open())!
      await restarted.tick(f.dependencies)
      expect(f.metadata).toHaveBeenCalledExactlyOnceWith('auto-series', {
        libraryId: 'matching', seriesId: 'correct', kind: 'manga', mangaId: '22',
      }, expect.any(Function))
      expect(restarted.status(f.last)).toMatchObject({ phase: 'done', message: 'Komga 已收录，元数据已更新。' })
      await restarted.tick(f.dependencies)
      expect(f.scan).toHaveBeenCalledOnce()
      expect(f.metadata).toHaveBeenCalledOnce()
    } finally { await f.cleanup() }
  })

  it('waits until the actual CBZ is indexed and respects the independent scrape switch', async () => {
    const f = await fixture()
    try {
      f.preferences.postDownloadScrape = false
      f.client.metadataBooks.mockResolvedValueOnce({ books: [], last: true, page: 0 })
      const worker = (await f.open())!
      await worker.tick(f.dependencies)
      f.advance(20000)
      await worker.tick(f.dependencies)
      expect(worker.status(f.last)).toMatchObject({ phase: 'indexing', message: 'Komga 尚未收录该 CBZ。' })
      f.advance(20000)
      await worker.tick(f.dependencies)
      expect(worker.status(f.last)).toMatchObject({ phase: 'done', message: 'Komga 已收录该 CBZ。' })
      expect(f.metadata).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })

  it('tries the configured official archive only when the real-time connection fails', async () => {
    const f = await fixture()
    try {
      f.metadata.mockRejectedValueOnce(Object.assign(new Error('timed out'), { code: 'BANGUMI_TIMEOUT', status: 504 }))
      const worker = (await f.open())!
      await worker.tick(f.dependencies)
      f.advance(20000)
      await worker.tick(f.dependencies)
      expect(f.metadata).toHaveBeenCalledTimes(2)
      expect(f.metadata.mock.calls[1][3]).toMatchObject({ sourceMode: 'archive', accessToken: '' })
      expect(worker.status(f.last)).toMatchObject({ phase: 'done', message: expect.stringContaining('官方离线档案') })
    } finally { await f.cleanup() }
  })
})
