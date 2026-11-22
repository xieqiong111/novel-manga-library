import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { createMangaVolumeCatalogApi } from '../../server/manga-volume-api.mjs'
import { mergeVolumeSources } from '../../server/manga-volume-catalog.mjs'
import { readPublisherVolume } from '../../server/manga-publisher.mjs'
import { openTomeVolumes } from '../../server/opentome-volumes.mjs'

const sample = { id: '3502', sourceId: '774030471139699415', title: '为美好的世界献上祝福！',
  url: 'https://baozimh.org/manga/weimeihaodeshijiexianshangzhufu-xiaonatumetuntamazi' }

it('binds the reference catalog to the exact work and keeps unconfirmed mappings separate', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-volume-'))
  try {
    const downloadFoldersFile = path.join(root, 'folders.json')
    await writeFile(downloadFoldersFile, JSON.stringify({
      novelFolder: null, mangaFolder: '', mangaPrevious: [], mangaArchive: { enabled: true, sources: ['publisher', 'reference'] },
    }))
    await mkdir(path.join(root, 'bangumi-manga'))
    await writeFile(path.join(root, 'bangumi-manga', '3502.json'), JSON.stringify({
      mangaId: '3502', sourceId: sample.sourceId, subjectId: 143035, title: sample.title,
    }))
    const metadata = vi.fn(async () => ({ volumes: [
      { id: 143034, name: '日文名 (1)' }, { id: 660279, name: '日文名 (23)' },
    ] }))
    const service = createMangaVolumeCatalogApi({ settings: { config: { downloadFoldersFile } },
      mangaClient: { getManga: async () => sample }, metadata })
    const result = await service.update('3502', {})
    expect(result.volumes).toHaveLength(23)
    expect(result.volumes[0]).toMatchObject({ number: 1, chapters: ['1', '2', '3', '4', '5'], source: 'publisher', confirmed: true })
    expect(result.volumes[21]).toMatchObject({ number: 22, confirmed: false })
    expect(result.volumeMetadata).toEqual([{ number: 1, subjectId: 143034 }, { number: 23, subjectId: 660279 }])
    const persisted = await service.get('3502')
    expect(persisted.volumes).toEqual(result.volumes)
    expect(metadata).toHaveBeenCalledWith('related-volumes', { subjectId: 143035 }, undefined, undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('holds conflicting assignments for review and reads only an explicit official contents list', async () => {
  const sources = ['reference', 'publisher', 'opentome']
  const result = mergeVolumeSources([
    { number: 1, chapters: ['1', '2'], source: 'reference', confirmed: true },
    { number: 1, chapters: ['1'], source: 'opentome', confirmed: true },
    { number: 2, chapters: ['2', '3'], source: 'publisher', confirmed: true },
  ], sources)
  expect(result.map((row) => [row.number, row.confirmed, row.conflict])).toEqual([[1, false, true], [2, false, true]])

  const reply = vi.fn(async () => new Response('<h1>Test, Vol. 1 (manga)</h1><ol><li>Cover</li><li>Contents</li>' +
    '<li>Chapter 1: Title</li><li>Chapter 2: Title</li></ol>', { headers: { 'content-type': 'text/html' } }))
  const url = 'https://yenpress.com/titles/9780316552561-title-vol-1-manga'
  expect(await readPublisherVolume(url, reply)).toMatchObject({ isbn: '9780316552561', chapters: ['1', '2'] })
  expect(reply.mock.calls[0]).toMatchObject([new URL(url), { redirect: 'error' }])
  await expect(readPublisherVolume('https://yenpress.com@127.0.0.1/titles/a', reply)).rejects.toMatchObject({
    code: 'INVALID_PUBLISHER_PAGE',
  })
  expect(reply).toHaveBeenCalledOnce()
})

it('uses OpenTomeDB only after an exact volume ISBN resolves a unique manga edition', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-opentome-'))
  try {
    const filename = path.join(root, 'catalog.sqlite')
    const db = new DatabaseSync(filename)
    db.exec(`CREATE TABLE series (gcd_series_id INTEGER, tome_id TEXT, tome_work_id TEXT, medium TEXT, is_omnibus INTEGER);
      CREATE TABLE volumes (gcd_series_id INTEGER, volume_number INTEGER, isbn13 TEXT, volume_chapters TEXT);
      INSERT INTO series VALUES (1,'rl_a','w_a','manga',0), (2,'rl_b','w_b','light novel',0);
      INSERT INTO volumes VALUES (1,1,'9784040705392','[1,2]'), (1,2,'9784040707822',NULL),
        (2,1,'9784040705392','[3,4]');`)
    db.close()
    expect(openTomeVolumes(filename, '9784040705392', 1)).toMatchObject({
      line: 'rl_a', volumes: [{ number: 1, chapters: ['1', '2'] }],
    })
    expect(() => openTomeVolumes(filename, '9784040705392', 2)).toThrow(/ISBN/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
