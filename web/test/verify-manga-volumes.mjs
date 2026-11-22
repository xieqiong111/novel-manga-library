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

try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const submissions = await prepare(desktop)
  await desktop.goto(base + '/#/manga/3502')
  await desktop.getByRole('checkbox', { name: '第 105 话', exact: true }).waitFor()
  await desktop.getByRole('button', { name: '按单行本查看' }).click()
  await desktop.getByText(/已匹配源站 5\/5 话/).waitFor()
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
  console.log('PASS desktop and mobile volume grouping, paginated lookup, version isolation and chapter-only enqueue')
} finally {
  await browser.close()
}
