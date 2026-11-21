import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createApi } from '../../server/api.mjs'
import { createBangumiKomga } from '../../server/bangumi-komga.mjs'
import { resolveDownloadSubject } from '../../server/bangumi-download.mjs'
import { createKomgaClient } from '../../server/komga-client.mjs'
import { defaultScrapeOptions } from '../../server/scrape-options.mjs'

const subject = { id: 123, name: 'テスト', nameCn: '测试作品' }
const seriesInput = { kind: 'manga', scope: 'series', seriesId: 'series-a', subjectId: subject.id }

function fixture() {
  const state = {
    title: '本地标题', summary: '本地简介', summaryLock: true, tags: ['收藏'],
    links: [{ label: '来源', url: 'https://example.invalid/source' }],
  }
  const book = {
    title: '第 1 卷', number: '1', numberSort: 1, summary: '', authors: [{ name: '译者', role: 'translator' }],
  }
  const posters: string[] = []
  const upload = vi.fn()
  const patchSeries = vi.fn()
  const patchBook = vi.fn()
  const scan = vi.fn(() => new Response(null, { status: 202 }))
  const komga = createKomgaClient({ url: 'http://komga:25600', apiKey: 'komga-fixture-key' }, {
    fetchImpl: async (url: string, init: RequestInit) => {
      expect(init.redirect).toBe('error')
      expect(init.headers).toMatchObject({ 'X-API-Key': 'komga-fixture-key' })
      if (url.endsWith('/series/series-a')) return Response.json({ id: 'series-a', name: '系列', libraryId: 'library-a', metadata: state })
      if (url.endsWith('/books/book-a')) return Response.json({ id: 'book-a', name: '卷', seriesId: 'series-a', libraryId: 'library-b', metadata: book })
      if (url.endsWith('/series/series-a/metadata') && init.method === 'PATCH') {
        patchSeries(JSON.parse(String(init.body)))
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/books/book-a/metadata') && init.method === 'PATCH') {
        patchBook(JSON.parse(String(init.body)))
        return new Response(null, { status: 204 })
      }
      if (/\/(series-a|book-a)\/thumbnails$/.test(url)) return Response.json(posters.map((type) => ({ type })))
      if (/\/(series-a|book-a)\/thumbnails\?selected=true$/.test(url) && init.method === 'POST') {
        const image = (init.body as FormData).get('file') as File
        upload(url, image.type, image.size)
        return Response.json({ id: 'poster-a', type: 'USER_UPLOADED', selected: true })
      }
      if (url.includes('/books/list?') && init.method === 'POST') {
        expect(JSON.parse(String(init.body)).condition.allOf[0]).toEqual({ seriesId: { operator: 'is', value: 'series-a' } })
        return Response.json({ content: [{ id: 'book-a', name: '卷', seriesId: 'series-a', metadata: book }], number: 0, last: true })
      }
      if (/\/libraries\/(library-a|library-b)\/scan$/.test(url) && init.method === 'POST') return scan()
      return new Response(null, { status: 404 })
    },
  })
  const adapterFetch = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input)
    expect(init.redirect).toBe('error')
    expect(url.origin).toBe('http://bangumikomga:8091')
    expect(init.headers).not.toHaveProperty('authorization')
    if (url.pathname === '/search') return Response.json({ candidates: [subject], source: 'bangumi-archive', archiveVersion: '2026-11-17T21:04:20Z' })
    const scope = url.searchParams.get('scope')
    const metadata = scope === 'series'
      ? { title: '测试作品', summary: '刮削简介', tags: ['奇幻'], titleSort: 'ignored' }
      : { summary: '本卷简介', number: '99', numberSort: 99, authors: [{ name: '作者', role: 'writer' }] }
    return Response.json({ subject, metadata, source: 'bangumi-archive', archiveVersion: '2026-11-17T21:04:20Z' })
  })
  const run = createBangumiKomga({ url: 'http://bangumikomga:8091', komga: () => komga, fetchImpl: adapterFetch })
  return { run, state, adapterFetch, patchSeries, patchBook, komga, scan, posters, upload }
}

describe('BangumiKomga metadata', () => {
  it('uses the Chinese series title and preserves a Chinese introduction when Bangumi returns Japanese', async () => {
    const { komga, state, patchSeries } = fixture()
    state.summaryLock = false
    const getManga = vi.fn()
    const run = createBangumiKomga({
      komga: () => komga, getManga,
      requestMetadata: async () => ({ status: 200, payload: {
        subject, metadata: { title: 'この素晴らしい世界に祝福を！', summary: 'ゲームを愛する佐藤和真が異世界へと向かう。' },
      } }),
    })
    const preview = await run('preview', seriesInput)
    expect(preview.changes).toMatchObject({ title: { after: '测试作品' } })
    expect(preview.changes).not.toHaveProperty('summary')
    await run('apply', { previewId: preview.previewId })
    expect(patchSeries).toHaveBeenCalledWith(expect.not.objectContaining({ summary: expect.anything() }))
    expect(getManga).not.toHaveBeenCalled()
  })

  it('uses the archived manga’s Chinese source introduction and leaves Japanese-only book summaries unwritten', async () => {
    const { komga, state, patchBook, patchSeries } = fixture()
    state.summary = '異世界での旅が始まる。'
    state.summaryLock = false
    const getManga = vi.fn(async () => ({
      source: { lang: 'zh-TW' }, description: '和真轉生到異世界，與女神展開冒險。\n\nID: 649',
    }))
    const run = createBangumiKomga({
      komga: () => komga, getManga,
      requestMetadata: async () => ({ status: 200, payload: {
        subject, metadata: { summary: 'ゲームを愛する佐藤和真が異世界へと向かう。' },
      } }),
    })
    const book = await run('preview', { ...seriesInput, scope: 'book', bookId: 'book-a' })
    await run('apply', { previewId: book.previewId })
    expect(patchBook).toHaveBeenCalledWith(expect.not.objectContaining({ summary: expect.anything() }))
    await run('auto-series', { kind: 'manga', libraryId: 'library-a', seriesId: 'series-a',
      confirmedSubjectId: 123, mangaId: '22' }, () => {})
    expect(getManga).toHaveBeenCalledExactlyOnceWith('22')
    expect(patchSeries).toHaveBeenCalledWith(expect.objectContaining({ summary: '和真轉生到異世界，與女神展開冒險。' }))
  })

  it('accepts a Chinese synopsis with a quoted Japanese title', async () => {
    const { komga, state } = fixture()
    state.summaryLock = false
    const summary = '《このすば》讲述了少年在异世界结识伙伴的故事，他们一起踏上充满笑料的冒险旅程。'
    const run = createBangumiKomga({ komga: () => komga, requestMetadata: async () => ({
      status: 200, payload: { subject, metadata: { summary } },
    }) })
    const preview = await run('preview', seriesInput)
    expect(preview.changes.summary.after).toBe(summary)
  })

  it('accepts a confirmed source title absent from Bangumi while retaining the Bangumi folder name', async () => {
    const metadata = vi.fn(async () => ({
      subject: { id: 123, title: '正式名称', aliases: ['另一名称'] },
    }))
    await expect(resolveDownloadSubject(metadata, 'manga', ['其他譯名'], 123, '其他譯名'))
      .resolves.toEqual({ id: 123, title: '正式名称' })
    await expect(resolveDownloadSubject(metadata, 'manga', ['其他譯名'], 123, '错误译名'))
      .rejects.toMatchObject({ code: 'BANGUMI_SOURCE_MISMATCH' })
    await expect(resolveDownloadSubject(metadata, 'manga', ['其他譯名'], undefined, '其他譯名'))
      .rejects.toMatchObject({ code: 'BANGUMI_SOURCE_MISMATCH' })
  })

  it('uses the official Chinese title, returns aliases, and leaves same-name series unresolved', async () => {
    const requestMetadata = vi.fn(async (action, params) => ({
      status: 200, payload: action === 'search'
        ? { candidates: [subject, ...(params.query === '同名' ? [
          { ...subject, id: 124, nameCn: '同名' }, { ...subject, id: 125, nameCn: '同名' },
        ] : [])] }
        : { subject, metadata: { alternateTitles: [{ label: '别名', title: '测试简称' }] } },
    }))
    const run = createBangumiKomga({ requestMetadata })
    expect(await run('identity', { kind: 'manga', query: '測試作品' })).toMatchObject({
      subject: { id: 123, title: '测试作品', aliases: ['テスト', '测试简称'] },
    })
    expect(await run('identity', { kind: 'manga', query: '同名' })).toMatchObject({ subject: null })
    expect(requestMetadata).toHaveBeenCalledTimes(3)
  })

  it('finds candidates and writes an individually approved series while respecting locked fields', async () => {
    const { run, patchSeries } = fixture()
    expect(await run('search', { kind: 'manga', scope: 'series', query: '測試作品' })).toMatchObject({
      candidates: [{ id: subject.id, nameCn: subject.nameCn }],
      source: 'bangumi-archive', archiveVersion: '2026-11-17T21:04:20Z',
    })
    const preview = await run('preview', seriesInput)
    expect(preview).toMatchObject({ source: 'bangumi-archive', archiveVersion: '2026-11-17T21:04:20Z' })
    expect(preview.changes).toMatchObject({ title: { before: '本地标题', after: '测试作品' } })
    expect(preview.changes).not.toHaveProperty('summary')
    expect(patchSeries).not.toHaveBeenCalled()
    expect(await run('apply', { previewId: preview.previewId })).toMatchObject({ updated: true })
    expect(patchSeries).toHaveBeenCalledOnce()
    expect(patchSeries).toHaveBeenCalledWith({
      title: '测试作品', tags: ['收藏', '奇幻'], links: [
        { label: '来源', url: 'https://example.invalid/source' },
        { label: 'Bangumi', url: 'https://bgm.tv/subject/123' },
      ],
    })
    await expect(run('apply', { previewId: preview.previewId })).rejects.toMatchObject({ code: 'METADATA_PREVIEW_EXPIRED' })
  })

  it('lists books, checks series ownership, and updates a single novel volume without reordering it', async () => {
    const { run, patchBook } = fixture()
    expect(await run('books', { seriesId: 'series-a' })).toMatchObject({ books: [{ id: 'book-a', number: '1' }] })
    const input = { ...seriesInput, kind: 'novel', scope: 'book', bookId: 'book-a' }
    await expect(run('preview', { ...input, seriesId: 'other' })).rejects.toMatchObject({ code: 'BOOK_SERIES_MISMATCH' })
    const preview = await run('preview', input)
    await run('apply', { previewId: preview.previewId })
    expect(patchBook).toHaveBeenCalledWith({
      summary: '本卷简介', authors: [{ name: '译者', role: 'translator' }, { name: '作者', role: 'writer' }],
      links: [{ label: 'Bangumi', url: 'https://bgm.tv/subject/123' }],
    })
  })

  it('rejects stale previews, conflicting manual links, and upstream failures', async () => {
    const { run, state, adapterFetch, patchSeries } = fixture()
    const preview = await run('preview', seriesInput)
    state.title = '其他人修改的书名'
    await expect(run('apply', { previewId: preview.previewId })).rejects.toMatchObject({ code: 'METADATA_CHANGED' })
    state.links.push({ label: 'cbl', url: 'https://bgm.tv/subject/999' })
    await expect(run('preview', seriesInput)).rejects.toMatchObject({ code: 'BANGUMI_LINK_CONFLICT' })
    adapterFetch.mockRejectedValueOnce(new Error('connection failed'))
    await expect(run('search', { ...seriesInput, query: '测试' })).rejects.toMatchObject({ code: 'BANGUMIKOMGA_UNAVAILABLE' })
    expect(patchSeries).not.toHaveBeenCalled()
  })

  it('filters candidates and enforces library types, locked metadata and a fresh preview', async () => {
    const { komga, patchSeries, state } = fixture()
    Object.assign(state, { titleSort: '保持排序', titleSortLock: true, genres: ['冒险'] })
    let options = { ...defaultScrapeOptions, minimumScore: 80, sortTitle: true, addLocalVersion: true,
      libraries: [{ id: 'library-a', kind: 'manga' }] }
    const requestMetadata = vi.fn(async (action, params) => ({ status: 200, payload: action === 'search'
      ? { candidates: [{ ...subject, score: 79 }, { ...subject, id: 124, score: 80 }, { ...subject, id: 125 }] }
      : { subject, metadata: { titleSort: 'C系列', localVersion: '东立' }, params } }))
    const run = createBangumiKomga({ komga: () => komga, getOptions: () => options, requestMetadata })
    expect(await run('search', { ...seriesInput, query: '测试' })).toMatchObject({ candidates: [{ id: 124, score: 80 }] })
    await expect(run('preview', { ...seriesInput, kind: 'novel' })).rejects.toMatchObject({ code: 'SCRAPE_LIBRARY_EXCLUDED' })
    expect(requestMetadata).toHaveBeenCalledTimes(1)
    const preview = await run('preview', seriesInput)
    expect(requestMetadata).toHaveBeenLastCalledWith('metadata', {
      kind: 'manga', scope: 'series', subjectId: 123, sortTitle: true, addLocalVersion: true, localName: '系列',
    })
    expect(preview.changes).not.toHaveProperty('titleSort')
    expect(preview.changes.genres).toEqual({ before: ['冒险'], after: ['冒险', '东立'] })
    options = { ...options, minimumScore: 81 }
    await expect(run('apply', { previewId: preview.previewId })).rejects.toMatchObject({ code: 'SCRAPE_OPTIONS_CHANGED' })
    expect(patchSeries).not.toHaveBeenCalled()
    Object.assign(state, { titleSortLock: false })
    const renewed = await run('preview', seriesInput)
    await run('apply', { previewId: renewed.previewId })
    expect(patchSeries).toHaveBeenCalledWith(expect.objectContaining({ titleSort: 'C系列', genres: ['冒险', '东立'] }))
  })

  it('adds covers only after confirmation and preserves existing uploaded posters', async () => {
    const { komga, posters, upload, state, patchSeries, patchBook } = fixture()
    const coverUrl = 'https://lain.bgm.tv/pic/cover/l/ab/cd/123_a1b2c.jpg'
    const options = { ...defaultScrapeOptions, seriesCover: true, bookCover: true }
    let source = 'bangumi-live'
    let cover = coverUrl
    const requestMetadata = vi.fn(async () => ({ status: 200, payload: { subject, metadata: {}, source, coverUrl: cover } }))
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe(coverUrl)
      expect(init.redirect).toBe('error')
      expect(init.headers).not.toHaveProperty('authorization')
      return new Response('test-cover', { headers: { 'content-type': 'image/jpeg' } })
    })
    const run = createBangumiKomga({ komga: () => komga, getOptions: () => options, requestMetadata, fetchImpl })
    state.links.push({ label: 'Bangumi', url: 'https://bgm.tv/subject/123' })
    const preview = await run('preview', seriesInput)
    expect(preview).toMatchObject({ changes: {}, cover: { status: 'pending', url: coverUrl } })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(await run('apply', { previewId: preview.previewId })).toMatchObject({ updated: true, cover: { status: 'applied' } })
    expect(upload).toHaveBeenCalledWith('http://komga:25600/api/v1/series/series-a/thumbnails?selected=true', 'image/jpeg', 10)
    expect(patchSeries).not.toHaveBeenCalled()

    const bookInput = { ...seriesInput, scope: 'book', bookId: 'book-a' }
    const book = await run('preview', bookInput)
    posters.push('USER_UPLOADED')
    expect(await run('apply', { previewId: book.previewId })).toMatchObject({ updated: true, cover: { status: 'skipped' } })
    expect(upload).toHaveBeenCalledOnce()
    expect(patchBook).toHaveBeenCalledOnce()
    expect(await run('preview', seriesInput)).toMatchObject({ previewId: null, cover: { status: 'skipped' } })
    source = 'bangumi-archive'
    expect(await run('preview', seriesInput)).toMatchObject({ previewId: null, cover: { status: 'unavailable' } })
    source = 'bangumi-live'
    cover = 'https://example.invalid/pic/cover/l/123.jpg'
    expect(await run('preview', seriesInput)).toMatchObject({ previewId: null, cover: { status: 'unavailable' } })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('uses the configured Bangumi proxy for live cover downloads through the worker', async () => {
    const { komga, state, upload } = fixture()
    state.links.push({ label: 'Bangumi', url: 'https://bgm.tv/subject/123' })
    const coverUrl = 'https://lain.bgm.tv/pic/cover/l/123.jpg'
    const fetchImpl = vi.fn()
    const requestMetadata = vi.fn(async (operation: string) => ({ status: 200, payload: operation === 'cover'
      ? { data: Buffer.from('test-cover').toString('base64'), mime: 'image/jpeg' }
      : { subject, metadata: {}, source: 'bangumi-live', coverUrl },
    }))
    const run = createBangumiKomga({
      komga: () => komga, getOptions: () => ({ ...defaultScrapeOptions, seriesCover: true }),
      getBangumiProxy: () => 'http://proxy.example:7890', requestMetadata, fetchImpl,
    })
    const preview = await run('preview', seriesInput)
    expect(await run('apply', { previewId: preview.previewId })).toMatchObject({ updated: true, cover: { status: 'applied' } })
    expect(requestMetadata).toHaveBeenLastCalledWith('cover', { url: coverUrl })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(upload).toHaveBeenCalledOnce()
  })

  it('reports no update when a cover-only upload fails', async () => {
    const { komga, state, upload } = fixture()
    state.links.push({ label: 'Bangumi', url: 'https://bgm.tv/subject/123' })
    const scanAfterApply = vi.fn()
    const run = createBangumiKomga({
      komga: () => komga, scanAfterApply, getOptions: () => ({ ...defaultScrapeOptions, seriesCover: true }),
      requestMetadata: async () => ({ status: 200, payload: {
        subject, metadata: {}, source: 'bangumi-live', coverUrl: 'https://lain.bgm.tv/pic/cover/l/123.jpg',
      } }),
      fetchImpl: async () => new Response('not an image', { headers: { 'content-type': 'text/html' } }),
    })
    const preview = await run('preview', seriesInput)
    expect(await run('apply', { previewId: preview.previewId })).toMatchObject({ updated: false, cover: { status: 'failed' } })
    expect(scanAfterApply).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })

  it('enforces both settings for existing metadata previews and keeps scan failure separate from writing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-metadata-preferences-'))
    const tokenFile = path.join(dir, 'token')
    const token = 'studio_metadata_' + 'a'.repeat(43)
    const { komga, adapterFetch, patchSeries, scan } = fixture()
    const preferences = { scrapeEnabled: true, refreshMode: 'after-sync' }
    await writeFile(tokenFile, token, { mode: 0o600 })
    vi.stubGlobal('fetch', adapterFetch)
    try {
      const api = createApi({}, {
        bangumiKomgaUrl: 'http://bangumikomga:8091', metadataTokenFile: tokenFile,
        integrations: { client: komga, preferences },
      }, { warn() {} })
      async function call(action: string, body: object) {
        const req = {
          method: 'POST', headers: { authorization: `Bearer ${token}` },
          async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
        }
        const res = {
          status: 0, body: '',
          writeHead(code: number) { this.status = code },
          end(body: string) { this.body = body },
        }
        await api(req, res, new URL('/api/komga/metadata/' + action, 'http://studio.local'))
        return { status: res.status, body: JSON.parse(res.body) }
      }
      const first = await call('preview', seriesInput)
      preferences.scrapeEnabled = false
      expect(await call('apply', { previewId: first.body.previewId })).toMatchObject({
        status: 403, body: { error: { code: 'BANGUMIKOMGA_DISABLED' } },
      })
      expect(patchSeries).not.toHaveBeenCalled()
      expect(scan).not.toHaveBeenCalled()
      preferences.scrapeEnabled = true
      expect(await call('apply', { previewId: first.body.previewId })).toMatchObject({
        status: 200, body: { updated: true, scan: { accepted: false, skipped: true } },
      })
      expect(scan).not.toHaveBeenCalled()

      preferences.refreshMode = 'after-sync-or-scrape'
      const book = await call('preview', { ...seriesInput, kind: 'novel', scope: 'book', bookId: 'book-a' })
      expect(await call('apply', { previewId: book.body.previewId })).toMatchObject({
        status: 200, body: { updated: true, scan: { accepted: true } },
      })
      expect(scan).toHaveBeenCalledOnce()
      scan.mockImplementationOnce(() => new Response(null, { status: 403 }))
      const second = await call('preview', seriesInput)
      expect(await call('apply', { previewId: second.body.previewId })).toMatchObject({
        status: 200, body: { updated: true, scan: { accepted: false, message: expect.stringContaining('管理员权限') } },
      })
      expect(patchSeries).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('separates the metadata bearer from existing Studio access', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-metadata-'))
    const tokenFile = path.join(dir, 'token')
    const token = 'studio_metadata_' + 'a'.repeat(43)
    await writeFile(tokenFile, token, { mode: 0o600 })
    try {
      const logger = { warn() {} }
      const api = createApi({}, {
        token: 'general-fixture-key', bangumiKomgaUrl: 'http://bangumikomga:8091', metadataTokenFile: tokenFile,
        integrations: { authorizeDsh: (req: { headers: { authorization: string } }) => req.headers.authorization === 'Bearer read-fixture' },
      }, logger)
      async function invoke(route: string, bearer: string, method = 'POST') {
        const request = {
          method, headers: { authorization: `Bearer ${bearer}` },
          async *[Symbol.asyncIterator]() { yield Buffer.from('{}') },
        }
        const response = {
          status: 0, body: '',
          writeHead(status: number) { this.status = status },
          end(body: string) { this.body = body },
        }
        await api(request, response, new URL(route, 'http://studio.local'))
        return { status: response.status, code: JSON.parse(response.body).error.code }
      }
      const preview = '/api/komga/metadata/preview'
      expect(await invoke(preview, 'read-fixture')).toEqual({ status: 403, code: 'METADATA_AUTH_REQUIRED' })
      expect(await invoke(preview, 'general-fixture-key')).toEqual({ status: 403, code: 'METADATA_AUTH_REQUIRED' })
      expect(await invoke(preview, token)).toEqual({ status: 400, code: 'INVALID_METADATA_TYPE' })
      expect(await invoke('/api/library', token, 'GET')).toEqual({ status: 401, code: 'UNAUTHORIZED' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
