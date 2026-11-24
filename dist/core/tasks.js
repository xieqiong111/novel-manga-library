import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyEpub } from './integrity.js';
import { paginate } from './pagination.js';
import { safeResolve } from '../util/paths.js';
const TRANSITIONS = {
    queued: ['running', 'cancelled', 'failed', 'interrupted'],
    running: ['verifying', 'cancelling', 'failed', 'interrupted'],
    verifying: ['importing', 'cancelling', 'failed', 'interrupted'],
    importing: ['completed', 'cancelling', 'failed', 'interrupted'],
    cancelling: ['cancelled'],
    cancelled: ['queued'],
    failed: ['queued'],
    interrupted: ['queued'],
    completed: [],
};
/** Owns the download state machine: queue, progress, cancel, retry, recovery. */
export class TaskManager {
    config;
    store;
    bridge;
    library;
    registry;
    logger;
    active = new Map();
    queued = [];
    disposed = false;
    constructor(config, store, bridge, library, registry, logger) {
        this.config = config;
        this.store = store;
        this.bridge = bridge;
        this.library = library;
        this.registry = registry;
        this.logger = logger;
    }
    async init() {
        await this.store.load();
        await this.library.load();
        const recoverable = this.store.list().filter((t) => t.state === 'interrupted');
        for (const task of recoverable) {
            this.logger.info('tasks', 'recoverable', { taskId: task.id });
        }
        this.pump();
    }
    get(id) {
        return this.store.get(id);
    }
    list(options = {}) {
        return this.page(options).items;
    }
    records() {
        return this.store.records();
    }
    page(options = {}) {
        const query = (options.query ?? '').trim().toLowerCase();
        const records = [...this.records()].filter((task) => (!options.state || task.state === options.state) &&
            (!query || task.request.title.toLowerCase().includes(query)));
        records.sort((a, b) => (options.sort === 'oldest' ? 1 : -1) * a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
        return paginate(records, options);
    }
    async start(request) {
        this.assertOpen();
        if (request.language !== undefined) {
            try {
                const [language] = Intl.getCanonicalLocales(request.language);
                if (typeof request.language !== 'string' || !language || language.length > 64)
                    throw new RangeError();
                request = { ...request, language };
            }
            catch {
                throw new TaskManagerError('INVALID_LANGUAGE', 'Language must be a valid BCP 47 language tag');
            }
        }
        if (request.editionId !== undefined) {
            if (typeof request.editionId !== 'string' || !request.editionId.trim() || request.editionId.length > 128 ||
                /[\x00-\x1f\x7f]/.test(request.editionId)) {
                throw new TaskManagerError('INVALID_EDITION', 'Edition identifier must be a nonempty string of at most 128 characters');
            }
            request = { ...request, editionId: request.editionId.trim() };
        }
        const id = `task_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const now = new Date().toISOString();
        const record = {
            id,
            attemptId: randomUUID(),
            state: 'queued',
            createdAt: now,
            updatedAt: now,
            startedAt: null,
            finishedAt: null,
            request,
            progress: {
                phase: 'queued',
                percent: 0,
                volumesTotal: request.volumeNames.length || 1,
                volumesDone: 0,
                chaptersTotal: 0,
                chaptersDone: 0,
                currentVolume: null,
                currentChapter: null,
            },
            downloadedChapters: [],
            downloadedVolumes: [],
            artifacts: [],
            retryCount: 0,
            error: null,
            warnings: [],
        };
        await this.store.create(record);
        this.logger.info('tasks', 'queued', { taskId: id, bookId: request.bookId, volumes: request.volumes });
        this.queued.push(id);
        this.pump();
        return record;
    }
    async cancel(id) {
        if (!this.store.get(id))
            throw new TaskManagerError('TASK_NOT_FOUND', `Task not found: ${id}`);
        const updated = await this.store.update(id, (task) => {
            if (task.state === 'cancelling')
                return task;
            if (task.state === 'queued')
                return this.terminal(task, 'cancelled');
            if (!['running', 'verifying', 'importing'].includes(task.state)) {
                throw new TaskManagerError('NOT_CANCELABLE', `Task ${id} is already ${task.state}`);
            }
            return this.transition(task, 'cancelling');
        });
        const active = this.active.get(id);
        if (active && active.attemptId === updated.attemptId) {
            active.controller.abort();
            await active.done;
        }
        const task = this.store.get(id) ?? updated;
        if (task.state === 'cancelling') {
            throw new TaskManagerError('CANCEL_NOT_PERSISTED', 'Execution stopped but the final task state could not be saved');
        }
        return task.attemptId === updated.attemptId ? task : updated;
    }
    async retry(id) {
        this.assertOpen();
        if (!this.store.get(id))
            throw new TaskManagerError('TASK_NOT_FOUND', `Task not found: ${id}`);
        const updated = await this.store.update(id, (task) => {
            this.assertOpen();
            if (this.active.has(id) || !['failed', 'cancelled', 'interrupted'].includes(task.state)) {
                throw new TaskManagerError('NOT_RETRYABLE', `Task cannot be retried in state ${task.state} or while its previous attempt is exiting`);
            }
            if (task.retryCount >= this.config.maxRetries) {
                throw new TaskManagerError('RETRY_LIMIT', `Retry limit reached (${this.config.maxRetries})`);
            }
            return {
                ...this.transition(task, 'queued'),
                attemptId: randomUUID(),
                startedAt: null,
                finishedAt: null,
                retryCount: task.retryCount + 1,
                error: null,
                warnings: [],
                artifacts: [],
                downloadedChapters: [],
                downloadedVolumes: [],
                progress: { ...task.progress, phase: 'queued', percent: 0, volumesDone: 0,
                    chaptersDone: 0, chaptersTotal: 0, currentVolume: null, currentChapter: null },
            };
        });
        this.queued.push(id);
        this.pump();
        return updated;
    }
    async dispose() {
        this.disposed = true;
        this.queued.length = 0;
        const attempts = [...this.active.values()];
        for (const active of attempts)
            active.controller.abort();
        await Promise.all(attempts.map((active) => active.done));
    }
    assertOpen() {
        if (this.disposed)
            throw new TaskManagerError('SHUTTING_DOWN', 'Download executor is shutting down');
    }
    pump() {
        while (!this.disposed && this.active.size < Math.max(1, this.config.maxConcurrentDownloads) && this.queued.length > 0) {
            const id = this.queued.shift();
            const task = this.store.get(id);
            if (!task || task.state !== 'queued' || this.active.has(id))
                continue;
            const controller = new AbortController();
            const done = this.runTask(task, controller.signal).catch((error) => {
                this.logger.error('tasks', 'persist_failed', { taskId: id, error: String(error) });
            }).finally(() => {
                this.active.delete(id);
                this.pump();
            });
            this.active.set(id, { attemptId: task.attemptId, controller, done });
        }
    }
    async runTask(task, signal) {
        const { id, attemptId } = task;
        if (!attemptId)
            throw new Error('Queued task has no attempt identifier');
        const outputDir = safeResolve(this.config.tasksDir, 'work', id, attemptId);
        const cancelFile = this.store.cancelFilePath(id, attemptId);
        const chapters = new Set();
        let progressSavedAt = 0;
        const update = (mutate) => this.store.update(id, (current) => {
            if (current.attemptId !== attemptId)
                throw new TaskManagerError('STALE_ATTEMPT', 'Task attempt has changed');
            return mutate(current);
        });
        const advance = (current, state) => {
            signal.throwIfAborted();
            if (current.state === 'cancelling')
                throw new TaskManagerError('CANCELLED', 'Cancelled by user');
            return this.transition(current, state);
        };
        try {
            await update((current) => ({
                ...advance(current, 'running'),
                startedAt: new Date().toISOString(),
                progress: { ...current.progress, phase: 'starting' },
            }));
            const result = await this.bridge.run({
                command: 'pack',
                url: task.request.sourceUrl,
                sourceId: task.request.sourceId,
                volumes: task.request.volumes,
                outputDir,
                combine: task.request.combine,
                addChapterTitle: task.request.addChapterTitle,
                allowedSources: this.registry.dartAllowedSources(this.config),
                cancelFile,
                signal,
                onProgress: (event) => {
                    if (event.chapter)
                        chapters.add(event.chapter);
                    if (Date.now() - progressSavedAt < 250 && event.phase === 'chapter')
                        return;
                    progressSavedAt = Date.now();
                    void update((current) => current.state === 'running' ? this.applyProgress(current, event) : current)
                        .catch((error) => this.logger.warn('tasks', 'progress_not_saved', { taskId: id, error: String(error) }));
                },
            });
            await update((current) => advance(current, 'verifying'));
            if (!result.data.artifacts?.length)
                throw new TaskManagerError('NO_ARTIFACTS', 'The downloader returned no EPUB files');
            const artifacts = [];
            const root = await realpath(outputDir);
            const seen = new Set();
            for (const raw of result.data.artifacts) {
                signal.throwIfAborted();
                if (typeof raw.path !== 'string' || !path.isAbsolute(raw.path)) {
                    throw new TaskManagerError('INVALID_ARTIFACT', 'The downloader returned a non-absolute artifact path');
                }
                const relative = raw.path.startsWith(outputDir + path.sep)
                    ? path.relative(outputDir, raw.path) : path.relative(root, raw.path);
                const file = safeResolve(root, relative);
                if (!relative || seen.has(file) || await realpath(file) !== file || !(await lstat(file)).isFile()) {
                    throw new TaskManagerError('INVALID_ARTIFACT', 'The downloader returned an invalid or duplicate artifact path');
                }
                seen.add(file);
                const integrity = await verifyEpub(file);
                artifacts.push({
                    path: file, volumeNames: raw.volumeNames ?? [], chapters: integrity.chapters, bytes: integrity.bytes,
                    sha256: integrity.sha256, integrity: integrity.ok ? 'ok' : 'failed',
                    integrityError: integrity.ok ? null : integrity.problems.join('; '),
                });
            }
            await update((current) => ({ ...current, artifacts }));
            const failed = artifacts.filter((artifact) => artifact.integrity !== 'ok');
            if (failed.length)
                throw new TaskManagerError('INTEGRITY_FAILED', failed.map((artifact) => artifact.integrityError).join(' | '));
            await update((current) => advance(current, 'importing'));
            for (const artifact of artifacts) {
                signal.throwIfAborted();
                const entry = await this.library.add({ ...task.request, artifact, taskId: id, signal });
                if (!entry)
                    throw new TaskManagerError('INTEGRITY_FAILED', 'EPUB failed library verification');
                await update((current) => ({ ...current, downloadedVolumes: [...current.downloadedVolumes, ...entry.volumeNames] }));
            }
            const count = artifacts.reduce((sum, item) => sum + item.chapters, 0);
            await update((current) => ({
                ...advance(current, 'completed'),
                finishedAt: new Date().toISOString(),
                downloadedChapters: [...chapters],
                warnings: [
                    ...current.warnings,
                    ...(result.data.downloadedChapters != null && result.data.downloadedChapters !== count
                        ? [`Dart reported ${result.data.downloadedChapters} chapters, EPUB contains ${count}`] : []),
                ],
                progress: { ...current.progress, phase: 'completed', percent: 100,
                    chaptersTotal: count, chaptersDone: count, volumesDone: artifacts.length },
            }));
        }
        catch (error) {
            const cause = error;
            await update((current) => {
                if (!['queued', 'running', 'verifying', 'importing', 'cancelling'].includes(current.state))
                    return current;
                const state = current.state === 'cancelling' ? 'cancelled' : signal.aborted ? 'interrupted' : 'failed';
                return { ...this.terminal(current, state, { code: cause.code ?? 'UNKNOWN', message: cause.message ?? String(error) }),
                    downloadedChapters: [...chapters] };
            });
            this.logger.warn('tasks', 'attempt_stopped', { taskId: id, attemptId, code: cause.code ?? 'UNKNOWN' });
        }
        finally {
            await rm(cancelFile, { force: true }).catch(() => undefined);
        }
    }
    transition(task, state) {
        if (!TRANSITIONS[task.state].includes(state)) {
            throw new TaskManagerError('INVALID_TRANSITION', `Cannot move task from ${task.state} to ${state}`);
        }
        return { ...task, state, progress: { ...task.progress, phase: state } };
    }
    terminal(task, state, cause) {
        const error = state === 'cancelled' ? { code: 'CANCELLED', message: 'Cancelled by user' }
            : state === 'interrupted' ? { code: 'INTERRUPTED', message: 'Download executor stopped' } : cause ?? null;
        return { ...this.transition(task, state), error, finishedAt: new Date().toISOString() };
    }
    applyProgress(task, event) {
        const progress = { ...task.progress };
        if (event.phase === 'volume_start') {
            progress.phase = 'downloading';
            progress.currentVolume = event.volume ?? null;
        }
        else if (event.phase === 'chapter') {
            progress.phase = 'downloading';
            progress.currentChapter = event.chapter ?? null;
            progress.currentVolume = event.volume ?? progress.currentVolume;
            progress.chaptersTotal = event.chapterTotal ?? progress.chaptersTotal;
            progress.chaptersDone = Math.max(0, (event.chapterIndex ?? 1) - 1);
            const done = progress.chaptersDone / Math.max(1, progress.chaptersTotal);
            progress.percent = Math.min(95, Math.round(done * 95));
        }
        else if (event.phase === 'volume_done') {
            progress.volumesDone += 1;
            progress.percent = Math.min(99, Math.round((progress.volumesDone / Math.max(1, progress.volumesTotal)) * 99));
            progress.phase = 'packing';
        }
        return { ...task, progress };
    }
}
export class TaskManagerError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'TaskManagerError';
    }
}
//# sourceMappingURL=tasks.js.map