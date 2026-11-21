import { describe, expect, it, vi } from 'vitest'
import { createApi } from '../../server/api.mjs'
import { createMangaApi } from '../../server/manga-api.mjs'
import { SuwayomiError } from '../../server/suwayomi-client.mjs'

function request(method: string, pathname: string, options: { token?: string; contentType?: string; body?: object; ip?: string } = {}) {
  return {
    method,
    headers: {
      ...(options.token ? { 'x-ln-token': options.token } : {}),
      ...(options.contentType ? { 'content-type': options.contentType } : {}),
    },
    socket: { remoteAddress: options.ip ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (options.body !== undefined) yield Buffer.from(JSON.stringify(options.body))
    },
    url: pathname,
  }
}

function responseSink() {
  return {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers: Record<string, string>) {
      this.status = status
      this.headers = headers
    },
    end(body = '') {
      this.body = String(body)
    },
    json() { return JSON.parse(this.body) },
  }
}

describe('Suwayomi BFF routes', () => {
  const logger = { warn: vi.fn(), error: vi.fn() }

  it('shares the BFF token gate and serves manga routes only under the exact prefix', async () => {
    const client = { sources: vi.fn(async () => ({ sources: [{ id: '0', name: 'Local', lang: 'localsourcelang' }] })) }
    const api = createApi({ suwayomi: client }, { token: 'test-secret', corsOrigin: '', allowDelete: false }, logger as never, client as never)
    const unauthorized = responseSink()
    await api(request('GET', '/api/manga/sources') as never, unauthorized as never, new URL('http://localhost/api/manga/sources'))
    expect(unauthorized.status).toBe(401)
    expect(client.sources).not.toHaveBeenCalled()

    const authorized = responseSink()
    await api(request('GET', '/api/manga/sources', { token: 'test-secret' }) as never, authorized as never, new URL('http://localhost/api/manga/sources'))
    expect(authorized.status).toBe(200)
    expect(authorized.json().sources[0].id).toBe('0')

    const prefixAlias = responseSink()
    await api(request('GET', '/api/mangasearch', { token: 'test-secret' }) as never, prefixAlias as never, new URL('http://localhost/api/mangasearch'))
    expect(prefixAlias.status).toBe(404)

    const malformed = responseSink()
    await api(request('GET', '/api/manga/%ZZ', { token: 'test-secret' }) as never, malformed as never, new URL('http://localhost/api/manga/%ZZ'))
    expect(malformed.status).toBe(400)
    expect(malformed.json().error.code).toBe('INVALID_PATH')
  })

  it('requires Studio authentication before proxying saved Suwayomi credentials', async () => {
    const client = { sources: vi.fn(async () => ({ sources: [] })) }
    const settings = { token: '', corsOrigin: '', allowDelete: false, mangaCredentialsConfigured: true }
    const api = createApi({ suwayomi: client, dartAvailable: true }, settings, logger as never, client as never)
    const blocked = responseSink()
    await api(request('GET', '/api/manga/sources') as never, blocked as never, new URL('http://localhost/api/manga/sources'))
    expect(blocked.status).toBe(503)
    expect(blocked.json().error.code).toBe('BFF_AUTH_REQUIRED')
    expect(client.sources).not.toHaveBeenCalled()

    const novel = responseSink()
    await api(request('GET', '/api/health') as never, novel as never, new URL('http://localhost/api/health'))
    expect(novel.status).toBe(200)
    expect(novel.json().dart).toBe(true)
  })

  it('keeps queue reads available while a full book shelf loads covers', async () => {
    const client = {
      cover: vi.fn(async () => ({ contentType: 'image/png', body: Buffer.alloc(8) })),
      tasks: vi.fn(async () => ({ queue: [] })),
    }
    const api = createApi({ suwayomi: client }, { token: '', corsOrigin: '', allowDelete: false, mangaCredentialsConfigured: false }, logger as never, client as never)
    for (let index = 1; index <= 120; index++) {
      const pathname = `/api/manga/${index}/cover`
      const cover = responseSink()
      await api(request('GET', pathname) as never, cover as never, new URL(pathname, 'http://localhost'))
      expect(cover.status).toBe(200)
    }
    const queue = responseSink()
    await api(request('GET', '/api/manga/downloads') as never, queue as never, new URL('http://localhost/api/manga/downloads'))
    expect(queue.status).toBe(200)
    expect(client.tasks).toHaveBeenCalledOnce()
  })

  it('requires JSON mutation bodies and confirms the requested library state', async () => {
    const client = {
      setLibrary: vi.fn(async ({ inLibrary }: { inLibrary: boolean }) => ({ id: '1', inLibrary, subscribed: inLibrary })),
    }
    const api = createApi({ suwayomi: client }, { token: '', corsOrigin: '', allowDelete: false }, logger as never, client as never)
    const unsupported = responseSink()
    await api(
      request('POST', '/api/manga/1/subscribe', { contentType: 'text/plain', body: { subscribed: false } }) as never,
      unsupported as never,
      new URL('http://localhost/api/manga/1/subscribe'),
    )
    expect(unsupported.status).toBe(415)
    expect(client.setLibrary).not.toHaveBeenCalled()

    const removed = responseSink()
    await api(
      request('POST', '/api/manga/1/subscribe', { contentType: 'application/json', body: { subscribed: false } }) as never,
      removed as never,
      new URL('http://localhost/api/manga/1/subscribe'),
    )
    expect(removed.status).toBe(200)
    expect(removed.json()).toMatchObject({ inLibrary: false, subscribed: false })
  })

  it('only queues eligible chapters and skips existing files and chapters already covered by an old volume', async () => {
    const download = vi.fn(async () => ({ queued: ['31'], skipped: [], completed: [], unconfirmed: [] }))
    const getVolumes = vi.fn(async () => ({
      archiveMode: 'chapter', chapterCount: 3, volumes: [], chapters: [
        { id: '29', name: '序章', number: null, downloaded: true, filename: '章节 [29].cbz' },
        { id: '30', name: '第2卷 第1话', number: '1', downloaded: true, filename: null, legacyVolume: '第02卷.cbz' },
        { id: '31', name: '第2卷 第2话', number: '2', downloaded: false, filename: null },
      ],
    }))
    const tasks = vi.fn(async () => ({ queue: [{ mangaId: '22', chapterId: '31', state: 'running', percent: 38 }] }))
    const api = createMangaApi({ download, tasks }, undefined, { getVolumes })
    const path = '/api/manga/22/komga'
    const url = new URL(path, 'http://localhost')
    const invoke = async (method: string, body?: object) => {
      const res = responseSink()
      await api(request(method, path, { contentType: 'application/json', body }), res, url)
      return res
    }
    expect((await invoke('GET')).json()).toMatchObject({ available: true, archiveMode: 'chapter', chapters: [
      { id: '29', filename: '章节 [29].cbz', state: 'archived' },
      { id: '30', filename: null, legacyVolume: '第02卷.cbz', state: 'in_legacy_volume' },
      { id: '31', filename: null, state: 'downloading', task: { percent: 38 } },
    ] })
    expect((await invoke('POST', { volume: 2 })).status).toBe(409)
    expect((await invoke('POST', { chapterIds: ['99'] })).status).toBe(409)
    expect(download).not.toHaveBeenCalled()
    expect((await invoke('POST', { chapterIds: ['29', '30', '31'] })).json()).toMatchObject({
      queued: ['31'], skipped: ['29', '30'], archived: [{ chapterId: '29', filename: '章节 [29].cbz' }],
    })
    expect(download).toHaveBeenCalledExactlyOnceWith({ mangaId: '22', chapterIds: ['31'] })
    getVolumes.mockRejectedValueOnce(new SuwayomiError('VOLUME_ARCHIVE_UNAVAILABLE', 'offline', 503))
    expect((await invoke('POST', { chapterIds: ['31'] })).status).toBe(503)
    expect(download).toHaveBeenCalledOnce()
  })

  it('exposes confirmed chapter archives and pending or failed stages through the existing manga archive route', async () => {
    const getVolumes = vi.fn(async () => ({
      archiveMode: 'chapter', volumes: [], chapterCount: 7,
      chapters: [
        { id: '40', name: '第6话', number: '6', downloaded: true, filename: '第006话 [40].cbz' },
        { id: '41', name: '第7话', number: '7', downloaded: false, filename: null },
        { id: '42', name: '第8话', number: '8', downloaded: true, filename: null, archiveFailed: true },
      ],
    }))
    const tasks = vi.fn(async () => ({ queue: [
      { mangaId: '22', chapterId: '41', state: 'running', percent: 63 },
      { mangaId: '23', chapterId: '41', state: 'running', percent: 99 },
    ] }))
    const api = createMangaApi({ tasks }, undefined, { getVolumes })
    const path = '/api/manga/22/komga'
    const res = responseSink()
    await api(request('GET', path, {}), res, new URL('http://localhost' + path + '?chapterIds=40,41,42,99'))
    expect(getVolumes).toHaveBeenCalledWith('22', { chapterIds: ['40', '41', '42', '99'] })
    expect(res.json()).toMatchObject({ archiveMode: 'chapter', missingChapterIds: ['99'], chapters: [
      { id: '40', state: 'archived', task: null, filename: '第006话 [40].cbz' },
      { id: '41', state: 'downloading', task: { percent: 63 } },
      { id: '42', state: 'archive_failed', task: null },
    ] })
    const invalid = responseSink()
    await api(request('GET', path, {}), invalid, new URL('http://localhost' + path + '?volume=2&chapterIds=41'))
    expect(invalid.status).toBe(400)
  })

  it('rate-limits searches per client IP and returns Retry-After', async () => {
    const client = { searchManga: vi.fn(async () => ({ mangas: [], hasNextPage: false, errors: [] })) }
    const api = createApi({ suwayomi: client }, { token: '', corsOrigin: '', allowDelete: false }, logger as never, client as never)

    for (let index = 0; index < 10; index++) {
      const res = responseSink()
      await api(request('GET', '/api/manga/search?query=test', { ip: '192.0.2.8' }) as never, res as never, new URL('http://localhost/api/manga/search?query=test'))
      expect(res.status).toBe(200)
    }
    const limited = responseSink()
    await api(request('GET', '/api/manga/search?query=test', { ip: '192.0.2.8' }) as never, limited as never, new URL('http://localhost/api/manga/search?query=test'))
    expect(limited.status).toBe(429)
    expect(limited.headers['retry-after']).toBe('60')
    expect(client.searchManga).toHaveBeenCalledTimes(10)
  })
})
