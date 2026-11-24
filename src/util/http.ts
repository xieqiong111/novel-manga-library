import { lookup } from 'node:dns'
import type { LookupFunction } from 'node:net'
import { Agent } from 'undici'
import { assertSafePublicUrl, isPrivateHost, UrlViolation } from './paths.js'
import type { Logger } from './logger.js'

export interface PoliteFetcherOptions {
  userAgent: string
  minIntervalMs: number
  timeoutMs: number
  respectRobots: boolean
  logger: Logger
}

interface RobotsRule {
  allow: string[]
  disallow: string[]
  crawlDelayMs: number
}

interface RobotsState {
  fetchedAt: number
  rule: RobotsRule | null
  deniedByServerError: boolean
}

const MAX_PUBLIC_BODY = 8 * 1024 * 1024
const MAX_ROBOTS_BODY = 512 * 1024

// This lookup supplies the checked addresses directly to the connection. A separate DNS preflight
// would allow the hostname to resolve again between validation and connection.
const publicLookup: LookupFunction = (host, options, callback) => {
  lookup(host, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '')
    if (!addresses.length || addresses.some(({ address }) => isPrivateHost(address))) {
      return callback(new UrlViolation('Public source resolved to a non-public address'), '')
    }
    if (options.all) callback(null, addresses)
    else callback(null, addresses[0]!.address, addresses[0]!.family)
  })
}

/**
 * Read-only, credential-free HTTP client for public source pages.
 *
 * - one in-flight request per host, spaced by `minIntervalMs` (and robots
 *   Crawl-delay when larger);
 * - robots.txt is fetched and honoured before any other path;
 * - redirects are followed manually so each hop is re-validated;
 * - no cookies, no Authorization, no login or paywall handling of any kind.
 */
export class PoliteFetcher {
  private readonly lastRequest = new Map<string, number>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly robots = new Map<string, RobotsState>()
  private readonly opts: PoliteFetcherOptions
  private readonly dispatcher = new Agent({ connect: { lookup: publicLookup } })

  constructor(opts: PoliteFetcherOptions) {
    this.opts = opts
  }

  async getBuffer(rawUrl: string, allowedHosts?: readonly string[]): Promise<ArrayBuffer> {
    let url = assertSafePublicUrl(rawUrl, allowedHosts)
    for (let hop = 0; hop < 4; hop++) {
      const response = await this.requestWithRetry(url)
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) throw new Error(`Redirect without Location: ${url.href}`)
        url = assertSafePublicUrl(new URL(location, url).href, allowedHosts)
        continue
      }
      if (!response.ok) {
        throw new HttpError(`HTTP ${response.status} for ${url.pathname}`, response.status)
      }
      return response.body
    }
    throw new Error('Too many redirects')
  }

  async getText(rawUrl: string, options: { encoding?: string; allowedHosts?: readonly string[] } = {}): Promise<string> {
    const buffer = await this.getBuffer(rawUrl, options.allowedHosts)
    const encoding = options.encoding ?? 'utf-8'
    try {
      return new TextDecoder(encoding).decode(buffer)
    } catch {
      return new TextDecoder('utf-8').decode(buffer)
    }
  }

  async close(): Promise<void> {
    await this.dispatcher.destroy()
  }

  private async requestWithRetry(url: URL) {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.queuedFetch(url)
        if (attempt >= 1 || ![408, 425, 429, 500, 502, 503, 504].includes(result.status)) return result
        const retryAfter = result.headers.get('retry-after')
        if (retryAfter !== null && Number(retryAfter) > 2) return result
      } catch (error) {
        if (attempt >= 1 || !(error instanceof TypeError || error instanceof DOMException) ||
            error.cause instanceof UrlViolation) throw error
      }
      await sleep(400 * (2 ** attempt))
    }
  }

  private async rawFetch(url: URL, maxBytes: number) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new DOMException('Source response timed out', 'TimeoutError')), this.opts.timeoutMs)
    try {
      const init: RequestInit & { dispatcher: Agent } = {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        dispatcher: this.dispatcher,
        headers: {
          'User-Agent': this.opts.userAgent,
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        credentials: 'omit',
      }
      const response = await fetch(url, init)
      const { status, headers, ok } = response
      let body: ArrayBuffer = new ArrayBuffer(0)
      if (!ok || Number(headers.get('content-length')) > maxBytes) {
        void response.body?.cancel().catch(() => undefined)
        if (ok) throw new HttpError('Source response exceeded its size limit', 413)
      } else if (response.body) {
        const reader = response.body.getReader()
        const cancel = () => { void reader.cancel().catch(() => undefined) }
        controller.signal.addEventListener('abort', cancel, { once: true })
        try {
          const chunks: Uint8Array[] = []
          let bytes = 0
          while (true) {
            controller.signal.throwIfAborted()
            const chunk = await reader.read()
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > maxBytes) throw new HttpError('Source response exceeded its size limit', 413)
            chunks.push(chunk.value)
          }
          controller.signal.throwIfAborted()
          body = new Uint8Array(Buffer.concat(chunks, bytes)).buffer
        } finally {
          controller.signal.removeEventListener('abort', cancel)
          cancel()
          reader.releaseLock()
        }
      }
      return { status, headers, ok, body }
    } finally {
      clearTimeout(timer)
    }
  }

  private async queuedFetch(url: URL) {
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    const previous = this.queues.get(host) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this.queues.set(host, tail)
    await previous
    try {
      let delay = this.opts.minIntervalMs
      const robots = await this.robotsFor(url)
      if (robots !== null) {
        if (robots.deniedByServerError) {
          throw new RobotsDenied('robots.txt unavailable (server error); refusing to crawl')
        }
        if (robots.rule && !this.pathAllowed(url, robots.rule)) {
          throw new RobotsDenied(`robots.txt disallows ${url.pathname}`)
        }
        delay = Math.max(delay, robots.rule?.crawlDelayMs ?? 0)
      }
      const last = this.lastRequest.get(host) ?? 0
      const wait = Math.max(0, last + delay - Date.now())
      if (wait > 0) await sleep(wait)
      this.lastRequest.set(host, Date.now())
      return await this.rawFetch(url, MAX_PUBLIC_BODY)
    } finally {
      release()
      if (this.queues.get(host) === tail) this.queues.delete(host)
    }
  }

  private async robotsFor(url: URL): Promise<RobotsState | null> {
    if (!this.opts.respectRobots) return null
    const origin = url.origin
    const cached = this.robots.get(origin)
    if (cached && Date.now() - cached.fetchedAt < 3600_000) return cached
    const robotsUrl = `${origin}/robots.txt`
    let state: RobotsState
    try {
      const response = await this.rawFetch(new URL(robotsUrl), MAX_ROBOTS_BODY)
      if (response.status === 404 || response.status === 410) {
        state = { fetchedAt: Date.now(), rule: null, deniedByServerError: false }
      } else if (!response.ok) {
        this.opts.logger.warn('http', 'robots_unavailable', { origin, status: response.status })
        state = { fetchedAt: Date.now(), rule: null, deniedByServerError: true }
      } else {
        state = { fetchedAt: Date.now(), rule: parseRobots(new TextDecoder().decode(response.body)), deniedByServerError: false }
      }
    } catch (error) {
      this.opts.logger.warn('http', 'robots_fetch_failed', { origin, error: String(error) })
      state = { fetchedAt: Date.now(), rule: null, deniedByServerError: true }
    }
    this.robots.set(origin, state)
    return state
  }

  private pathAllowed(url: URL, rule: RobotsRule): boolean {
    const path = url.pathname + url.search
    let bestMatch = -1
    let allowed = true
    for (const prefix of rule.allow) {
      if (path.startsWith(prefix) && prefix.length > bestMatch) { bestMatch = prefix.length; allowed = true }
    }
    for (const prefix of rule.disallow) {
      if (path.startsWith(prefix) && prefix.length > bestMatch) { bestMatch = prefix.length; allowed = false }
    }
    return allowed
  }
}

export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'HttpError'
  }
}

export class RobotsDenied extends Error {
  readonly code = 'ROBOTS_DENIED'
  constructor(message: string) {
    super(message)
    this.name = 'RobotsDenied'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Minimal robots.txt parser for the wildcard user-agent group. */
export function parseRobots(text: string): RobotsRule {
  const rule: RobotsRule = { allow: [], disallow: [], crawlDelayMs: 0 }
  let applies = false
  let sawWildcard = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line || !line.includes(':')) continue
    const idx = line.indexOf(':')
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (key === 'user-agent') {
      if (applies && sawWildcard) break // first matching group wins
      applies = value === '*'
      if (applies) sawWildcard = true
      continue
    }
    if (!applies) continue
    if (key === 'disallow' && value) rule.disallow.push(value)
    else if (key === 'allow' && value) rule.allow.push(value)
    else if (key === 'crawl-delay') {
      const seconds = Number(value)
      if (Number.isFinite(seconds) && seconds > 0) rule.crawlDelayMs = Math.min(seconds * 1000, 120_000)
    }
  }
  return rule
}

/** Convenience guard used by adapters before building outbound URLs. */
export function safeHttpUrl(raw: string): URL | null {
  try {
    return assertSafePublicUrl(raw)
  } catch (error) {
    if (error instanceof UrlViolation) return null
    return null
  }
}
