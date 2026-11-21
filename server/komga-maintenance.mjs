import { MetadataError } from './bangumi-komga.mjs'
import { defaultScrapeOptions } from './scrape-options.mjs'

const path = '/api/komga/maintenance'

export function createKomgaMaintenance({ settings, currentKomga, metadata, scan }) {
  let job = null
  let lastStarted = -Infinity

  function eligibility(libraryId) {
    if (settings.integrations?.preferences?.scrapeEnabled === false) return '请先在刮削设置中启用 Bangumi 刮削。'
    if (!settings.bangumiWorker && !settings.bangumiKomgaUrl) return '当前部署尚未启用 Bangumi 刮削服务。'
    const libraries = settings.integrations?.preferences?.scrapeOptions?.libraries ?? []
    if (libraryId && libraries.length && !libraries.some((rule) => rule.id === libraryId)) {
      return '刮削设置未允许这个 Komga 书库。'
    }
    return null
  }

  function snapshot() {
    return JSON.stringify([
      settings.integrations?.preferences?.scrapeOptions ?? defaultScrapeOptions,
      settings.integrations?.bangumi,
    ])
  }

  async function run(result, client, originalSettings) {
    const { libraryId } = result
    const ensureCurrent = () => {
      if (client !== currentKomga() || eligibility(libraryId) || snapshot() !== originalSettings) {
        throw new MetadataError(409, 'MAINTENANCE_SETTINGS_CHANGED', '刮削或 Komga 配置已更改，本次操作已停止。')
      }
    }
    function note(title, message) {
      if (result.issues.length < 8) result.issues.push({ title, message })
    }

    try {
      const series = new Map()
      // Collect IDs before writing. Updating a title can change its pagination order.
      const size = 50
      let lastPage = 1
      for (let page = 0; page < lastPage; page += 1) {
        ensureCurrent()
        const data = await client.series({ libraryId, page, size })
        if (page === 0) lastPage = data.page.totalPages
        if (data.page.number !== page || data.content.some((item) => item.libraryId !== libraryId)) {
          throw new MetadataError(502, 'KOMGA_SERIES_MISMATCH', 'Komga 返回的系列与所选书库不一致。')
        }
        for (const item of data.content) series.set(item.id, item.title)
        if (data.page.last) break
      }
      result.total = series.size
      result.stage = 'scraping'
      for (const [seriesId, title] of series) {
        ensureCurrent()
        try {
          const outcome = await metadata('auto-series', { libraryId, seriesId }, ensureCurrent)
          if (outcome.cover?.status === 'failed') {
            result.coverFailures += 1
            note(title, outcome.cover.message)
          } else if (outcome.reason) {
            note(title, outcome.reason)
          }
          if (outcome.updated) result.updated += 1
          else if (outcome.cover?.status === 'failed') result.failed += 1
          else result.skipped += 1
        } catch (error) {
          result.failed += 1
          note(title, error?.status ? error.message : '刮削失败。')
          if (error?.code === 'MAINTENANCE_SETTINGS_CHANGED' || error?.status === 429 || !error?.status || error.status >= 500) throw error
        } finally {
          result.checked += 1
        }
      }
    } catch (error) {
      result.error = error?.status ? error.message : '无法继续刮削。'
    }

    result.stage = 'scanning'
    try {
      ensureCurrent()
      result.scan = await scan(client, libraryId)
    } catch (error) {
      result.scan = { accepted: false, message: error?.status ? error.message : 'Komga 未确认扫描请求。' }
    }
    result.state = 'finished'
  }

  return async function handleMaintenance(req, res, url, { sendJson, sendError, readBody }) {
    if (url.pathname !== path) return false
    if (!settings.auth?.sessionAllowed(req)) {
      sendError(res, 403, 'ADMIN_SESSION_REQUIRED', '请通过浏览器管理员会话操作 Komga 书库。')
      return true
    }
    if (req.method === 'GET') {
      sendJson(res, 200, { unavailable: eligibility(url.searchParams.get('libraryId')), job })
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
      const { libraryId } = await readBody(req)
      if (typeof libraryId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(libraryId)) {
        throw new MetadataError(400, 'INVALID_LIBRARY', '请选择有效的 Komga 书库。')
      }
      const unavailable = eligibility(libraryId)
      if (unavailable) throw new MetadataError(403, 'MAINTENANCE_UNAVAILABLE', unavailable)
      if (job?.state === 'running') throw new MetadataError(409, 'MAINTENANCE_BUSY', '已有一项刮削与刷新正在运行。')
      if (Date.now() - lastStarted < 15_000) throw new MetadataError(429, 'MAINTENANCE_RATE_LIMITED', '请稍后再试。')
      const client = currentKomga()
      const configuration = snapshot()
      const { libraries } = await client.libraries()
      const library = libraries.find((item) => item.id === libraryId)
      if (!library) throw new MetadataError(404, 'LIBRARY_NOT_FOUND', '所选 Komga 书库不可访问。')
      if (job?.state === 'running' || Date.now() - lastStarted < 15_000) {
        throw new MetadataError(409, 'MAINTENANCE_BUSY', '已有一项刮削与刷新正在运行或刚刚结束。')
      }
      if (client !== currentKomga() || eligibility(libraryId) || snapshot() !== configuration) {
        throw new MetadataError(409, 'MAINTENANCE_SETTINGS_CHANGED', '配置已更改，请重新发起操作。')
      }
      lastStarted = Date.now()
      job = {
        libraryId, libraryName: library.name, state: 'running', stage: 'loading', total: null,
        checked: 0, updated: 0, skipped: 0, failed: 0, coverFailures: 0, issues: [], scan: null, error: null,
      }
      void run(job, client, configuration)
      sendJson(res, 202, { unavailable: null, job })
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500
      sendError(res, status, error?.code ?? 'MAINTENANCE_ERROR', status === 500 ? '无法启动 Komga 刮削与刷新。' : error.message)
    }
    return true
  }
}
