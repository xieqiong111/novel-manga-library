/** A reserved SQLite lock is released by the OS even when the writer crashes. */
export declare function acquireWriterLease(directories: string[]): Promise<() => void>;
