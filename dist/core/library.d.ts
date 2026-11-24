import type { DownloadRequest, LibraryEntry, TaskArtifact } from '../types.js';
import type { Logger } from '../util/logger.js';
type ImportInput = Pick<DownloadRequest, 'title' | 'author' | 'sourceId' | 'bookId' | 'bangumi' | 'language' | 'editionId'> & {
    artifact: TaskArtifact;
    taskId: string;
    signal?: AbortSignal;
};
/** On-disk EPUB library with integrity verification and a portable index. */
export declare class Library {
    private readonly libraryDir;
    private readonly logger;
    private readonly storage?;
    private entries;
    private legacyConflicts;
    private loading?;
    private mutations;
    constructor(libraryDir: string, logger: Logger, storage?: {
        root: string;
        settingsFile: string;
    } | undefined);
    private root;
    filePath(entry: LibraryEntry): Promise<string>;
    private get indexPath();
    private get journalPath();
    private get removalPath();
    load(): Promise<void>;
    private loadIndex;
    list(options?: {
        query?: string;
        limit?: number;
    }): LibraryEntry[];
    page(options?: {
        query?: string;
        limit?: number;
        offset?: number;
        integrity?: LibraryEntry['integrity'];
        sort?: 'recent' | 'name' | 'size';
    }): import("./pagination.js").Page<LibraryEntry>;
    forTask(taskId: string): LibraryEntry[];
    archivedPaths(): string[];
    get(id: string): LibraryEntry | undefined;
    stats(): {
        bySource: {
            [k: string]: number;
        };
        total: number;
        bytes: number;
        chapters: number;
        ok: number;
        failed: number;
    };
    /** One writer stages and commits one verified volume at a time. */
    add(input: ImportInput): Promise<LibraryEntry | null>;
    private ingest;
    private checkSeries;
    private stagingPath;
    private recoverImport;
    private commitImport;
    /** Re-verify a single entry or the whole library. */
    verify(id?: string): Promise<Array<{
        id: string;
        ok: boolean;
        problems: string[];
        sha256Changed: boolean;
    }>>;
    private verifyEntries;
    readChecksums(): Promise<string[]>;
    remove(id: string): Promise<boolean>;
    private removeEntry;
    private recoverRemoval;
    private commitRemoval;
    private persist;
    private mutate;
}
export {};
