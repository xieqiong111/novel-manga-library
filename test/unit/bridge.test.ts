import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: spawnMock }
})

import { spawn } from 'node:child_process'
import { DartBridge } from '../../src/core/bridge.js'
import { Config, resolveConfig } from '../../src/config.js'
import { createLogger } from '../../src/util/logger.js'

afterEach(() => {
  spawnMock.mockReset()
  vi.unstubAllEnvs()
})

const testDirectories: string[] = []
async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  testDirectories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(testDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** Minimal child process that emits exactly one NDJSON result line. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    killed: boolean
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = vi.fn(() => { child.killed = true; return true })
  setTimeout(() => {
    child.stdout.write('{"type":"result","ok":true,"data":{"novel":{"id":"1"}}}\n')
    child.emit('close', 0)
  }, 0)
  return child
}

describe('DartBridge spawn environment (regression: live scrape as non-root)', () => {
  it('runs AOT binaries from a writable cwd and pins the upstream log to an absolute path', async () => {
    vi.stubEnv('LN_DART_BINARY', undefined)
    const work = await temporaryDirectory('ln-bridge-binary-')
    const binary = path.join(work, 'bnp_headless')
    await writeFile(binary, '', { mode: 0o700 })
    const config = resolveConfig(Config({
      dartBinary: binary,
      dataDir: work,
      dartProjectDir: path.join(work, 'vendor'),
    }), '/pkg', '/home/test')
    const bridge = new DartBridge(config, createLogger('/tmp/ln-test-logs'))
    spawnMock.mockImplementation(() => fakeChild())

    const result = await bridge.run({ command: 'details', url: 'https://www.bilinovel.net/novel/2059.html', sourceId: 'bilinovel', allowedSources: ['bilinovel'] })
    expect(result.data).toEqual({ novel: { id: '1' } })
    expect(spawnMock).toHaveBeenCalledTimes(1)

    const options = vi.mocked(spawn).mock.calls[0]![2]!
    // AOT binaries must not inherit the read-only vendor tree as cwd, or the
    // upstream `File('bili_novel.log')` throws EACCES on the first live request.
    expect(options.cwd).toBe(config.dataDir)
    expect(options.cwd).not.toBe(config.dartProjectDir)
    expect(options.env?.BNP_LOG_FILE).toBe(path.join(config.logsDir, 'bili_novel.log'))
    expect(options.env?.BNP_LOG_FILE?.startsWith('/')).toBe(true)
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe'])
  })

  it('keeps the project root as cwd for the `dart run` fallback', async () => {
    vi.stubEnv('LN_DART_BINARY', undefined)
    // Isolated project with a headless entry but NO compiled AOT binary, so
    // resolveRunner() is forced down the `dart run` path.
    const projectDir = await temporaryDirectory('ln-bridge-project-')
    await mkdir(path.join(projectDir, 'bin'), { recursive: true })
    await writeFile(path.join(projectDir, 'bin', 'headless.dart'), '// test entry\n')
    await writeFile(path.join(projectDir, 'bin', 'dart'), '', { mode: 0o700 })
    vi.stubEnv('LN_DART_SDK', projectDir)
    const config = resolveConfig(Config({
      dartBinary: '',
      dataDir: '/tmp/ln-bridge-test/data2',
      dartProjectDir: projectDir,
    }), '/pkg', '/home/test')
    const bridge = new DartBridge(config, createLogger('/tmp/ln-test-logs'))
    spawnMock.mockImplementation(() => fakeChild())

    await bridge.run({ command: 'details', url: 'https://www.bilinovel.net/novel/2059.html', sourceId: 'bilinovel', allowedSources: ['bilinovel'] })
    const options = vi.mocked(spawn).mock.calls[0]![2]!
    expect(options.cwd).toBe(projectDir)
    expect(options.env?.BNP_LOG_FILE).toBe(path.join(config.logsDir, 'bili_novel.log'))
  })

  it('reports a missing configured executable before calling spawn', async () => {
    const work = await temporaryDirectory('ln-bridge-missing-')
    const config = resolveConfig(Config({ dartBinary: path.join(work, 'missing'), dataDir: work }), '/pkg', '/home/test')
    const bridge = new DartBridge(config, createLogger(path.join(work, 'logs')))
    await expect(bridge.probe()).resolves.toMatchObject({ available: false, runner: null })
    await expect(bridge.run({
      command: 'volumes', url: 'https://www.bilinovel.net/novel/2044.html', sourceId: 'bilinovel', allowedSources: ['bilinovel'],
    })).rejects.toMatchObject({ code: 'DART_UNAVAILABLE' })
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
