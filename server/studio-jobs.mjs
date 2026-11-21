import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { SuwayomiError } from './suwayomi-client.mjs'
import { sameBangumiTitle, traditionalBangumiTitle } from './bangumi-title.mjs'

const tokenFormat = /^studio_jobs_[A-Za-z0-9_-]{43}$/

export function studioJobRoute(method, pathname) {
  if (method === 'GET') return [
    '/api/health', '/api/status', '/api/activities', '/api/novels', '/api/novel-catalog', '/api/bangumi/title',
    '/api/tasks', '/api/tasks/files', '/api/library', '/api/library/stats',
    '/api/manga/search', '/api/manga/sources', '/api/manga/library', '/api/manga/downloads',
  ].includes(pathname) || /^\/api\/tasks\/(?:dsh:)?task_[a-f0-9]{16}$/.test(pathname) ||
    /^\/api\/library\/lib_[a-f0-9]{16}(?:\/file)?$/.test(pathname) ||
    /^\/api\/manga\/[1-9]\d{0,9}(?:\/(chapters|komga))?$/.test(pathname)
  if (method === 'POST') return ['/api/tasks', '/api/manga/downloads/cancel', '/api/library/verify'].includes(pathname) ||
    /^\/api\/tasks\/task_[a-f0-9]{16}\/(cancel|retry)$/.test(pathname) ||
    /^\/api\/manga\/[1-9]\d{0,9}\/(komga|subscribe)$/.test(pathname) ||
    /^\/api\/library\/lib_[a-f0-9]{16}\/verify$/.test(pathname)
  return false
}

export function isStudioJobCredential(header) {
  return typeof header === 'string' && header.startsWith('Bearer studio_jobs_')
}

export async function authorizeStudioJob(header, file) {
  if (!isStudioJobCredential(header) || !file) return false
  const supplied = header.slice(7)
  if (!tokenFormat.test(supplied)) return false
  const expected = (await readFile(file, 'utf8').catch(() => '')).trim()
  return tokenFormat.test(expected) && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
}

export function studioDelegated(env = process.env) {
  return env.LN_STUDIO_TASK_MODE === 'managed' || Boolean(env.LN_STUDIO_JOB_TOKEN_FILE)
}

export async function studioJob(pathname, { method = 'GET', body, query } = {}, env = process.env) {
  if (!studioJobRoute(method, pathname)) {
    throw new SuwayomiError('STUDIO_JOB_ROUTE_DENIED', 'Studio 任务接口不支持该操作。', 403)
  }
  if (!env.LN_STUDIO_READ_URL || !env.LN_STUDIO_JOB_TOKEN_FILE) {
    throw new SuwayomiError('STUDIO_JOB_UNCONFIGURED', '请为 DSH 配置 Studio 地址和独立的任务密钥文件。', 503)
  }
  let target, token
  try {
    const origin = new URL(env.LN_STUDIO_READ_URL)
    if (!['http:', 'https:'].includes(origin.protocol) || origin.href !== origin.origin + '/') throw Error()
    target = new URL(pathname, origin)
    if (query) target.search = new URLSearchParams(Object.entries(query)
      .filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString()
    token = (await readFile(env.LN_STUDIO_JOB_TOKEN_FILE, 'utf8')).trim()
    if (!tokenFormat.test(token)) throw Error()
  } catch {
    throw new SuwayomiError('STUDIO_JOB_CONFIG_ERROR', 'Studio 地址或任务密钥文件无效。', 503)
  }
  try {
    const response = await fetch(target, {
      method, redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const payload = await response.json()
    if (!response.ok) throw Object.assign(new SuwayomiError(payload?.error?.code || 'STUDIO_JOB_HTTP_ERROR',
      payload?.error?.message || `Studio 返回 HTTP ${response.status}。`, response.status), { retryable: false })
    return payload
  } catch (error) {
    if (error instanceof SuwayomiError) throw error
    const message = method === 'POST' ? '这次提交结果未获确认，请先查看工作台任务，再决定是否重试。' : 'Studio 任务接口暂不可用。'
    throw new SuwayomiError('STUDIO_JOB_UNCONFIRMED', message, 503)
  }
}

export async function searchStudioWork(kind, { bangumiSubjectId, sourceQuery, alternateNames = [], ...filters }) {
  const path = kind === 'manga' ? '/api/manga/search' : '/api/novels'
  const field = kind === 'manga' ? 'mangas' : 'results'
  const { subject, candidates } = await studioJob('/api/bangumi/title', {
    query: { kind, query: filters.query, subjectId: bangumiSubjectId },
  })
  const names = [filters.query, ...alternateNames.slice(0, 3)].map((name) => name.trim())
    .filter((name) => name && name.length <= 200)
  const titles = [...new Set([subject?.title, ...names, ...(subject?.aliases ?? [])]
    .filter((title) => title && title.length <= 200))]
  const variants = [subject?.title, ...names].filter(Boolean).map(traditionalBangumiTitle)
  const supported = [...new Set([subject?.title, ...names, ...variants, ...(subject?.aliases ?? [])]
    .filter((title) => title && title.length <= 200))]
  if (sourceQuery && !supported.includes(sourceQuery)) {
    throw new SuwayomiError('INVALID_SOURCE_QUERY', '请使用本次搜索返回的 sourceQuery，并保留上次输入的其他名称。', 400)
  }
  if (filters.offset && !sourceQuery) {
    throw new SuwayomiError('SOURCE_QUERY_REQUIRED', '翻页请带上上一页返回的 sourceQuery。', 400)
  }
  const attemptedQueries = []
  let unconfirmedMatches = []
  for (const query of sourceQuery ? [sourceQuery] : supported.slice(0, 7)) {
    const data = await studioJob(path, { query: { ...filters, query } })
    attemptedQueries.push(query)
    if (!subject && (data[field].length || sourceQuery)) return { ...data, bangumi: null, bangumiCandidates: candidates,
      sourceQuery: query, attemptedQueries, notice: '已找到源站作品，下载前还需确认对应的 Bangumi 系列。' }
    const matches = data[field].filter((entry) => [entry.title, ...(entry.aliases ?? [])]
      .some((title) => titles.some((name) => sameBangumiTitle(title, name))))
    if (matches.length || sourceQuery) return { ...data, [field]: matches, bangumi: subject,
      sourceQuery: query, attemptedQueries }
    if (!unconfirmedMatches.length) unconfirmedMatches = data[field]
  }
  return { [field]: [], bangumi: subject, ...(!subject ? { bangumiCandidates: candidates } : {}),
    attemptedQueries, unconfirmedMatches, notice: '下载源暂未返回可以确认的作品，可再提供繁体译名或其他称呼。' }
}
