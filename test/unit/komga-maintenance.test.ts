import { describe, expect, it, vi } from 'vitest'
import { createApi } from '../../server/api.mjs'
import { defaultScrapeOptions } from '../../server/scrape-options.mjs'

const libraryId = 'manga'
const seriesPath = '/api/komga/maintenance'
const target = (title: string) => ({ title, summary: '原有简介', summaryLock: true, links: [] })

function fixture() {
  const records = new Map([
    ['exact', target('無職轉生')],
    ['linked', { ...target('已关联'), links: [{ label: 'cbl', url: 'https://bgm.tv/subject/321' }] }],
    ['ambiguity', target('同名作品')],
    ['weak', target('低分作品')],
  ])
  const events: string[] = []
  const series = vi.fn(async ({ page }: { page: number }) => ({
    content: [...records].slice(page * 2, page * 2 + 2).map(([id, value]) => ({ id, title: value.title, libraryId })),
    page: { number: page, totalPages: 2, last: page === 1 },
  }))
  const client = {
    async libraries() { return { libraries: [{ id: libraryId, name: '漫画' }] } },
    series,
    async metadataTarget(_scope: string, id: string) {
      return { id, name: id, seriesId: id, libraryId, metadata: records.get(id) }
    },
    patchMetadata: vi.fn(async (_scope, id) => { events.push(id) }),
    scanLibrary: vi.fn(async (id) => { events.push('scan:' + id) }),
  }
  const request = vi.fn(async (operation, args) => {
    const subject = { id: 101, name: '無職転生', nameCn: '无职转生', score: 100 }
    if (operation === 'search') {
      if (args.query === '同名作品') return {
        status: 200, payload: { candidates: [
          { id: 102, name: args.query, score: 100 }, { id: 103, name: args.query, score: 75 },
        ] },
      }
      if (args.query === '低分作品') return {
        status: 200, payload: { candidates: [{ id: 104, name: args.query, score: 60 }] },
      }
      return { status: 200, payload: { candidates: [subject] } }
    }
    return { status: 200, payload: { subject, metadata: { title: subject.nameCn, summary: 'Bangumi 简介' } } }
  })
  const preferences = {
    scrapeEnabled: true,
    refreshMode: 'after-sync-or-scrape',
    scrapeOptions: { ...defaultScrapeOptions, minimumScore: 80, libraries: [{ id: libraryId, kind: 'manga' }] },
  }
  const api = createApi({}, {
    token: 'fixture-admin-api-token',
    auth: {
      async handle() { return false },
      sessionAllowed(req: { headers: { cookie?: string } }) { return req.headers.cookie === 'fixture-session' },
    },
    bangumiWorker: { request },
    integrations: { client, preferences, authorizeDsh: () => false, handle: async () => false },
  }, { warn() {} }, {}, client)
  async function call(method: string, body?: object, auth = 'session', contentType = 'application/json') {
    const req = {
      method,
      headers: { 'content-type': contentType, ...(auth === 'session' ? { cookie: 'fixture-session' }
        : auth === 'token' ? { 'x-ln-token': 'fixture-admin-api-token' } : {}) },
      async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) },
    }
    const res = {
      status: 0, body: '',
      writeHead(code: number) { this.status = code },
      end(content: string) { this.body = content },
    }
    await api(req, res, new URL(seriesPath + '?libraryId=' + libraryId, 'http://studio.local'))
    return { status: res.status, body: JSON.parse(res.body) }
  }
  async function finish() {
    return vi.waitFor(async () => {
      const { body } = await call('GET')
      expect(body.job.state).toBe('finished')
      return body.job
    })
  }
  return { call, finish, request, client, records, preferences, events }
}

describe('Komga dashboard maintenance', () => {
  it('writes only a unique, eligible series and requests a single scan after all pages', async () => {
    const { call, finish, request, client, events } = fixture()
    expect(await call('POST', { libraryId }, 'none')).toMatchObject({ status: 401 })
    expect(await call('POST', { libraryId }, 'token')).toMatchObject({ status: 403 })
    expect(await call('POST', { libraryId }, 'session', 'text/plain')).toMatchObject({ status: 415 })
    expect(await call('POST', { libraryId: 'excluded' })).toMatchObject({ status: 403 })
    expect(await call('POST', { libraryId })).toMatchObject({ status: 202, body: { job: { state: 'running' } } })
    expect(await call('POST', { libraryId })).toMatchObject({ status: 409 })
    const job = await finish()
    expect(job).toMatchObject({ updated: 1, skipped: 3, checked: 4, total: 4, failed: 0, scan: { accepted: true }, error: null })
    expect(job.issues.map((issue: { message: string }) => issue.message)).toEqual([
      '已有 Bangumi 关联', '有多个同名条目', '匹配分数低于刮削设置要求',
    ])
    expect(client.series.mock.calls.map(([input]) => input.page)).toEqual([0, 1])
    expect(client.patchMetadata).toHaveBeenCalledExactlyOnceWith('series', 'exact', {
      title: '无职转生', links: [{ label: 'Bangumi', url: 'https://bgm.tv/subject/101' }],
    })
    expect(request.mock.calls.every(([, args]) => args.kind === 'manga' && args.scope === 'series')).toBe(true)
    expect(events).toEqual(['exact', 'scan:manga'])
  })

  it('reports an upstream outage and never turns a failed scan into success', async () => {
    const { call, finish, request, client } = fixture()
    request.mockResolvedValueOnce({ status: 502, payload: { error: { code: 'BANGUMI_CONNECTION_FAILED', message: 'Bangumi 无法连接。' } } })
    client.scanLibrary.mockRejectedValueOnce(new Error('upstream unavailable'))
    await call('POST', { libraryId })
    expect(await finish()).toMatchObject({
      updated: 0, failed: 1, checked: 1, total: 4, error: 'Bangumi 无法连接。', scan: { accepted: false },
    })
    expect(client.patchMetadata).not.toHaveBeenCalled()
    expect(client.scanLibrary).toHaveBeenCalledOnce()
  })

  it('skips a series removed during the job, continues checking, and scans the library', async () => {
    const { call, finish, client } = fixture()
    const original = client.metadataTarget
    vi.spyOn(client, 'metadataTarget').mockImplementation(async (scope, id) => {
      if (id === 'linked') throw Object.assign(new Error('已移入回收站'), { status: 410, code: 'KOMGA_ITEM_GONE' })
      return original(scope, id)
    })
    await call('POST', { libraryId })
    expect(await finish()).toMatchObject({ checked: 4, skipped: 3, failed: 0, updated: 1, error: null, scan: { accepted: true } })
    expect(client.series).toHaveBeenCalledWith(expect.objectContaining({ activeOnly: true }))
  })

  it('stops the job when the administrator disables scraping before writing', async () => {
    const { call, finish, request, client, preferences } = fixture()
    request.mockImplementationOnce(async () => {
      preferences.scrapeEnabled = false
      return { status: 200, payload: { candidates: [{ id: 101, name: '無職轉生', score: 100 }] } }
    })
    await call('POST', { libraryId })
    expect(await finish()).toMatchObject({ updated: 0, scan: { accepted: false }, error: expect.stringContaining('已更改') })
    expect(client.patchMetadata).not.toHaveBeenCalled()
    expect(client.scanLibrary).not.toHaveBeenCalled()
  })
})
