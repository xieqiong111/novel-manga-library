import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson, readJson } from '../util/json.js';
import { assertSafeRelative } from '../util/paths.js';
/**
 * One JSON file per task, written atomically. On restart, tasks left in
 * `running`/`queued` are marked `interrupted` so they can be retried rather
 * than silently lost (crash recovery).
 */
export class TaskStore {
    tasksDir;
    logger;
    tasks = new Map();
    chains = new Map();
    loading;
    constructor(tasksDir, logger) {
        this.tasksDir = tasksDir;
        this.logger = logger;
    }
    filePath(id) {
        return path.join(this.tasksDir, `${assertSafeRelative(id)}.json`);
    }
    cancelFilePath(id, attemptId) {
        return path.join(this.tasksDir, `${assertSafeRelative(id)}${attemptId ? '.' + assertSafeRelative(attemptId) : ''}.cancel`);
    }
    load() {
        this.loading ??= this.loadRecords().catch((error) => {
            this.loading = undefined;
            throw error;
        });
        return this.loading;
    }
    async loadRecords() {
        let files;
        try {
            files = await readdir(this.tasksDir);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            return;
        }
        for (const file of files.filter((f) => f.endsWith('.json'))) {
            const record = await readJson(path.join(this.tasksDir, file), null);
            if (!record?.id || file !== `${record.id}.json`)
                continue;
            if (['queued', 'running', 'verifying', 'importing', 'cancelling'].includes(record.state)) {
                record.state = 'interrupted';
                record.progress = { ...record.progress, phase: 'interrupted' };
                record.error = { code: 'INTERRUPTED', message: 'Process restarted while the task was active' };
                record.finishedAt = record.updatedAt = new Date().toISOString();
                await atomicWriteJson(this.filePath(record.id), record);
                this.logger.warn('store', 'recovered_interrupted_task', { taskId: record.id });
            }
            this.tasks.set(record.id, record);
        }
    }
    list() {
        return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    records() {
        return this.tasks.values();
    }
    get(id) {
        return this.tasks.get(id);
    }
    async create(record) {
        assertSafeRelative(record.id);
        await this.load();
        return this.serialize(record.id, async () => {
            if (this.tasks.has(record.id))
                throw new Error(`TASK_ALREADY_EXISTS: ${record.id}`);
            await this.persist(record);
            return record;
        });
    }
    async update(id, mutate) {
        assertSafeRelative(id);
        await this.load();
        return this.serialize(id, async () => {
            const current = this.tasks.get(id);
            if (!current)
                throw new Error(`TASK_NOT_FOUND: ${id}`);
            const next = mutate(structuredClone(current));
            next.updatedAt = new Date().toISOString();
            await this.persist(next);
            return next;
        });
    }
    async remove(id) {
        assertSafeRelative(id);
        await this.load();
        await this.serialize(id, async () => {
            await rm(this.filePath(id), { force: true });
            this.tasks.delete(id);
            await rm(this.cancelFilePath(id), { force: true });
        });
    }
    async persist(record) {
        await atomicWriteJson(this.filePath(record.id), record);
        this.tasks.set(record.id, record);
    }
    serialize(id, operation) {
        const result = (this.chains.get(id) ?? Promise.resolve()).then(operation);
        const tail = result.then(() => undefined, () => undefined);
        this.chains.set(id, tail);
        void tail.then(() => {
            if (this.chains.get(id) === tail)
                this.chains.delete(id);
        });
        return result;
    }
}
//# sourceMappingURL=store.js.map