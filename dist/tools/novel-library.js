import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { safeResolve } from '../util/paths.js';
import { studioDelegated, studioJob } from '../../server/studio-jobs.mjs';
import { jsonOutput, ok, runTool } from './common.js';
const ACTIONS = ['list', 'get', 'stats', 'verify', 'checksums', 'remove', 'status'];
/** Give the agent a usable absolute path while keeping the stored path relative. */
function withAbsolute(runtime, entry) {
    return {
        ...entry,
        absolutePath: safeResolve(runtime.config.libraryDir, entry.relativePath),
    };
}
/**
 * Requirement #9: on-disk library with integrity verification. Entries expose
 * only plugin-managed relative paths; absolute paths are re-derived through
 * safeResolve so a corrupted index can never point outside the library root.
 */
export function registerNovelLibrary(ctx, runtime) {
    ctx.tools.register(defineTool({
        name: 'novel_library',
        description: [
            'Browse and verify the EPUB library produced by completed downloads. Actions: list, get, stats, verify, checksums, remove, status.',
            'In managed mode, use the returned downloadPath against the Studio API. The file resides in Studio and removal requires an administrator session.',
            'verify re-checks ZIP/EPUB structure and sha256 sidecars for one entry (id) or the whole library; remove deletes one entry only when confirm=true.',
            'checksums returns the sha256 sidecar lines for external verification; stats aggregates counts, bytes, chapters and integrity.',
        ].join(' '),
        parameters: {
            action: {
                type: 'string',
                description: 'One of: list (default), get, stats, verify, checksums, remove, status.',
            },
            id: { type: 'string', description: 'Library entry id (lib_...). Required for get/remove, optional for verify.' },
            query: { type: 'string', description: 'Optional case-insensitive title/author/volume filter for list.' },
            limit: { type: 'number', description: 'Max entries for list (default 20).' },
            confirm: { type: 'boolean', description: 'Must be true for the destructive remove action.' },
        },
        output: jsonOutput(),
        async execute(args) {
            return runTool(runtime, 'novel_library', async () => {
                const action = (args.action ?? 'list').trim().toLowerCase();
                if (!ACTIONS.includes(action)) {
                    return { ok: false, error: { code: 'UNKNOWN_ACTION', message: `action must be one of ${ACTIONS.join(', ')}` } };
                }
                const limit = Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 200);
                if (studioDelegated()) {
                    if (action === 'remove')
                        return { ok: false, error: {
                                code: 'STUDIO_ADMIN_REQUIRED', message: '删除需要使用 Studio 管理员会话。',
                            } };
                    const id = args.id?.trim();
                    if (id && !/^lib_[a-f0-9]{16}$/.test(id))
                        return { ok: false, error: { code: 'ID_REQUIRED', message: '请提供 Studio 书库条目 ID。' } };
                    if (action === 'status' || action === 'stats') {
                        return ok({ executor: 'studio', stats: await studioJob('/api/library/stats') });
                    }
                    if (action === 'get') {
                        if (!id)
                            return { ok: false, error: { code: 'ID_REQUIRED', message: '请提供 Studio 书库条目 ID。' } };
                        return ok({ executor: 'studio', entry: await studioJob('/api/library/' + id) });
                    }
                    if (action === 'verify') {
                        const result = await studioJob(id ? `/api/library/${id}/verify` : '/api/library/verify', {
                            method: 'POST',
                        });
                        return ok({ ...result, executor: 'studio' });
                    }
                    const entries = await studioJob('/api/library', {
                        query: { query: args.query?.trim() },
                    });
                    if (action === 'checksums') {
                        return ok({ executor: 'studio', checksums: entries.filter((entry) => entry.sha256)
                                .map((entry) => `${entry.sha256}  ${entry.fileName}`) });
                    }
                    return ok({ executor: 'studio', entries: entries.slice(0, limit), total: entries.length,
                        nextStep: 'Use the returned downloadPath against the Studio API for verified EPUBs.',
                    });
                }
                const status = () => ({
                    libraryDir: runtime.config.libraryDir,
                    indexFile: path.join(runtime.config.libraryDir, 'index.json'),
                    dartAvailable: runtime.dartAvailable,
                });
                if (action === 'status') {
                    return ok({ status: { ...status(), ...runtime.status() }, stats: runtime.library.stats() });
                }
                if (action === 'stats') {
                    return ok({ stats: runtime.library.stats(), status: status() });
                }
                if (action === 'checksums') {
                    return ok({ checksums: await runtime.library.readChecksums() });
                }
                if (action === 'verify') {
                    const results = await runtime.library.verify(args.id?.trim() || undefined);
                    return ok({
                        results,
                        allOk: results.every((r) => r.ok),
                        verified: results.length,
                        nextStep: 'Use list to inspect entries whose integrity is not ok.',
                    });
                }
                if (action === 'list') {
                    const entries = runtime.library.list({ query: args.query?.trim(), limit });
                    return ok({
                        entries: entries.map((e) => withAbsolute(runtime, e)),
                        total: entries.length,
                        stats: runtime.library.stats(),
                        status: status(),
                    });
                }
                if (action === 'get') {
                    const id = args.id?.trim();
                    if (!id)
                        return { ok: false, error: { code: 'ID_REQUIRED', message: 'Provide id for get.' } };
                    const entry = runtime.library.get(id);
                    if (!entry)
                        return { ok: false, error: { code: 'ENTRY_NOT_FOUND', message: `No library entry with id ${id}` } };
                    return ok({ entry: withAbsolute(runtime, entry) });
                }
                // remove — deliberately destructive, requires an explicit confirmation.
                const id = args.id?.trim();
                if (!id)
                    return { ok: false, error: { code: 'ID_REQUIRED', message: 'Provide id for remove.' } };
                if (args.confirm !== true) {
                    return { ok: false, error: { code: 'CONFIRM_REQUIRED', message: 'remove requires confirm=true.' } };
                }
                const removed = await runtime.library.remove(id);
                if (!removed)
                    return { ok: false, error: { code: 'ENTRY_NOT_FOUND', message: `No library entry with id ${id}` } };
                return ok({ removed: true, id, stats: runtime.library.stats() });
            });
        },
    }));
}
//# sourceMappingURL=novel-library.js.map