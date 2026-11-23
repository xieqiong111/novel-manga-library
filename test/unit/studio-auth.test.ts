import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { openStudioAuth } from '../../server/auth.mjs'
import { createApi } from '../../server/api.mjs'
import { studioJobRoute } from '../../server/studio-jobs.mjs'

it('protects initial setup, persists sessions, enforces expiry and revokes logout', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'studio-auth-'))
  const settings = { config: { dataDir }, token: '', secureCookie: true }
  let now = 0
  let auth = openStudioAuth(settings, () => now)
  const handle = () => createApi({ dartAvailable: true }, { ...settings, auth }, { warn() {} })
  let api = handle()
  async function send(method: string, target: string, body?: object, cookie = '', origin?: string) {
    const headers = new Headers()
    let status = 0
    let payload = ''
    const req = {
      method, socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'localhost', 'content-type': 'application/json', cookie, origin },
      async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) },
    }
    const res = {
      setHeader(name: string, value: string) { headers.set(name, value) },
      writeHead(code: number) { status = code },
      end(value: string) { payload = value },
    }
    await api(req, res, new URL('/api' + target, 'http://localhost'))
    return new Response(payload, { status, headers })
  }

  try {
    const get = (target: string, cookie = '', origin?: string) => send('GET', target, undefined, cookie, origin)
    const post = (target: string, body: object, cookie = '', origin?: string) => send('POST', target, body, cookie, origin)
    const setupCode = (await readFile(path.join(dataDir, 'auth', 'setup-code'), 'utf8')).trim()
    const credentials = { username: '管理员', password: 'fixture-admin-long-pass', seconds: 86400 }
    expect(await (await get('/auth/status')).json()).toMatchObject({ enabled: true, needsSetup: true, username: null })
    expect((await get('/health')).status).toBe(401)
    expect((await post('/auth/setup', { ...credentials, setupCode: 'invalid' })).status).toBe(403)
    expect((await post('/auth/setup', { ...credentials, setupCode }, '', 'https://unrelated.invalid')).status).toBe(403)
    const concurrent = await Promise.all([post('/auth/setup', { ...credentials, setupCode }), post('/auth/setup', { ...credentials, setupCode })])
    expect(concurrent.map((r) => r.status).sort()).toEqual([200, 409])
    const created = concurrent.find((r) => r.ok)!
    expect(await created.json()).toMatchObject({ username: credentials.username, expiresAt: 86400000 })
    const header = created.headers.get('set-cookie')!
    expect(header).toMatch(/HttpOnly; SameSite=Strict; Secure; Max-Age=86400/)
    const cookie = header.split(';')[0]
    expect((await get('/health', cookie)).status).toBe(200)
    expect((await get('/health', cookie, 'https://unrelated.invalid')).status).toBe(401)

    auth.close()
    auth = openStudioAuth(settings, () => now)
    api = handle()
    expect((await get('/health', cookie)).status).toBe(200)
    now = 86400000
    expect((await get('/health', cookie)).status).toBe(401)
    expect((await post('/auth/login', { ...credentials, password: 'incorrect' })).status).toBe(401)
    const login = await post('/auth/login', { ...credentials, seconds: 604800 })
    expect(login.status).toBe(200)
    const newCookie = login.headers.get('set-cookie')!.split(';')[0]
    expect((await post('/auth/logout', {}, newCookie)).status).toBe(200)
    expect((await get('/health', newCookie)).status).toBe(401)
  } finally {
    auth.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

it('scopes the DSH credential and never returns stored secrets', async () => {
  const { loadIntegrations } = await import('../../server/integrations.mjs')
  const { hash } = await import('node:crypto')
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'studio-integration-'))
  const auth = openStudioAuth({ config: { dataDir }, setupCode: 'fixture-secret-setup' })
  try {
    const archive = path.join(dataDir, 'archive')
    await mkdir(archive)
    await writeFile(path.join(archive, 'subject.jsonlines'), '')
    await writeFile(path.join(archive, 'subject-relations.jsonlines'), '')
    await writeFile(path.join(archive, 'archive_update_time.json'), '{"last_updated":"2026-11-17T21:04:20Z"}')
    const probe = vi.fn(async () => ({
      status: 200, payload: { connected: true, authenticated: true, viaProxy: true, elapsedMs: 37 },
    }))
    const settings = {
      config: { dataDir }, auth, token: '', komgaAllowedUrls: ['http://komga:25600'],
      bangumiKomgaScript: '/fixture/converter.py', bangumiArchiveDir: archive, bangumiWorker: { request: probe },
    }
    const integrations = await loadIntegrations(settings)
    const api = createApi({ dartAvailable: true }, { ...settings, integrations }, { warn() {} })
    async function send(method: string, target: string, data?: object, cookie = '', bearer = '') {
      const headers = new Headers()
      let status = 0
      let payload = ''
      const req = { method, socket: { remoteAddress: '127.0.0.1' }, headers: {
        host: 'localhost', 'content-type': 'application/json', cookie, authorization: bearer ? 'Bearer ' + bearer : '',
      }, async *[Symbol.asyncIterator]() { if (data) yield Buffer.from(JSON.stringify(data)) } }
      const res = { setHeader(name: string, value: string) { headers.set(name, value) },
        writeHead(code: number) { status = code }, end(value: string) { payload = value } }
      await api(req, res, new URL(target, 'http://localhost'))
      return new Response(payload, { status, headers })
    }
    const setup = await send('POST', '/api/auth/setup', { username: 'owner', password: 'fixture-admin-pass', setupCode: 'fixture-secret-setup' })
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]
    const route = '/api/settings/integrations'
    const before = await (await send('GET', route, undefined, cookie)).json()
    const defaults = { minimumScore: 0, libraries: [], sortTitle: false, addLocalVersion: false, seriesCover: false, bookCover: false }
    expect(before.preferences).toEqual({
      scrapeEnabled: false, scraperConfigured: false, refreshMode: 'after-sync', scrapeOptions: defaults,
      postDownloadRefresh: false, postDownloadScrape: false,
    })
    expect(before.bangumi).toEqual({
      managed: true, archiveAvailable: true, archiveVersion: '2026-11-17T21:04:20.000Z',
      sourceMode: 'archive', hasAccessToken: false, hasSavedAccessToken: false,
    })
    const bangumi = { action: 'save-bangumi-settings', sourceMode: 'live',
      accessToken: 'fake-bangumi.credential', proxyUrl: 'http://proxy.example:7890/' }
    const draft = { action: 'test-bangumi-connection', proxyUrl: 'https://draft.example:8443' }
    expect((await send('POST', route, bangumi)).status).toBe(401)
    const configured = await (await send('POST', route, bangumi, cookie)).json()
    expect(configured.bangumi).toMatchObject({ sourceMode: 'live', hasSavedAccessToken: true, proxyUrl: 'http://proxy.example:7890' })
    expect(JSON.stringify(configured)).not.toContain(bangumi.accessToken)
    expect((await loadIntegrations(settings))?.bangumi).toEqual({
      sourceMode: 'live', accessToken: bangumi.accessToken, proxyUrl: 'http://proxy.example:7890',
    })
    const credentials = { proxyUsername: 'fixture@example', proxyPassword: 'secret @: + / ?' }
    const withProxyPassword = await (await send('POST', route, { ...bangumi, ...credentials }, cookie)).json()
    expect(withProxyPassword.bangumi).toMatchObject({ proxyUsername: credentials.proxyUsername, hasProxyPassword: true })
    expect(JSON.stringify(withProxyPassword)).not.toContain(credentials.proxyPassword)
    expect(JSON.stringify(withProxyPassword)).not.toContain('proxyPassword"')
    expect((await loadIntegrations(settings))?.bangumi).toMatchObject(credentials)
    for (const invalid of [
      { proxyUrl: '', ...credentials }, { proxyUsername: '', proxyPassword: 'only-password' },
      { proxyUsername: 'name:colon' }, { proxyPassword: 'newline\nrejected' },
    ]) expect((await send('POST', route, { ...bangumi, ...invalid }, cookie)).status).toBe(400)
    expect((await send('POST', route, draft)).status).toBe(401)
    for (const invalid of ['file:///etc/passwd', 'http://user:password@proxy.example', 'http://proxy.example/path']) {
      expect((await send('POST', route, { ...draft, proxyUrl: invalid }, cookie)).status).toBe(400)
      expect((await send('POST', route, { ...bangumi, proxyUrl: invalid }, cookie)).status).toBe(400)
    }
    expect(probe).not.toHaveBeenCalled()
    const checked = await (await send('POST', route, draft, cookie)).json()
    expect(checked).toEqual({ connected: true, authenticated: true, viaProxy: true, elapsedMs: 37 })
    expect(probe).toHaveBeenCalledExactlyOnceWith('test', {}, {
      sourceMode: 'live', accessToken: bangumi.accessToken, proxyUrl: 'https://draft.example:8443',
    })
    expect((await send('POST', route, draft, cookie)).status).toBe(429)
    const unchanged = await (await send('GET', route, undefined, cookie)).json()
    expect(unchanged.bangumi.proxyUrl).toBe('http://proxy.example:7890')
    expect(unchanged.bangumi).toMatchObject({ proxyUsername: credentials.proxyUsername, hasProxyPassword: true })
    expect(JSON.stringify(unchanged)).not.toContain(bangumi.accessToken)
    const cleared = await (await send('POST', route, { action: bangumi.action, sourceMode: 'archive', clearAccessToken: true }, cookie)).json()
    expect(cleared.bangumi).toMatchObject({
      sourceMode: 'archive', hasAccessToken: false, hasSavedAccessToken: false, proxyUrl: 'http://proxy.example:7890',
      hasProxyPassword: true,
    })
    const removedPassword = await (await send('POST', route,
      { action: bangumi.action, sourceMode: 'archive', clearProxyPassword: true }, cookie)).json()
    expect(removedPassword.bangumi).toMatchObject({ proxyUsername: credentials.proxyUsername, hasProxyPassword: false })
    expect((await loadIntegrations(settings))?.bangumi).not.toHaveProperty('proxyPassword')
    await send('POST', route, { ...bangumi, ...credentials }, cookie)
    const changedAddress = await (await send('POST', route,
      { ...bangumi, proxyUrl: 'https://other.example:8443', proxyUsername: credentials.proxyUsername }, cookie)).json()
    expect(changedAddress.bangumi.hasProxyPassword).toBe(false)
    expect((await loadIntegrations(settings))?.bangumi).not.toHaveProperty('proxyPassword')
    await send('POST', route, { action: bangumi.action, sourceMode: 'archive', proxyUrl: '' }, cookie)
    expect((await loadIntegrations(settings))?.bangumi.proxyUrl).toBe('')
    const preferences = { action: 'save-komga-preferences', scrapeEnabled: true, refreshMode: 'manual' }
    expect((await send('POST', route, preferences)).status).toBe(401)
    expect((await send('POST', route, { ...preferences, scrapeEnabled: 'true' }, cookie)).status).toBe(400)
    expect((await send('POST', route, { ...preferences, refreshMode: 'invalid' }, cookie)).status).toBe(400)
    const options = { ...defaults, minimumScore: 80, libraries: [{ id: 'books-1', kind: 'novel' }], bookCover: true }
    for (const scrapeOptions of [
      { ...options, minimumScore: 101 }, { ...options, libraries: [{ id: '../books', kind: 'manga' }] },
      { ...options, libraries: [...options.libraries, ...options.libraries] }, { ...options, bookCover: 'yes' },
    ]) {
      expect((await send('POST', route, { ...preferences, scrapeOptions }, cookie)).status).toBe(400)
    }
    const automatic = { postDownloadRefresh: true, postDownloadScrape: true }
    const saved = await (await send('POST', route, { ...preferences, scrapeOptions: options, ...automatic }, cookie)).json()
    expect(saved.preferences).toEqual({
      scrapeEnabled: true, scraperConfigured: false, refreshMode: 'manual', scrapeOptions: options, ...automatic,
    })
    const compat = await (await send('POST', route, { ...preferences, refreshMode: 'after-sync' }, cookie)).json()
    expect(compat.preferences.scrapeOptions).toEqual(options)
    expect((await loadIntegrations(settings))?.preferences).toEqual({
      scrapeEnabled: true, refreshMode: 'after-sync', scrapeOptions: options, ...automatic,
    })
    const invalid = await send('POST', route, { action: 'save-komga', url: 'http://unapproved.invalid', apiKey: 'abc' }, cookie)
    expect(invalid.status).toBe(400)
    const first = await (await send('POST', route, { action: 'rotate-dsh' }, cookie)).json()
    expect(first.token).toMatch(/^studio_dsh_/)
    const stored = await readFile(path.join(dataDir, 'auth', 'integrations.json'), 'utf8')
    expect(stored).not.toContain(first.token)
    expect(stored).toContain(hash('sha256', first.token, 'hex'))
    expect(await (await send('GET', route, undefined, cookie)).json()).not.toHaveProperty('token')
    expect((await send('GET', '/api/health', undefined, '', first.token)).status).toBe(200)
    expect((await send('GET', route, undefined, '', first.token)).status).toBe(403)
    expect((await send('POST', route, preferences, '', first.token)).status).toBe(403)
    expect((await send('POST', '/api/tasks', {}, '', first.token)).status).toBe(403)
    const second = await (await send('POST', route, { action: 'rotate-dsh' }, cookie)).json()
    expect((await send('GET', '/api/health', undefined, '', first.token)).status).toBe(401)
    expect((await send('GET', '/api/health', undefined, '', second.token)).status).toBe(200)
    await send('POST', route, { action: 'revoke-dsh' }, cookie)
    expect((await send('GET', '/api/health', undefined, '', second.token)).status).toBe(401)
  } finally {
    auth.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

it('accepts the separate Studio jobs key for job routes only', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-jobs-'))
  const token = 'studio_jobs_' + 'a'.repeat(43)
  const jobTokenFile = path.join(dir, 'jobs.token')
  try {
    await writeFile(jobTokenFile, token, { mode: 0o600 })
    const api = createApi({ dartAvailable: true, tasks: { list: () => [] } }, { jobTokenFile },
      { warn() {} })
    async function request(method: string, route: string, credential = token) {
      let status = 0
      await api({
        method, headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' },
        async *[Symbol.asyncIterator]() { yield Buffer.from('{}') },
      }, { writeHead(code: number) { status = code }, end() {} }, new URL(route, 'http://studio.example'))
      return status
    }
    expect(await request('GET', '/api/tasks')).toBe(200)
    expect(await request('POST', '/api/tasks')).toBe(400)
    expect(await request('GET', '/api/settings/integrations')).toBe(403)
    expect(await request('POST', '/api/auth/setup')).toBe(403)
    expect(await request('DELETE', '/api/library/lib_0123456789abcdef')).toBe(403)
    expect(await request('GET', '/api/tasks', token.slice(0, -1) + 'x')).toBe(403)
    expect(studioJobRoute('GET', '/api/library/lib_0123456789abcdef/file')).toBe(true)
    expect(studioJobRoute('POST', '/api/manga/22/komga')).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
