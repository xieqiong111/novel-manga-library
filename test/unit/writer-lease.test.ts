import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { acquireWriterLease } from '../../src/core/writer-lease.js'

it('blocks a second process using the same data until the first process dies', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ln-writer-'))
  const module = new URL('../../src/core/writer-lease.ts', import.meta.url).href
  const script = `const { acquireWriterLease } = await import(${JSON.stringify(module)});
    const release = await acquireWriterLease([process.argv[1]]);
    console.log('ready'); setInterval(() => {}, 60_000);`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory], { stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  try {
    const first = await Promise.race([once(child.stdout, 'data'), closed.then(() => [])])
    expect(String(first[0])).toContain('ready')
    await expect(acquireWriterLease([directory])).rejects.toThrow('DATA_WRITER_BUSY')
    child.kill('SIGKILL')
    await closed
    const release = await acquireWriterLease([directory])
    release()
  } finally {
    child.kill()
    await closed
    await rm(directory, { recursive: true, force: true })
  }
})
