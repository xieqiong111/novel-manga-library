import { describe, expect, it, vi } from 'vitest'
import { parseRobots, safeHttpUrl, RobotsDenied } from '../../src/util/http.js'
import { createLogger } from '../../src/util/logger.js'
import { PoliteFetcher } from '../../src/util/http.js'

describe('robots.txt compliance (requirement #10)', () => {
  it('parses wildcard disallow and Crawl-delay', () => {
    const rule = parseRobots('User-agent: *\nDisallow: /search/\nCrawl-delay: 10\n')
    expect(rule.disallow).toContain('/search/')
    expect(rule.crawlDelayMs).toBe(10000)
  })

  it('parses Allow entries', () => {
    const rule = parseRobots('User-agent: *\nAllow: /public/\nDisallow: /\n')
    expect(rule.allow).toContain('/public/')
    expect(rule.disallow).toContain('/')
  })

  it('handles a missing/empty robots file permissively', () => {
    const rule = parseRobots('')
    expect(rule.disallow).toEqual([])
    expect(rule.crawlDelayMs).toBe(0)
  })

  it('safeHttpUrl rejects private/credential URLs', () => {
    expect(safeHttpUrl('https://www.bilinovel.com/novel/1.html')).not.toBeNull()
    expect(safeHttpUrl('http://127.0.0.1/')).toBeNull()
    expect(safeHttpUrl('https://u:p@example.com/')).toBeNull()
    expect(safeHttpUrl('http://[::ffff:127.0.0.1]/')).toBeNull()
    expect(safeHttpUrl('http://localhost./')).toBeNull()
  })
})

describe('PoliteFetcher rate limiting and redirect revalidation', () => {
  const logger = createLogger('/tmp/ln-test-logs')

  it('times out the body even after headers have arrived and cancels its reader', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 200 })))
    const fetcher = new PoliteFetcher({ userAgent: 'test', minIntervalMs: 0, timeoutMs: 15, respectRobots: false, logger })
    try {
      await expect(fetcher.getText('https://example.com/')).rejects.toMatchObject({ name: 'TimeoutError' })
      expect(cancel).toHaveBeenCalledTimes(2)
    } finally {
      await fetcher.close()
      vi.unstubAllGlobals()
    }
  })

  it('enforces the streaming size limit when Content-Length is absent', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < 9; i++) controller.enqueue(chunk)
        controller.close()
      },
    })))
    const fetcher = new PoliteFetcher({ userAgent: 'test', minIntervalMs: 0, timeoutMs: 1000, respectRobots: false, logger })
    try {
      await expect(fetcher.getText('https://example.com/')).rejects.toMatchObject({ status: 413 })
    } finally {
      await fetcher.close()
      vi.unstubAllGlobals()
    }
  })

  it('never sends credentials and sets an identifying User-Agent', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response('ok', { status: 200 })
    })
    try {
      const fetcher = new PoliteFetcher({ userAgent: 'test-crawler/1.0', minIntervalMs: 0, timeoutMs: 5000, respectRobots: false, logger })
      await fetcher.getText('https://www.bilinovel.com/novel/1.html', { allowedHosts: ['bilinovel.com'] })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.init.credentials).toBe('omit')
      const headers = calls[0]!.init.headers as Record<string, string>
      expect(headers['User-Agent']).toBe('test-crawler/1.0')
      expect(headers.Authorization).toBeUndefined()
      expect(headers.Cookie).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('re-validates each redirect hop and blocks a redirect to a private host', async () => {
    let hop = 0
    vi.stubGlobal('fetch', async () => {
      hop++
      if (hop === 1) return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } })
      return new Response('ok', { status: 200 })
    })
    try {
      const fetcher = new PoliteFetcher({ userAgent: 'test', minIntervalMs: 0, timeoutMs: 5000, respectRobots: false, logger })
      await expect(fetcher.getText('https://www.bilinovel.com/x', { allowedHosts: ['bilinovel.com'] }))
        .rejects.toThrow()
      expect(hop).toBe(1) // blocked before the second request was ever made
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('honours a robots.txt Disallow for the target path', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).endsWith('/robots.txt')) {
        return new Response('User-agent: *\nDisallow: /novel/\n', { status: 200 })
      }
      return new Response('should not be fetched', { status: 200 })
    })
    try {
      const fetcher = new PoliteFetcher({ userAgent: 'test', minIntervalMs: 0, timeoutMs: 5000, respectRobots: true, logger })
      await expect(fetcher.getText('https://www.bilinovel.com/novel/1.html', { allowedHosts: ['bilinovel.com'] }))
        .rejects.toBeInstanceOf(RobotsDenied)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
