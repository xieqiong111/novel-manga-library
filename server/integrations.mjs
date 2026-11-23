import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteJson } from '../dist/util/json.js'
import { createKomgaClient, normalizeKomgaUrl, readKomgaConfig } from './komga-client.mjs'

import { defaultScrapeOptions, parseScrapeOptions } from './scrape-options.mjs'

const refreshModes = ['manual', 'after-sync', 'after-sync-or-scrape']
const defaultKomgaRefreshMode = 'after-sync'

const settingsPath = '/api/settings/integrations'
const digest = (value) => createHash('sha256').update(value).digest('hex')

function normalizeBangumiProxy(value) {
  if (typeof value !== 'string' || value.length > 512) return null
  const raw = value.trim()
  if (!raw) return ''
  if (!/^https?:\/\//i.test(raw) || /[\\\x00-\x20\x7f]/.test(raw) || /[?#]/.test(raw)) return null
  const authority = raw.slice(raw.indexOf('://') + 3).replace(/\/$/, '')
  if (!authority || /[\/@]/.test(authority)) return null
  try {
    const proxy = new URL(raw)
    return proxy.hostname && proxy.pathname === '/' ? proxy.origin : null
  } catch {
    return null
  }
}

const validBangumiToken = (value) => value === undefined || (typeof value === 'string' && /^[\x21-\x7e]{1,768}$/.test(value))
const validProxyCredential = (value, limit) => value === undefined ||
  (typeof value === 'string' && value.length <= limit && /^[\x20-\x7e\xa0-\xff]*$/.test(value))

function bangumiProxySettings(input, saved = {}) {
  const previousUrl = normalizeBangumiProxy(saved.proxyUrl) ?? ''
  const { proxyUrl, proxyUsername, proxyPassword, clearProxyPassword } = input
  const url = proxyUrl === undefined ? previousUrl : normalizeBangumiProxy(proxyUrl)
  if (url === null || !validProxyCredential(proxyUsername, 256) || proxyUsername?.includes(':') ||
      !validProxyCredential(proxyPassword, 512) || (clearProxyPassword !== undefined && typeof clearProxyPassword !== 'boolean') ||
      (clearProxyPassword && proxyPassword !== undefined)) return null
  const username = proxyUsername ?? (url && url === previousUrl ? saved.proxyUsername ?? '' : '')
  if ((!url && username) || (proxyPassword && (!url || !username))) return null
  const password = clearProxyPassword || !username ? '' : proxyPassword ??
    (url === previousUrl && username === saved.proxyUsername ? saved.proxyPassword ?? '' : '')
  return { proxyUrl: url, ...(username ? { proxyUsername: username } : {}), ...(password ? { proxyPassword: password } : {}) }
}

export function isDshReadRoute(method, pathname) {
  return method === 'GET' && (
    ['/api/health', '/api/library', '/api/library/stats', '/api/tasks', '/api/tasks/files',
      '/api/komga/status', '/api/komga/libraries', '/api/komga/series',
      '/api/manga/downloads', '/api/manga/library', '/api/manga/sources', '/api/manga/health'].includes(pathname)
    || /^\/api\/manga\/[1-9]\d{0,9}\/komga$/.test(pathname)
  )
}

export async function loadIntegrations(settings) {
  if (!settings.auth) return undefined
  const file = path.join(settings.config.dataDir, 'auth', 'integrations.json')
  let saved = {}
  try {
    saved = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const environment = settings.komgaConfig ?? readKomgaConfig()
  const allowed = new Set()
  for (const entry of [environment.url, ...(settings.komgaAllowedUrls ?? [])]) {
    if (!entry) continue
    try { allowed.add(normalizeKomgaUrl(entry)) } catch { /* Ignore an invalid deployment URL. */ }
  }
  const makeClient = (entry) => createKomgaClient({
    ...environment, ...entry, ...(entry ? { username: '', password: '' } : {}),
  })
  const selected = saved.komga && allowed.has(saved.komga.url) ? saved.komga : null
  if (!selected) delete saved.komga
  let client = makeClient(selected ?? undefined)
  let pending = Promise.resolve()
  const update = (action) => {
    const next = pending.then(action)
    pending = next.catch(() => undefined)
    return next
  }
  const managed = Boolean(settings.bangumiKomgaScript && !settings.bangumiKomgaUrl)
  let bangumiTesting = false
  let lastBangumiTest = -Infinity
  const scraperConfigured = Boolean((managed || settings.bangumiKomgaUrl) && settings.metadataTokenFile)
  let archiveAvailable = false
  let archiveVersion = null
  if (managed && settings.bangumiArchiveDir) {
    const root = settings.bangumiArchiveDir
    archiveAvailable = await Promise.all(['subject.jsonlines', 'subject-relations.jsonlines']
      .map((name) => access(path.join(root, name)))).then(() => true, () => false)
    if (archiveAvailable) {
      try {
        const stamp = JSON.parse(await readFile(path.join(root, 'archive_update_time.json'), 'utf8'))
        if (typeof stamp.last_updated === 'string' && Number.isFinite(Date.parse(stamp.last_updated))) {
          archiveVersion = new Date(stamp.last_updated).toISOString()
        }
      } catch { /* A source version is optional. */ }
    }
  }
  const bangumi = () => ({
    sourceMode: ['live', 'archive'].includes(saved.bangumi?.sourceMode)
      ? saved.bangumi.sourceMode : archiveAvailable ? 'archive' : 'live',
    accessToken: saved.bangumi?.accessToken || settings.bangumiAccessToken || '',
    ...(bangumiProxySettings(saved.bangumi ?? {}) ?? { proxyUrl: normalizeBangumiProxy(saved.bangumi?.proxyUrl) ?? '' }),
  })
  const preferences = () => ({
    scrapeEnabled: saved.preferences?.scrapeEnabled ?? scraperConfigured,
    postDownloadRefresh: saved.preferences?.postDownloadRefresh === true,
    postDownloadScrape: saved.preferences?.postDownloadScrape === true,
    refreshMode: refreshModes.includes(saved.preferences?.refreshMode)
      ? saved.preferences.refreshMode : defaultKomgaRefreshMode,
    scrapeOptions: parseScrapeOptions(saved.preferences?.scrapeOptions) ?? defaultScrapeOptions,
  })
  const status = () => ({
    komga: {
      url: saved.komga?.url || environment.url || [...allowed][0] || '',
      allowedUrls: [...allowed],
      hasKey: Boolean(saved.komga?.apiKey || environment.apiKey),
    },
    preferences: { ...preferences(), scraperConfigured },
    bangumi: {
      managed, archiveAvailable, archiveVersion, sourceMode: bangumi().sourceMode,
      hasAccessToken: Boolean(bangumi().accessToken), hasSavedAccessToken: Boolean(saved.bangumi?.accessToken),
      ...(bangumi().proxyUrl ? { proxyUrl: bangumi().proxyUrl } : {}),
      ...(bangumi().proxyUsername ? { proxyUsername: bangumi().proxyUsername, hasProxyPassword: Boolean(bangumi().proxyPassword) } : {}),
    },
    dsh: { active: Boolean(saved.dsh?.digest), createdAt: saved.dsh?.createdAt ?? null },
  })

  return {
    get client() { return client },
    get preferences() { return preferences() },
    get bangumi() { return bangumi() },
    get bangumiArchiveAvailable() { return archiveAvailable },
    authorizeDsh(req) {
      const key = /^Bearer (studio_dsh_[A-Za-z0-9_-]{43})$/i.exec(String(req.headers.authorization ?? ''))?.[1]
      return Boolean(key && /^[a-f0-9]{64}$/.test(saved.dsh?.digest ?? '')
        && timingSafeEqual(Buffer.from(digest(key), 'hex'), Buffer.from(saved.dsh.digest, 'hex')))
    },
    async handle(req, res, url, { sendJson, sendError, readBody }) {
      if (url.pathname !== settingsPath) return false
      if (!settings.auth.sessionAllowed(req)) {
        sendError(res, 403, 'ADMIN_SESSION_REQUIRED', '请通过浏览器管理员会话管理集成密钥。')
        return true
      }
      if (req.method === 'GET') {
        sendJson(res, 200, status())
        return true
      }
      if (req.method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '请求方法不支持。')
        return true
      }
      if (String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        sendError(res, 415, 'JSON_REQUIRED', '请使用 JSON 提交。')
        return true
      }
      try {
        const {
          action, url: address, apiKey, scrapeEnabled, refreshMode, scrapeOptions, sourceMode, accessToken,
          clearAccessToken, proxyUrl, proxyUsername, proxyPassword, clearProxyPassword, postDownloadRefresh, postDownloadScrape,
        } = await readBody(req)
        const proxyInput = { proxyUrl, proxyUsername, proxyPassword, clearProxyPassword }
        if (action === 'save-komga') {
          let target
          try { target = normalizeKomgaUrl(address) } catch { /* invalid URL */ }
          if (!target || !allowed.has(target)) {
            sendError(res, 400, 'KOMGA_URL_NOT_ALLOWED', '请选择部署时允许的 Komga 地址。')
            return true
          }
          if (typeof apiKey !== 'string' || apiKey.length < 1 || apiKey.length > 512 || !/^[\x21-\x7e]+$/.test(apiKey)) {
            sendError(res, 400, 'INVALID_KOMGA_KEY', '请输入有效的 Komga API Key。')
            return true
          }
          const entry = { url: target, apiKey }
          const tested = makeClient(entry)
          try { await tested.libraries() } catch (error) {
            const message = error.code === 'UPSTREAM_AUTH' || error.status === 401 || error.status === 403
              ? 'Komga 拒绝了这个 API Key。' : 'Komga 连接验证未通过，请检查地址、网络和 API Key。'
            sendError(res, 502, 'KOMGA_TEST_FAILED', message)
            return true
          }
          await update(async () => {
            const next = { ...saved, komga: entry }
            await atomicWriteJson(file, next)
            saved = next
            client = tested
          })
          sendJson(res, 200, status())
        } else if (action === 'save-komga-preferences') {
          if (typeof scrapeEnabled !== 'boolean' || !refreshModes.includes(refreshMode) ||
              [postDownloadRefresh, postDownloadScrape].some((flag) => flag !== undefined && typeof flag !== 'boolean')) {
            sendError(res, 400, 'INVALID_KOMGA_PREFERENCES', '请选择有效的刮削开关和书库刷新方式。')
            return true
          }
          const options = scrapeOptions === undefined ? undefined : parseScrapeOptions(scrapeOptions)
          if (options === null || (!managed && options &&
              (options.sortTitle || options.addLocalVersion || options.seriesCover || options.bookCover))) {
            sendError(res, 400, 'INVALID_SCRAPE_OPTIONS', '请检查匹配分数、书库规则和内置刮削开关。')
            return true
          }
          await update(async () => {
            const next = { ...saved, preferences: {
              scrapeEnabled, refreshMode, scrapeOptions: options ?? preferences().scrapeOptions,
              postDownloadRefresh: postDownloadRefresh ?? preferences().postDownloadRefresh,
              postDownloadScrape: postDownloadScrape ?? preferences().postDownloadScrape,
            } }
            await atomicWriteJson(file, next)
            saved = next
          })
          sendJson(res, 200, status())
        } else if (action === 'test-bangumi-connection') {
          if (!managed || !settings.bangumiWorker) {
            sendError(res, 503, 'BANGUMIKOMGA_UNAVAILABLE', '当前部署的 Bangumi 服务暂不可用。')
            return true
          }
          const testedProxy = bangumiProxySettings(proxyInput, bangumi())
          if (testedProxy === null || !validBangumiToken(accessToken)) {
            sendError(res, 400, 'INVALID_BANGUMI_SETTINGS', '请检查 Bangumi 令牌、HTTP(S) 代理地址和账号密码。')
            return true
          }
          if (bangumiTesting || Date.now() - lastBangumiTest < 3000) {
            sendError(res, 429, 'BANGUMI_TEST_BUSY', '请稍后再测试 Bangumi 连接。')
            return true
          }
          lastBangumiTest = Date.now()
          bangumiTesting = true
          try {
            const reply = await settings.bangumiWorker.request('test', {}, {
              sourceMode: 'live', accessToken: accessToken ?? bangumi().accessToken, ...testedProxy,
            })
            const result = reply.payload
            if (reply.status !== 200) {
              const upstream = result?.error
              const allowed = /^BANGUMI_[A-Z_]+$/.test(upstream?.code ?? '') && typeof upstream?.message === 'string'
              sendError(res, [400, 422, 429, 502, 503, 504].includes(reply.status) ? reply.status : 502,
                allowed ? upstream.code : 'BANGUMI_TEST_FAILED',
                allowed ? upstream.message : 'Bangumi 连接未通过。')
            } else if (result?.connected === true && [true, null].includes(result.authenticated) &&
                       result.viaProxy === Boolean(testedProxy.proxyUrl) && Number.isInteger(result.elapsedMs) && result.elapsedMs >= 0) {
              const { connected, authenticated, viaProxy, elapsedMs } = result
              sendJson(res, 200, { connected, authenticated, viaProxy, elapsedMs })
            } else {
              sendError(res, 502, 'BANGUMI_TEST_FAILED', 'Bangumi 测试返回了无法识别的数据。')
            }
          } catch (error) {
            const timedOut = error.code === 'BANGUMIKOMGA_TIMEOUT'
            sendError(res, timedOut ? 504 : 503, timedOut ? 'BANGUMI_TIMEOUT' : 'BANGUMIKOMGA_UNAVAILABLE',
              timedOut ? 'Bangumi 连接测试超时。' : '当前部署的 Bangumi 服务暂不可用。')
          } finally {
            bangumiTesting = false
          }
        } else if (action === 'save-bangumi-settings') {
          if (!managed) {
            sendError(res, 409, 'BANGUMI_SETTINGS_EXTERNAL', '此部署没有内置 Bangumi 配置。')
            return true
          }
          if (!['live', 'archive'].includes(sourceMode) || (sourceMode === 'archive' && !archiveAvailable) ||
              (clearAccessToken !== undefined && typeof clearAccessToken !== 'boolean') ||
              !validBangumiToken(accessToken) || (clearAccessToken && accessToken !== undefined)) {
            sendError(res, 400, 'INVALID_BANGUMI_SETTINGS', '请选择可用的数据源，并检查 Bangumi 令牌。')
            return true
          }
          await update(async () => {
            const proxy = bangumiProxySettings(proxyInput, bangumi())
            if (!proxy) throw Object.assign(new Error('请检查 HTTP(S) 代理地址和账号密码。'), {
              status: 400, code: 'INVALID_BANGUMI_SETTINGS',
            })
            const token = clearAccessToken ? '' : (accessToken ?? saved.bangumi?.accessToken)
            const next = { ...saved, bangumi: {
              sourceMode, ...(token ? { accessToken: token } : {}), ...(proxy.proxyUrl ? proxy : {}),
            } }
            await atomicWriteJson(file, next)
            saved = next
          })
          sendJson(res, 200, status())
        } else if (action === 'rotate-dsh' || action === 'revoke-dsh') {
          const token = action === 'rotate-dsh' ? 'studio_dsh_' + randomBytes(32).toString('base64url') : null
          await update(async () => {
            const next = { ...saved, dsh: token ? { digest: digest(token), createdAt: new Date().toISOString() } : null }
            await atomicWriteJson(file, next)
            saved = next
          })
          sendJson(res, 200, { ...status(), ...(token ? { token } : {}) })
        } else {
          sendError(res, 400, 'INVALID_ACTION', '未知的集成设置操作。')
        }
      } catch (error) {
        if (typeof error.status === 'number' && error.status < 500) sendError(res, error.status, error.code, error.message)
        else sendError(res, 503, 'SETTINGS_UNAVAILABLE', '集成设置暂时无法保存。')
      }
      return true
    },
  }
}
