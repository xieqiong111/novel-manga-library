import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { MetadataError } from './bangumi-komga.mjs'

const timeoutMs = 16000

export async function startBangumiWorker(settings, logger) {
  if (!settings.bangumiKomgaScript || settings.bangumiKomgaUrl) return

  const cwd = path.join(settings.config.dataDir, 'bangumikomga-worker')
  try {
    await mkdir(path.join(cwd, 'logs'), { recursive: true, mode: 0o700 })
  } catch {
    logger.warn('bangumikomga', 'worker_storage_unavailable')
    return
  }

  const pending = new Map()
  let nextId = 0
  let child
  let retry
  let stopped = false
  let failures = 0
  const unavailable = () => new MetadataError(502, 'BANGUMIKOMGA_UNAVAILABLE', '内置 BangumiKomga 暂不可用。')

  function settle(id, callback) {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    clearTimeout(entry.timer)
    callback(entry)
  }

  function rejectPending() {
    for (const id of pending.keys()) settle(id, (entry) => entry.reject(unavailable()))
  }

  function launch() {
    const startedAt = Date.now()
    child = spawn(settings.bangumiKomgaPython, [settings.bangumiKomgaScript], {
      cwd, stdio: ['pipe', 'pipe', 'ignore'],
      env: {
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        PYTHONDONTWRITEBYTECODE: '1',
        LD_LIBRARY_PATH: settings.bangumiKomgaLibraryPath,
        BANGUMI_ARCHIVE_DIR: settings.bangumiArchiveDir,
      },
    })
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => {
      let reply
      try { reply = JSON.parse(line) } catch {
        logger.warn('bangumikomga', 'worker_invalid_response')
        return
      }
      if (!Number.isInteger(reply?.id) || !Number.isInteger(reply.status)) return
      settle(reply.id, (entry) => entry.resolve(reply))
    })
    child.stdin.on('error', rejectPending)
    child.on('error', (error) => logger.warn('bangumikomga', 'worker_spawn_failed', { code: error.code }))
    child.once('close', (code, signal) => {
      lines.close()
      rejectPending()
      child = undefined
      if (stopped) return
      logger.warn('bangumikomga', 'worker_exited', { code, signal })
      if (Date.now() - startedAt > 60_000) failures = 0
      failures += 1
      if (failures < 4) {
        retry = setTimeout(launch, failures * 2000)
        retry.unref()
      }
    })
  }

  launch()
  return {
    request(operation, params, connection) {
      if (stopped || !child?.stdin?.writable) return Promise.reject(unavailable())
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => settle(id, (entry) =>
          entry.reject(new MetadataError(504, 'BANGUMIKOMGA_TIMEOUT', '内置 BangumiKomga 响应超时。'))), timeoutMs)
        pending.set(id, { resolve, reject, timer })
        const bangumi = connection ?? settings.integrations?.bangumi ?? {
          sourceMode: settings.bangumiArchiveDir ? 'archive' : 'live',
          accessToken: settings.bangumiAccessToken ?? '',
        }
        child.stdin.write(JSON.stringify({ id, operation, params, bangumi }) + '\n', (error) => {
          if (error) settle(id, (entry) => entry.reject(unavailable()))
        })
      })
    },
    stop() {
      stopped = true
      clearTimeout(retry)
      rejectPending()
      child?.kill('SIGTERM')
    },
  }
}
