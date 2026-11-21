import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { startBangumiWorker } from '../../server/bangumi-worker.mjs'

it('uses the saved Bangumi source for each request through the embedded converter', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'studio-bangumi-worker-'))
  const script = path.join(dataDir, 'bridge.mjs')
  await writeFile(script, `
    import { createInterface } from 'node:readline'
    for await (const input of createInterface({ input: process.stdin })) {
      const request = JSON.parse(input)
      const { id, operation, params, bangumi } = request
      console.log(JSON.stringify({ id, status: 200, payload: {
        operation, params, source: bangumi.sourceMode, hasToken: Boolean(bangumi.accessToken), proxyUrl: bangumi.proxyUrl,
      } }))
    }
  `)
  const bangumi = { sourceMode: 'archive', accessToken: '', proxyUrl: 'http://proxy.example:7890' }
  const worker = await startBangumiWorker({
    config: { dataDir },
    bangumiKomgaScript: script, bangumiKomgaPython: process.execPath, integrations: { bangumi },
  }, { warn: vi.fn() })
  try {
    const params = { kind: 'novel', scope: 'series', query: '星海旅途' }
    expect(await worker?.request('search', params)).toMatchObject({
      status: 200, payload: { source: 'archive', operation: 'search', params },
    })
    expect(await worker?.request('test', {}, { sourceMode: 'live', accessToken: 'draft', proxyUrl: 'https://draft.example' })).toMatchObject({
      status: 200, payload: { source: 'live', operation: 'test', hasToken: true, proxyUrl: 'https://draft.example' },
    })
    expect(await worker?.request('search', params)).toMatchObject({
      status: 200, payload: { source: 'archive', proxyUrl: 'http://proxy.example:7890' },
    })
    bangumi.sourceMode = 'live'
    bangumi.accessToken = 'private-fixture'
    expect(await worker?.request('metadata', { ...params, subjectId: 123 })).toMatchObject({
      status: 200, payload: { source: 'live', operation: 'metadata', hasToken: true },
    })
  } finally {
    worker?.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})
