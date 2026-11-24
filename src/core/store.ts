import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { TaskRecord } from '../types.js'
import { atomicWriteJson, readJson } from '../util/json.js'
import { assertSafeRelative } from '../util/paths.js'
import type { Logger } from '../util/logger.js'

/**
 * One JSON file per task, written atomically. On restart, tasks left in
 * `running`/`queued` are marked `interrupted` so they can be retried rather
 * than silently lost (crash recovery).
 */
export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly chains = new Map<string, Promise<void>>()
  private loading?: Promise<void>

  constructor(private readonly tasksDir: string, private readonly logger: Logger) {}

  private filePath(id: string): string {
    return path.join(this.tasksDir, `${assertSafeRelative(id)}.json`)
  }

  cancelFilePath(id: string, attemptId?: string): string {
    return path.join(this.tasksDir, `${assertSafeRelative(id)}${attemptId ? '.' + assertSafeRelative(attemptId) : ''}.cancel`)
  }

  load(): Promise<void> {
    this.loading ??= this.loadRecords().catch((error) => {
      this.loading = undefined
      throw error
    })
    return this.loading
  }

  private async loadRecords(): Promise<void> {
    let files: string[]
    try {
      files = await readdir(this.tasksDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return
    }
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      const record = await readJson<TaskRecord | null>(path.join(this.tasksDir, file), null)
      if (!record?.id || file !== `${record.id}.json`) continue
      if (['queued', 'running', 'verifying', 'importing', 'cancelling'].includes(record.state)) {
        record.state = 'interrupted'
        record.progress = { ...record.progress, phase: 'interrupted' }
        record.error = { code: 'INTERRUPTED', message: 'Process restarted while the task was active' }
        record.finishedAt = record.updatedAt = new Date().toISOString()
        await atomicWriteJson(this.filePath(record.id), record)
        this.logger.warn('store', 'recovered_interrupted_task', { taskId: record.id })
      }
      this.tasks.set(record.id, record)
    }
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  records(): IterableIterator<TaskRecord> {
    return this.tasks.values()
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id)
  }

  async create(record: TaskRecord): Promise<TaskRecord> {
    assertSafeRelative(record.id)
    await this.load()
    return this.serialize(record.id, async () => {
      if (this.tasks.has(record.id)) throw new Error(`TASK_ALREADY_EXISTS: ${record.id}`)
      await this.persist(record)
      return record
    })
  }

  async update(id: string, mutate: (current: TaskRecord) => TaskRecord): Promise<TaskRecord> {
    assertSafeRelative(id)
    await this.load()
    return this.serialize(id, async () => {
      const current = this.tasks.get(id)
      if (!current) throw new Error(`TASK_NOT_FOUND: ${id}`)
      const next = mutate(structuredClone(current))
      next.updatedAt = new Date().toISOString()
      await this.persist(next)
      return next
    })
  }

  async remove(id: string): Promise<void> {
    assertSafeRelative(id)
    await this.load()
    await this.serialize(id, async () => {
      await rm(this.filePath(id), { force: true })
      this.tasks.delete(id)
      await rm(this.cancelFilePath(id), { force: true })
    })
  }

  private async persist(record: TaskRecord): Promise<void> {
    await atomicWriteJson(this.filePath(record.id), record)
    this.tasks.set(record.id, record)
  }

  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.chains.get(id) ?? Promise.resolve()).then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.chains.set(id, tail)
    void tail.then(() => {
      if (this.chains.get(id) === tail) this.chains.delete(id)
    })
    return result
  }
}
