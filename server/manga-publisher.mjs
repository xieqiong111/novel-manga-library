import { load } from 'cheerio'
import { chapterList } from './manga-volume-catalog.mjs'
import { MetadataError } from './bangumi-komga.mjs'

const publisher = 'https://yenpress.com'
const kadokawa = 'https://www.kadokawa.co.jp'
const titlePattern = /^\/titles\/(\d{13})-[a-z0-9-]+$/
const productPattern = /^\/product\/\d{12}\/?$/

export function publisherSearches(title, isbn, aliases = []) {
  const terms = aliases.filter((value) => /^[a-z][a-z0-9 ,:'!?&-]{2,99}$/i.test(value))
  const workingTitle = terms[0] ?? title
  const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const paths = [...new Set(terms.flatMap((term) => [term, term.split(':')[0]]).map(slug))].filter(Boolean).slice(0, 2)
  const queries = [
    ...paths.map((part) => new URL('/series/' + part + '-manga', publisher)),
    new URL('/search?' + new URLSearchParams({ q: workingTitle }), publisher),
    new URL('/product/search/?' + new URLSearchParams({ kw: title, itemIdKbn: '1' }), kadokawa),
    ...(isbn ? [new URL('/product/search/?' + new URLSearchParams({ isbn, itemIdKbn: '1' }), kadokawa)] : []),
  ]
  return queries.map((url) => url.href)
}

export function publisherVolumeUrl(raw) {
  let url
  try { url = new URL(raw) } catch { return null }
  if (url.username || url.password || url.search || url.hash) return null
  if (url.origin === publisher && titlePattern.test(url.pathname)) return url
  if (url.origin === kadokawa && productPattern.test(url.pathname)) {
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    return url
  }
  return null
}

async function loadPage(url, fetchImpl) {
  try {
    const result = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(9000),
      headers: { accept: 'text/html', 'user-agent': 'NovelMangaStudio/1.0 catalogue verification' } })
    if (!result.ok || !result.headers.get('content-type')?.includes('text/html') || !result.body) throw Error()
    const reader = result.body.getReader()
    const chunks = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 2_000_000) throw Error()
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    return load(Buffer.concat(chunks))
  } catch {
    throw new MetadataError(502, 'PUBLISHER_UNAVAILABLE', '出版社官网暂不可访问或返回页面无效。')
  }
}

export async function findPublisherVolumes(title, isbn, { aliases = [], volume, fetchImpl = fetch } = {}) {
  const searches = publisherSearches(title, isbn, aliases)
  const normalized = (value) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const terms = [title, ...aliases].flatMap((name) => [name, name.split(/[：:]/)[0]])
    .map((name) => normalized(name.replace(/\s*[(（]\d+[)）]$/, ''))).filter((value) => value.length >= 4)
  const results = await Promise.allSettled(searches.map(async (search) => {
    const base = new URL(search)
    const $ = await loadPage(base, fetchImpl)
    const unique = new Map()
    for (const anchor of $('a[href]')) {
      let url
      try { url = publisherVolumeUrl(new URL($(anchor).attr('href'), base).href) } catch { continue }
      if (!url || url.origin !== base.origin) continue
      const label = ($(anchor).text().replace(/\s+/g, ' ').trim() || $(anchor).attr('title') ||
        $(anchor).find('img').first().attr('alt') || '').slice(0, 300)
      const pathVolume = /-vol-(\d+)-manga(?:$|-)/i.exec(url.pathname)?.[1]
      if (volume && pathVolume && Number(pathVolume) !== volume) continue
      if (url.pathname.includes(isbn || '___') ||
          terms.some((term) => normalized(label).includes(term) || normalized(url.pathname).includes(term))) {
        unique.set(url.href, { url: url.href, title: label || url.pathname.split('/').filter(Boolean).at(-1) })
      }
    }
    return { search, candidates: [...unique.values()].slice(0, 20) }
  }))
  return results.map((result, index) => result.status === 'fulfilled'
    ? result.value : { search: searches[index], candidates: [], unavailable: true })
}

export async function readPublisherVolume(raw, fetchImpl = fetch) {
  const url = publisherVolumeUrl(raw)
  if (!url) throw new MetadataError(400, 'INVALID_PUBLISHER_PAGE', '请输入 Yen Press 漫画卷页面或 KADOKAWA 产品页链接。')
  const $ = await loadPage(url, fetchImpl)
  const title = ($('h1').first().text().trim() || $('title').first().text().trim()).slice(0, 300)
  const isbn = titlePattern.exec(url.pathname)?.[1] || $('body').text().replace(/[‐‑－–-]/g, '').match(/\b97[89]\d{10}\b/)?.[0]
  const preview = $('ol').toArray().find((list) =>
    $(list).children('li').toArray().some((item) => /^Contents\s*$/i.test($(item).text().trim())) &&
    $(list).children('li').toArray().some((item) => /^Chapter\s+\d+/i.test($(item).text().trim())))
  const chapters = preview ? chapterList($(preview).children('li').toArray().flatMap((item) => {
    const match = /^Chapter\s+(\d{1,4}(?:\.\d{1,4})?)(?=[:\s]|$)/i.exec($(item).text().trim())
    return match ? [match[1]] : []
  })) : []
  return { url: url.href, title, isbn, chapters }
}
