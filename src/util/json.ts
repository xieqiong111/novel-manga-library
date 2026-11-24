import { mkdir, open, readFile, rename, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Write JSON atomically (temp file in the same directory + rename). */
export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function atomicWriteText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true })
    await rename(tmp, filePath)
    await syncDirectory(path.dirname(filePath))
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return fallback
    // A torn/partially written file must not corrupt the whole store.
    if (error instanceof SyntaxError) return fallback
    throw error
  }
}

/** Lossless JSON used by tool canonical values. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}
