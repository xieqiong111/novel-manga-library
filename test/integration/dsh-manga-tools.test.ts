/** Exercise the manga tools through the real DSH validator/executor without a Suwayomi write. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import type { PluginRuntime } from '../../src/runtime.js'
import { registerMangaTools } from '../../src/tools/manga.js'
import type { MangaKomga } from '../../server/manga-komga.mjs'

const manga = {
  sources: vi.fn(async () => ({ sources: [{ id: 'source-1', name: 'Example', lang: 'en' }], totalCount: 1, hasNextPage: false })),
  searchManga: vi.fn(async (args: unknown) => ({ items: [{ id: 'manga-1' }], totalCount: 1, args })),
  getManga: vi.fn(async (id: string) => ({ id, title: 'Example Manga' })),
  getChapters: vi.fn(async (id: string, page: unknown) => ({ mangaId: id, items: [{ id: 'chapter-1' }], page })),
  download: vi.fn(async (args: unknown) => ({ queued: ['chapter-1'], unconfirmed: [] as string[], args })),
  tasks: vi.fn(async (args: unknown) => ({ queue: [{ chapterId: 'chapter-1' }], args })),
  library: vi.fn(async (args: unknown) => ({ items: [{ id: 'manga-1' }], args })),
  setLibrary: vi.fn(async (args: unknown) => ({ id: 'manga-1', inLibrary: true, args })),
}

const runtime = {
  ready: vi.fn(async () => {}),
  suwayomi: manga,
  logger: { warn: vi.fn() },
} as unknown as PluginRuntime

const komga = {
  status: vi.fn<MangaKomga['status']>(async () => ({
    available: true, volumes: [{ number: 2, total: 2, downloaded: 1, filename: null, state: 'downloading', tasks: [
      { id: '41', mangaId: '22', title: 'Example Manga', chapterId: '41', chapterName: '第2卷 第2话',
        state: 'running', upstreamState: 'DOWNLOADING', percent: 61 },
    ] }],
  })),
  download: vi.fn(async () => ({ queued: ['41'], skipped: [], completed: [], filename: null })),
  downloadChapters: vi.fn(async () => ({ queued: [], skipped: ['41'], completed: [], filename: null,
    archived: [{ chapterId: '41', filename: '第007话 [41].cbz' }] })),

}

let ctx: Context
let sequence = 0

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const batch = await ctx.tools.execute({
    calls: [{
      type: 'tool-call',
      id: `manga_${++sequence}`,
      name,
      arguments: JSON.stringify(args),
    }],
    signal: new AbortController().signal,
  })
  const result = batch.results[0]?.result as { isError?: boolean; value?: unknown; content?: unknown } | undefined
  if (!result) throw new Error(`DSH returned no result for ${name}`)
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`)
  return result.value as Record<string, unknown>
}

beforeAll(async () => {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  registerMangaTools(ctx, runtime, komga as unknown as MangaKomga)
})

afterAll(async () => { await ctx?.dispose?.() })

describe('native manga tools', () => {
  it('registers independent tools with DSH output schemas', () => {
    const names = [
      'manga_search', 'manga_details', 'manga_chapters', 'manga_download',
      'manga_tasks', 'manga_library', 'manga_sources', 'manga_subscribe',
      'manga_komga_status', 'manga_komga_download',
    ]
    const schemas = ctx.tools.schemas()
    for (const name of names) {
      expect(schemas.map((tool) => tool.name)).toContain(name)
      const definition = ctx.tools.get(name)
      expect(definition?.output.schema, name).toBeTruthy()
      expect(typeof definition?.execute, name).toBe('function')
    }
  })

  it('dispatches structured calls to the shared Suwayomi client', async () => {
    expect((await call('manga_search', { query: 'title', page: 2, offset: 20, resultId: 'fixture-result', limit: 5 })).ok).toBe(true)
    expect(manga.searchManga).toHaveBeenCalledWith({
      query: 'title', sourceId: undefined, type: 'SEARCH', page: 2, offset: 20, resultId: 'fixture-result', limit: 5,
    })

    expect((await call('manga_details', { mangaId: 'manga-1' })).ok).toBe(true)
    expect(manga.getManga).toHaveBeenCalledWith('manga-1')

    expect((await call('manga_chapters', { mangaId: 'manga-1', limit: 10, offset: 20 })).ok).toBe(true)
    expect(manga.getChapters).toHaveBeenCalledWith('manga-1', { limit: 10, offset: 20 })

    expect((await call('manga_download', { mangaId: 'manga-1', chapterIds: ['chapter-1', 'chapter-1'] })).ok).toBe(true)
    expect(manga.download).toHaveBeenCalledWith({ mangaId: 'manga-1', chapterIds: ['chapter-1'] })

    expect((await call('manga_tasks', { action: 'cancel', chapterIds: ['chapter-1'] })).ok).toBe(true)
    expect(manga.tasks).toHaveBeenCalledWith({ action: 'cancel', chapterIds: ['chapter-1'] })

    expect((await call('manga_library', { limit: 25, offset: 5 })).ok).toBe(true)
    expect(manga.library).toHaveBeenCalledWith({ limit: 25, offset: 5 })

    expect((await call('manga_sources')).ok).toBe(true)
    expect(manga.sources).toHaveBeenCalledOnce()

    expect((await call('manga_subscribe', { mangaId: 'manga-1', inLibrary: true })).ok).toBe(true)
    expect(manga.setLibrary).toHaveBeenCalledWith({ mangaId: 'manga-1', inLibrary: true })
  })

  it('dispatches Komga volume status and download through native DSH tools', async () => {
    expect(await call('manga_komga_status', { mangaId: '22', volume: 2 })).toMatchObject({
      ok: true, volumes: [{ number: 2, state: 'downloading', tasks: [{ percent: 61 }] }],
    })
    expect(komga.status).toHaveBeenCalledWith('22', 2)
    expect(await call('manga_komga_download', { mangaId: '22', volume: 2 })).toMatchObject({
      ok: true, queued: ['41'], filename: null,
    })
    expect(komga.download).toHaveBeenCalledWith('22', 2)
  })

  it('explains the difference between a chapter download and its CBZ and supports selected chapter IDs', async () => {
    komga.status.mockResolvedValueOnce({
      available: true, archiveMode: 'chapter', volumes: [], chapters: [
        { id: '41', number: '7', name: '第7话', downloaded: true, filename: null, state: 'waiting_archive', task: null },
        { id: '42', number: '8', name: '第8话', downloaded: true, filename: null, state: 'archive_failed', task: null },
      ],
    })
    const result = await call('manga_komga_status', { mangaId: '22', chapterIds: ['41', '42'] })
    expect(result).toMatchObject({
      archiveMode: 'chapter', notice: expect.stringContaining('待打包 1，下载中 0，排队 0，下载失败 0，归档失败 1'),
    })
    expect(komga.status).toHaveBeenLastCalledWith('22', undefined, { chapterIds: ['41', '42'], offset: undefined, limit: undefined })
    const archived = await call('manga_komga_download', { mangaId: '22', chapterIds: ['41'] })
    expect(archived).toMatchObject({ ok: true, summary: expect.stringContaining('确认 CBZ 1 个'),
      next: { tool: 'manga_komga_status', args: { mangaId: '22', chapterIds: ['41'] } } })
    expect(komga.downloadChapters).toHaveBeenCalledExactlyOnceWith('22', ['41'])
    expect(await call('manga_komga_download', { mangaId: '22', chapterIds: ['41'], volume: 7 })).toMatchObject({
      ok: false, error: { code: 'MANGA_ARCHIVE_SELECTION_REQUIRED' },
    })
    expect(komga.downloadChapters).toHaveBeenCalledOnce()
  })

  it('reports an unconfirmed enqueue as unresolved without requesting an automatic retry', async () => {
    manga.download.mockResolvedValueOnce({ queued: [], unconfirmed: ['chapter-1'], args: null })
    const result = await call('manga_download', { mangaId: 'manga-1', chapterIds: ['chapter-1'] })
    expect(result).toMatchObject({
      ok: false,
      unconfirmed: ['chapter-1'],
      error: { code: 'MANGA_DOWNLOAD_UNCONFIRMED', retryable: false },
    })
  })

  it('rejects unsupported actions and empty required selections without calling Suwayomi', async () => {
    const beforeCalls = manga.download.mock.calls.length
    const download = await call('manga_download', { mangaId: 'manga-1', chapterIds: [] })
    expect(download.ok).toBe(false)
    expect((await call('manga_tasks', { action: 'pause' })).ok).toBe(false)
    expect(manga.download).toHaveBeenCalledTimes(beforeCalls)
  })
})
