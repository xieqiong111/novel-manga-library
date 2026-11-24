import type { TaskRecord } from '../types.js';
import type { Logger } from '../util/logger.js';
/**
 * One JSON file per task, written atomically. On restart, tasks left in
 * `running`/`queued` are marked `interrupted` so they can be retried rather
 * than silently lost (crash recovery).
 */
export declare class TaskStore {
    private readonly tasksDir;
    private readonly logger;
    private readonly tasks;
    private readonly chains;
    private loading?;
    constructor(tasksDir: string, logger: Logger);
    private filePath;
    cancelFilePath(id: string, attemptId?: string): string;
    load(): Promise<void>;
    private loadRecords;
    list(): TaskRecord[];
    records(): IterableIterator<TaskRecord>;
    get(id: string): TaskRecord | undefined;
    create(record: TaskRecord): Promise<TaskRecord>;
    update(id: string, mutate: (current: TaskRecord) => TaskRecord): Promise<TaskRecord>;
    remove(id: string): Promise<void>;
    private persist;
    private serialize;
}
