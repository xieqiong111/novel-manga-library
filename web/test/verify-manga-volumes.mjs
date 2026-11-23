import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const base = process.env.MANGA_WEB_URL ?? 'http://127.0.0.1:4173'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const records = Array.from({ length: 105 }, (_, index) => {
  const number = 105 - index
  return { id: String(1000 + number), name: `第 ${number} 话`, uploadDate: null, read: false, downloaded: number === 1, pageCount: 20 }
})
records.unshift({ ...records[0], id: '950', name: '单行本封面 1～22' })
const url = 'https://baozimh.org/manga/weimeihaodeshijiexianshangzhufu-xiaonatumetuntamazi'
const variants = {
  '3502': { sourceId: '774030471139699415', chapters: records },
  '3503': { sourceId: '99', chapters: [
    { ...records[1], id: '2001', name: '第 2 卷 第 6 话' },
    { ...records[1], id: '2002', name: '第 2 卷' },
    { ...records[1], id: '2003', name: '第 1 话' },
  ] },
}

async function prepare(page) {
  const submissions = []
  await page.route('**/api/**', async (route) => {
    const target = new URL(route.request().url())
    if (target.pathname === '/api/manga/3502/volume-catalog/source-listing') {
      assert.equal(route.request().method(), 'POST')
      const { sourceUrl, listing } = route.request().postDataJSON()
      if (sourceUrl !== url) return route.fulfill({ status: 409, json: {
        error: { code: 'VOLUME_SOURCE_MISMATCH', message: '导出的作品地址与当前漫画源不一致，请重新核对版本。' },
      } })
      assert.equal(listing.grabber, 'fixture')
      return route.fulfill({ json: { sourceUrl, sourceId: variants['3502'].sourceId, title: listing.title,
        grabber: listing.grabber, unassigned: 1,
        volumes: [
          { number: 1, comparison: 'matches', missing: [], extra: [], releases: listing.chapters.slice(0, 5).map(
            ({ number, title }) => ({ number: String(number), name: title, locked: false }),
          ) },
          { number: 2, comparison: 'differs', missing: ['7'], extra: ['8'], releases: [] },
        ],
      } })
    }
    if (target.pathname === '/api/manga/3502/volume-catalog') {
      return route.fulfill({ json: { enabled: true, sources: ['publisher', 'reference'], bound: true, openTomeConfigured: false,
        volumes: [
          { number: 1, chapters: ['1', '2', '3', '4', '5'], source: 'publisher', url: 'https://yenpress.com/', confirmed: true },
          { number: 2, chapters: ['6', '7'], source: 'reference', url: 'https://it.wikipedia.org/', confirmed: false },
        ],
        volumeMetadata: [{ number: 1, subjectId: 143034, isbn: '9784040705392', date: '2015-04-09' }],
      } })
    }
    if (target.pathname === '/api/manga/3503/volume-catalog') {
      return route.fulfill({ json: { enabled: true, sources: ['publisher'], bound: false, volumes: [], volumeMetadata: [] } })
    }
    const match = /^\/api\/manga\/(3502|3503)(?:\/(chapters|komga))?$/.exec(target.pathname)
    if (!match) {
      const json = target.pathname === '/api/auth/status' ? { enabled: false } : []
      return route.fulfill({ json })
    }
    const { sourceId, chapters } = variants[match[1]]
    if (match[2] === 'chapters') {
      const offset = Number(target.searchParams.get('offset') ?? 0)
      const limit = Number(target.searchParams.get('limit') ?? 50)
      return route.fulfill({ json: { chapters: chapters.slice(offset, offset + limit), hasNextPage: offset + limit < chapters.length } })
    }
    if (match[2] === 'komga') {
      if (route.request().method() === 'POST') {
        const { chapterIds } = route.request().postDataJSON()
        submissions.push(chapterIds)
        return route.fulfill({ json: { queued: chapterIds, skipped: [] } })
      }
      return route.fulfill({ json: { available: true, archiveMode: 'chapter', chapters: [] } })
    }
    return route.fulfill({ json: { id: match[1], sourceId, url, title: '为美好的世界献上祝福！',
      genre: [], status: 'ONGOING', author: '渡真仁', source: { id: sourceId, lang: 'zh', name: '测试漫画源' } } })
  })
  return submissions
}

async function testSourceListing(page) {
  await page.getByText('导入 Manga Downloader 源站卷目录').click()
  await page.getByLabel('导出时使用的作品网址').fill(url + '?wrong=edition')
  await page.getByLabel('Manga Downloader JSON 目录').setInputFiles({
    name: '卷目录.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      title: '为美好的世界献上祝福！', grabber: 'fixture',
      chapters: [1, 2, 3, 4, 5].map((number) => ({ number, title: '测试目录', volume: 1 })),
    })),
  })
  await page.getByRole('button', { name: '核对源站卷目录' }).click()
  await page.getByRole('alert').filter({ hasText: '导出的作品地址与当前漫画源不一致' }).waitFor()
  await page.getByLabel('导出时使用的作品网址').fill(url)
  await page.getByRole('button', { name: '核对源站卷目录' }).click()
  await page.getByRole('status').filter({ hasText: '源站标注了 2 卷' }).waitFor()
  assert.equal(await page.getByRole('list', { name: '源站该卷条目' }).getByRole('listitem').count(), 5)
  await page.getByRole('combobox', { name: '选择源站卷' }).selectOption('2')
  await page.getByText('源站目录缺少 7 话').waitFor()
  await page.getByText('源站目录另有 8 话').waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
}

try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const submissions = await prepare(desktop)
  await desktop.goto(base + '/#/manga/3502')
  await desktop.getByRole('checkbox', { name: '第 105 话', exact: true }).waitFor()
  await desktop.getByRole('button', { name: '按单行本查看' }).click()
  await desktop.getByText(/已匹配源站 5\/5 话/).waitFor()
  await testSourceListing(desktop)
  assert.equal(await desktop.getByRole('link', { name: 'Bangumi 单行本' }).getAttribute('href'), 'https://bgm.tv/subject/143034')
  await desktop.getByRole('combobox', { name: '选择单行本' }).selectOption('2')
  await desktop.getByText('第 2 卷参考目录待确认，暂不自动归卷。').waitFor()
  assert.equal(await desktop.getByRole('checkbox').count(), 0)
  await desktop.getByRole('combobox', { name: '选择单行本' }).selectOption('1')
  assert.deepEqual(await desktop.getByRole('checkbox').evaluateAll((items) => items.map(
    (item) => item.getAttribute('aria-label'),
  )), ['第 1 话', '第 2 话', '第 3 话', '第 4 话', '第 5 话'])
  await desktop.getByRole('button', { name: '选择本卷可下载章节' }).click()
  await desktop.getByRole('button', { name: '下载选中章节（4）' }).click()
  await desktop.getByText('已在下载队列确认 4 个章节').waitFor()
  assert.deepEqual(submissions, [['1002', '1003', '1004', '1005']])
  await desktop.getByRole('combobox', { name: '选择单行本' }).selectOption('unassigned')
  await desktop.getByRole('checkbox', { name: '单行本封面 1～22' }).waitFor()
  assert.equal(await desktop.getByRole('checkbox', { name: '第 1 话', exact: true }).count(), 0)

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 })
  await prepare(mobile)
  await mobile.goto(base + '/#/manga/3503')
  await mobile.getByRole('button', { name: '按单行本查看' }).click()
  await mobile.getByText('以下 1 话由源站标注为第 2 卷。').waitFor()
  assert.equal(await mobile.getByRole('checkbox').count(), 1)
  assert.equal(await mobile.getByRole('combobox', { name: '选择单行本' }).locator('option[value="1"]').count(), 0)
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await mobile.goto(base + '/#/manga/3502')
  await mobile.getByRole('button', { name: '按单行本查看' }).click()
  await testSourceListing(mobile)
  let savedArchive = { enabled: false, sources: ['publisher', 'reference', 'opentome'] }
  const settings = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await settings.route('**/api/**', async (route) => {
    const target = new URL(route.request().url())
    if (target.pathname.endsWith('/download-folders/manga-archive')) savedArchive = route.request().postDataJSON()
    if (target.pathname.includes('/download-folders')) return route.fulfill({ json: {
      novel: { enabled: false, root: null, folder: null },
      manga: { enabled: true, root: '/manga', folder: '', archive: savedArchive },
    } })
    if (target.pathname === '/api/status') return route.fulfill({ json: { ok: true, dart: { available: true }, features: {} } })
    return route.fulfill({ json: target.pathname.endsWith('/auth/status') ? { enabled: false } : [] })
  })
  await settings.goto(base + '/#/settings')
  await settings.getByRole('switch', { name: '按单行本建立子目录' }).check()
  await settings.getByRole('checkbox', { name: 'OpenTomeDB 本地目录' }).uncheck()
  await settings.getByRole('button', { name: '保存漫画归档设置' }).click()
  await settings.getByText('漫画归档设置已保存').waitFor()
  await settings.reload()
  await settings.getByRole('switch', { name: '按单行本建立子目录' }).waitFor()
  assert.equal(await settings.getByRole('switch', { name: '按单行本建立子目录' }).isChecked(), true)
  assert.equal(await settings.getByRole('checkbox', { name: 'OpenTomeDB 本地目录' }).isChecked(), false)
  assert.equal(await settings.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  console.log('PASS desktop and mobile volume grouping, paginated lookup, version isolation, source listing import and chapter-only enqueue')
} finally {
  await browser.close()
}
