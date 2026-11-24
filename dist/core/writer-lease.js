import { DatabaseSync } from 'node:sqlite';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
/** A reserved SQLite lock is released by the OS even when the writer crashes. */
export async function acquireWriterLease(directories) {
    const roots = [...new Set(await Promise.all(directories.map((dir) => realpath(dir))))].sort();
    const databases = [];
    const release = () => {
        for (const db of databases.splice(0).reverse())
            db.close();
    };
    try {
        for (const root of roots) {
            const file = path.join(root, '.novel-manga-writer.sqlite');
            const info = await lstat(file).catch((error) => {
                if (error.code === 'ENOENT')
                    return undefined;
                throw error;
            });
            if (info && !info.isFile())
                throw new Error(`Invalid writer lock file in ${root}`);
            try {
                const db = new DatabaseSync(file, { timeout: 0 });
                databases.push(db);
                db.exec('BEGIN IMMEDIATE');
            }
            catch (error) {
                if (error.errcode !== 5)
                    throw error;
                throw new Error(`DATA_WRITER_BUSY: ${root}. Use Studio managed mode or separate writable directories.`, { cause: error });
            }
        }
        return release;
    }
    catch (error) {
        release();
        throw error;
    }
}
//# sourceMappingURL=writer-lease.js.map