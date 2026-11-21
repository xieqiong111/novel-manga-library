import { randomBytes } from 'node:crypto'
import { normalizeKomgaUrl } from './komga-client.mjs'
import { bangumiCoverUrl, decodeBangumiCover, downloadBangumiCover } from './bangumi-cover.mjs'
import { defaultScrapeOptions } from './scrape-options.mjs'

export class MetadataError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const komgaId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value)
const subjectId = (value) => Number.isSafeInteger(value) && value > 0 && value <= 9999999999
const MAX_PREVIEWS = 32
const PREVIEW_MS = 10 * 60 * 1000

function selection(body) {
  if (!['novel', 'manga'].includes(body.kind) || !['series', 'book'].includes(body.scope)) {
    throw new MetadataError(400, 'INVALID_METADATA_TYPE', '请选择小说或漫画，以及系列或单册。')
  }
  return { kind: body.kind, scope: body.scope }
}

async function readAdapterJson(response) {
  const chunks = []
  let length = 0
  for await (const chunk of response.body ?? []) {
    length += chunk.byteLength
    if (length > 1024 * 1024) throw new MetadataError(502, 'METADATA_RESPONSE_TOO_LARGE', '元数据响应超过大小限制。')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function candidate(value) {
  if (!object(value) || !subjectId(value.id) || !text(value.name, 300)) {
    throw new MetadataError(502, 'INVALID_METADATA_RESPONSE', 'BangumiKomga 返回了无效条目。')
  }
  return {
    id: value.id, name: text(value.name, 300), nameCn: text(value.nameCn, 300),
    summary: text(value.summary, 500), date: text(value.date, 20), url: `https://bgm.tv/subject/${value.id}`,
    ...(Number.isInteger(value.score) ? { score: value.score } : {}),
  }
}

function provenance(data) {
  if (data.source === 'bangumi-live') return { source: 'bangumi-live' }
  if (data.source === 'bangumi-archive') {
    return { source: 'bangumi-archive', archiveVersion: text(data.archiveVersion, 40) || null }
  }
  return {}
}

function appendUnique(current, items, key) {
  const existing = Array.isArray(current) ? current : []
  const seen = new Set(existing.map(key))
  const additions = []
  for (const item of items) {
    const identity = key(item)
    if (seen.has(identity)) continue
    seen.add(identity)
    additions.push(item)
  }
  return additions.length ? [...existing, ...additions] : undefined
}

function rowList(value, pair, validate = () => true) {
  if (!Array.isArray(value)) return []
  const [first, second] = pair
  return value.slice(0, 32).flatMap((row) => {
    if (!object(row)) return []
    const label = text(row[first], 300)
    const content = text(row[second], 300)
    return label && content && validate(content) ? [{ [first]: label, [second]: content }] : []
  })
}

function changes(current, input, scope, subject, options) {
  const patch = {}
  function field(name, value) {
    if (value !== undefined && current[name + 'Lock'] !== true && JSON.stringify(current[name]) !== JSON.stringify(value)) {
      patch[name] = value
    }
  }
  const scalarFields = scope === 'series'
    ? [['title', 300], ['summary', 20000], ['publisher', 300]]
    : [['summary', 20000], ['releaseDate', 10]]
  for (const [name, maximum] of scalarFields) {
    const value = text(input[name], maximum)
    if (value && (name !== 'releaseDate' || /^\d{4}-\d{2}-\d{2}$/.test(value))) field(name, value)
  }
  if (scope === 'series') {
    const sortTitle = options.sortTitle && text(input.titleSort, 301)
    if (sortTitle) field('titleSort', sortTitle)
    const localVersion = options.addLocalVersion && text(input.localVersion, 100)
    if (localVersion) field('genres', appendUnique(current.genres, [localVersion], (genre) => genre))
    field('alternateTitles', appendUnique(current.alternateTitles,
      rowList(input.alternateTitles, ['label', 'title']), (row) => row?.title))
    if (input.ageRating === 18 && Number(current.ageRating ?? 0) < 18) field('ageRating', 18)
  } else {
    field('authors', appendUnique(current.authors,
      rowList(input.authors, ['name', 'role']), (row) => JSON.stringify([row?.name, row?.role])))
  }
  if (Array.isArray(input.tags)) {
    field('tags', appendUnique(current.tags, input.tags.slice(0, 32).map((tag) => text(tag, 100)).filter(Boolean), (tag) => tag))
  }
  const links = [{ label: 'Bangumi', url: subject.url }, ...rowList(input.links, ['label', 'url'], (url) => /^https:\/\/bgm\.tv\/subject\/[1-9]\d{0,9}$/.test(url))]
  const existingLinks = Array.isArray(current.links) ? current.links : []
  const manual = existingLinks.find((link) => /^cbl$/i.test(link?.label || ''))
  if (manual && !['bgm.tv', 'bangumi.tv', 'chii.in'].some((host) =>
    [`https://${host}/subject/${subject.id}`, `http://${host}/subject/${subject.id}`].includes(String(manual.url).replace(/\/$/, '')))) {
    throw new MetadataError(409, 'BANGUMI_LINK_CONFLICT', 'Komga 已有指向另一条目的 cbl 链接，请先核对匹配。')
  }
  const otherLinks = existingLinks.filter((link) => link?.label !== 'Bangumi' || link.url === subject.url)
  const mergedLinks = appendUnique(otherLinks, links, (row) => row?.url)
  field('links', mergedLinks ?? otherLinks)
  return patch
}

function fingerprint(metadata, patch) {
  return JSON.stringify([...new Set(['links', ...Object.keys(patch)])].map((key) => [key, metadata[key], metadata[key + 'Lock']]))
}

function checkLibrary(libraryId, rules, kind) {
  if (rules.length && !rules.some((rule) =>
    rule.id === libraryId && (!kind || rule.kind === 'all' || rule.kind === kind))) {
    throw new MetadataError(403, 'SCRAPE_LIBRARY_EXCLUDED', '刮削设置未允许这个 Komga 书库或作品类型。')
  }
}

async function previewCover(client, scope, id, data) {
  const url = data.source === 'bangumi-live' ? bangumiCoverUrl(data.coverUrl) : null
  if (!url) return { status: 'unavailable', message: '当前 Bangumi 数据未提供可用封面。' }
  try {
    if (await client.hasUploadedCover(scope, id)) return { status: 'skipped', message: 'Komga 已有上传的封面。' }
    return { status: 'pending', url }
  } catch {
    return { status: 'failed', message: '无法确认 Komga 当前封面，已跳过封面变更。' }
  }
}

async function applyCover(client, scope, id, url, fetchCover) {
  try {
    if (!await client.hasUploadedCover(scope, id)) {
      const { image, filename } = await fetchCover(url)
      if (!await client.hasUploadedCover(scope, id)) {
        await client.uploadCover(scope, id, image, filename)
        return { status: 'applied' }
      }
    }
    return { status: 'skipped', message: 'Komga 已有上传的封面。' }
  } catch {
    return { status: 'failed', message: 'Bangumi 封面下载或 Komga 写入未获确认。' }
  }
}

export function createBangumiKomga({ url, requestMetadata, komga, getOptions, getBangumiProxy, scanAfterApply, fetchImpl = fetch }) {
  const preferences = () => getOptions?.() ?? defaultScrapeOptions
  const previews = new Map()
  const writes = new Set()
  let active = 0

  async function adapter(operation, parameters) {
    try {
      let status, data
      if (requestMetadata) {
        const reply = await requestMetadata(operation, parameters)
        status = reply.status
        data = reply.payload
      } else {
        let base
        try { base = normalizeKomgaUrl(url) } catch {
          throw new MetadataError(503, 'BANGUMIKOMGA_CONFIGURATION', 'BangumiKomga 服务地址无效。')
        }
        if (!base) throw new MetadataError(503, 'BANGUMIKOMGA_CONFIGURATION', 'BangumiKomga 服务地址无效。')
        const response = await fetchImpl(`${base}/${operation}?${new URLSearchParams(parameters)}`, {
          redirect: 'error', signal: AbortSignal.timeout(16000), headers: { accept: 'application/json' },
        })
        status = response.status
        data = await readAdapterJson(response)
      }
      if (status !== 200) {
        const mappedStatus = [404, 422, 429, 502, 503, 504].includes(status) ? status : 502
        const code = /^BANGUMI_[A-Z_]+$/.test(data?.error?.code) ? data.error.code : 'BANGUMIKOMGA_HTTP_ERROR'
        throw new MetadataError(mappedStatus, code, text(data?.error?.message, 200) || 'BangumiKomga 请求失败。')
      }
      return data
    } catch (error) {
      if (error instanceof MetadataError) throw error
      if (error?.name === 'TimeoutError') throw new MetadataError(504, 'BANGUMIKOMGA_TIMEOUT', 'BangumiKomga 响应超时。')
      throw new MetadataError(502, 'BANGUMIKOMGA_UNAVAILABLE', 'BangumiKomga 不可用或返回了无效数据。')
    }
  }

  async function fetchCover(coverUrl) {
    if (requestMetadata && getBangumiProxy?.()) return decodeBangumiCover(await adapter('cover', { url: coverUrl }))
    return downloadBangumiCover(coverUrl, fetchImpl)
  }

  async function preview(body) {
    const type = selection(body)
    if (!komgaId(body.seriesId) || (type.scope === 'book' && !komgaId(body.bookId)) || !subjectId(body.subjectId)) {
      throw new MetadataError(400, 'INVALID_METADATA_IDS', '请填写 Komga 系列 ID、Bangumi 条目 ID，以及单册 ID（单册模式）。')
    }
    const options = preferences()
    const client = komga()
    const id = type.scope === 'series' ? body.seriesId : body.bookId
    const target = await client.metadataTarget(type.scope, id)
    if (target.seriesId !== body.seriesId) throw new MetadataError(409, 'BOOK_SERIES_MISMATCH', '该单册不属于指定系列。')
    checkLibrary(target.libraryId, options.libraries, type.kind)
    const includeCover = type.scope === 'series' ? options.seriesCover : options.bookCover
    const data = await adapter('metadata', {
      ...type, subjectId: body.subjectId,
      ...(options.sortTitle || options.addLocalVersion ? {
        sortTitle: options.sortTitle, addLocalVersion: options.addLocalVersion, localName: text(target.name, 300),
      } : {}),
      ...(includeCover ? { includeCover } : {}),
    })
    const subject = candidate(data?.subject)
    if (subject.id !== body.subjectId || !object(data.metadata)) {
      throw new MetadataError(502, 'INVALID_METADATA_RESPONSE', 'BangumiKomga 返回的条目与请求不一致。')
    }
    const patch = changes(target.metadata, data.metadata, type.scope, subject, options)
    const cover = includeCover ? await previewCover(client, type.scope, id, data) : null
    const fields = Object.keys(patch)
    const result = { ...type, ...provenance(data), id, seriesId: target.seriesId, name: target.name, subject,
      ...(cover ? { cover } : {}),
      changes: Object.fromEntries(fields.map((key) => [key, { before: target.metadata[key] ?? null, after: patch[key] }])),
    }
    if (!fields.length && cover?.status !== 'pending') return { ...result, previewId: null }
    const previewId = randomBytes(24).toString('base64url')
    if (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value)
    previews.set(previewId, {
      ...type, id, result, client, patch, options: JSON.stringify(options), libraryId: target.libraryId, fingerprint: fingerprint(target.metadata, patch), expires: Date.now() + PREVIEW_MS,
    })
    return { ...result, previewId, expiresInSeconds: PREVIEW_MS / 1000 }
  }

  async function apply(body) {
    if (typeof body.previewId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(body.previewId)) {
      throw new MetadataError(400, 'INVALID_PREVIEW_ID', '请提供有效的刮削预览 ID。')
    }
    const item = previews.get(body.previewId)
    if (!item || item.expires <= Date.now()) {
      previews.delete(body.previewId)
      throw new MetadataError(409, 'METADATA_PREVIEW_EXPIRED', '预览已过期或已使用，请重新生成。')
    }
    const key = `${item.scope}:${item.id}`
    if (writes.has(key)) throw new MetadataError(409, 'METADATA_UPDATE_BUSY', '已有更新正在写入此条目。')
    writes.add(key)
    try {
      const current = komga()
      if (current !== item.client) throw new MetadataError(409, 'KOMGA_CONFIGURATION_CHANGED', 'Komga 配置已改变，请重新预览。')
      if (JSON.stringify(preferences()) !== item.options) {
        throw new MetadataError(409, 'SCRAPE_OPTIONS_CHANGED', '刮削设置已改变，请重新预览。')
      }
      const target = await current.metadataTarget(item.scope, item.id)
      if (target.seriesId !== item.result.seriesId || target.libraryId !== item.libraryId || target.name !== item.result.name ||
          fingerprint(target.metadata, item.patch) !== item.fingerprint) {
        throw new MetadataError(409, 'METADATA_CHANGED', 'Komga 的当前元数据已改变，请重新预览。')
      }
      previews.delete(body.previewId)
      const hasPatch = Object.keys(item.patch).length > 0
      if (hasPatch) await current.patchMetadata(item.scope, item.id, item.patch)
      const pendingCover = item.result.cover
      const cover = pendingCover?.status === 'pending'
        ? await applyCover(current, item.scope, item.id, pendingCover.url, fetchCover)
        : pendingCover
      const updated = hasPatch || cover?.status === 'applied'
      const scan = updated ? await scanAfterApply?.(current, target.libraryId) : null
      return { ...item.result, updated, ...(cover ? { cover } : {}), ...(scan ? { scan } : {}) }
    } finally {
      writes.delete(key)
    }
  }

  return async function run(action, body) {
    if (!url && !requestMetadata) throw new MetadataError(503, 'BANGUMIKOMGA_UNCONFIGURED', '尚未启用 BangumiKomga 服务。')
    if (active >= 4) throw new MetadataError(429, 'METADATA_BUSY', '元数据服务繁忙，请稍后重试。')
    active += 1
    try {
      if (action === 'books') {
        const page = body.page ?? 0
        if (!komgaId(body.seriesId) || !Number.isInteger(page) || page < 0 || page > 10000) {
          throw new MetadataError(400, 'INVALID_METADATA_IDS', '请填写 Komga 系列 ID 和有效页码。')
        }
        const client = komga()
        const { libraries } = preferences()
        if (libraries.length) {
          const target = await client.metadataTarget('series', body.seriesId)
          checkLibrary(target.libraryId, libraries)
        }
        return await client.metadataBooks(body.seriesId, page)
      }
      if (action === 'apply') return await apply(body)
      if (action === 'preview') return await preview(body)
      const query = text(body.query, 201)
      if (!query || query.length > 200) throw new MetadataError(400, 'INVALID_QUERY', '请输入 1 至 200 个字符。')
      const type = selection(body)
      const data = await adapter('search', { ...type, query })
      if (!Array.isArray(data?.candidates)) throw new MetadataError(502, 'INVALID_METADATA_RESPONSE', 'BangumiKomga 返回了无效的搜索结果。')
      const { minimumScore } = preferences()
      const candidates = data.candidates.slice(0, 10).map(candidate)
        .filter((row) => minimumScore === 0 || (row.score >= minimumScore && row.score <= 100))
      return { ...type, ...provenance(data), candidates }
    } finally {
      active -= 1
    }
  }
}
