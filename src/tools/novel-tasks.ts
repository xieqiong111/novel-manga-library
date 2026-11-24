import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TaskState } from '../types.js'
import type { Page } from '../core/pagination.js'
import type { PluginRuntime } from '../runtime.js'
import { studioDelegated, studioJob } from '../../server/studio-jobs.mjs'
import { jsonOutput, ok, runTool } from './common.js'

const ACTIONS = ['list', 'get', 'cancel', 'retry', 'logs', 'status'] as const
const STATES: readonly TaskState[] = ['queued', 'running', 'verifying', 'importing', 'completed', 'cancelling', 'cancelled', 'failed', 'interrupted']

/**
 * Requirement #8/#9: every download task is queryable, cancellable and
 * retryable, with persisted progress and the chapters/volumes actually written.
 * `logs` exposes the structured JSONL ring buffer for diagnosis.
 */
export function registerNovelTasks(ctx: Context, runtime: PluginRuntime) {
  ctx.tools.register(defineTool({
    name: 'novel_tasks',
    description: [
      'Manage background EPUB download tasks. Actions: list, get, cancel, retry, logs, status.',
      'Use get/list to read progress. After completion use the EPUB artifacts and their verified location.nasPath when present. downloadPath is the Studio file endpoint. storagePath is a path inside Studio.',
      'cancel waits for the active attempt to stop; retry re-queues a failed/cancelled/interrupted task.',
      'status returns plugin diagnostics (Dart core availability, enabled sources, dirs); logs returns recent structured log entries.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        description: 'One of: list (default), get, cancel, retry, logs, status.',
      },
      taskId: { type: 'string', description: 'Task id returned by novel_download. Required for get/cancel/retry.' },
      state: {
        type: 'string',
        description: `Optional list filter: ${STATES.join(' | ')}.`,
      },
      limit: { type: 'number', description: 'Max tasks (list) or log entries (logs), default 20.' },
      offset: { type: 'number', description: 'Zero-based offset for list pagination, default 0.' },
      query: { type: 'string', description: 'Optional work title filter.' },
    },
    output: jsonOutput(),
    async execute(args) {
      return runTool(runtime, 'novel_tasks', async () => {
        const action = (args.action ?? 'list').trim().toLowerCase()
        if (!(ACTIONS as readonly string[]).includes(action)) {
          return { ok: false, error: { code: 'UNKNOWN_ACTION', message: `action must be one of ${ACTIONS.join(', ')}` } }
        }
        const limit = Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 200)
        const offset = Math.max(0, Math.trunc(args.offset ?? 0))
        const query = args.query?.trim()
        if (studioDelegated()) {
          if (action === 'status') return ok({ executor: 'studio', status: await studioJob('/api/status') })
          if (action === 'logs') return ok({ executor: 'studio', activities: await studioJob('/api/activities') })
          if (action === 'list') {
            const state = args.state?.trim().toLowerCase()
            if (state && !STATES.includes(state as TaskState)) {
              return { ok: false, error: { code: 'UNKNOWN_STATE', message: '无效的任务状态筛选。' } }
            }
            const page = await studioJob<Page<unknown> | unknown[]>('/api/tasks', { query: { state, offset, limit, query } })
            const legacy = Array.isArray(page)
            return ok({ executor: 'studio', tasks: legacy ? page.slice(offset, offset + limit) : page.items,
              total: legacy ? page.length : page.total, nextOffset: legacy ? null : page.nextOffset,
              nextStep: 'Use novel_tasks(action="get", taskId=...) for verified library artifacts and progress.',
            })
          }
          const id = args.taskId?.trim() ?? ''
          if (!/^(?:dsh:)?task_[a-f0-9]{16}$/.test(id)) {
            return { ok: false, error: { code: 'TASK_ID_REQUIRED', message: '请提供 Studio 返回的 taskId。' } }
          }
          if (action === 'get') return ok({ executor: 'studio', task: await studioJob('/api/tasks/' + id),
            nextStep: '已完成的 EPUB 保存位置见 artifacts[].location，获取文件使用 artifacts[].downloadPath。' })
          if (id.startsWith('dsh:')) {
            return { ok: false, error: { code: 'HISTORY_READ_ONLY', message: '已恢复的 DSH 旧任务仅支持查询。' } }
          }
          return ok({ executor: 'studio', task: await studioJob(`/api/tasks/${id}/${action}`, { method: 'POST' }) })
        }

        if (action === 'status') {
          return ok({ status: runtime.status() })
        }
        if (action === 'logs') {
          return ok({ logs: runtime.logger.recent(limit) })
        }
        if (action === 'list') {
          const requestedState = args.state?.trim().toLowerCase() as TaskState | undefined
          if (requestedState && !STATES.includes(requestedState)) {
            return { ok: false, error: { code: 'UNKNOWN_STATE', message: `state must be one of ${STATES.join(', ')}` } }
          }
          const page = runtime.tasks.page({ state: requestedState, limit, offset, query })
          const counts = Object.fromEntries(STATES.map((state) => [state, 0]))
          for (const record of runtime.tasks.records()) counts[record.state]++
          return ok({
            tasks: page.items,
            total: page.total,
            nextOffset: page.nextOffset,
            counts,
            nextStep: 'Use action="get" with a taskId for full progress and artifacts.',
          })
        }

        // get / cancel / retry all require a task id.
        const taskId = args.taskId?.trim()
        if (!taskId) {
          return { ok: false, error: { code: 'TASK_ID_REQUIRED', message: 'Provide taskId for this action.' } }
        }
        if (action === 'get') {
          const task = runtime.tasks.get(taskId)
          if (!task) return { ok: false, error: { code: 'TASK_NOT_FOUND', message: `No task with id ${taskId}` } }
          return ok({ task })
        }
        if (action === 'cancel') {
          const task = await runtime.tasks.cancel(taskId)
          return ok({ task, nextStep: 'Use action="retry" to re-queue this task later.' })
        }
        const task = await runtime.tasks.retry(taskId)
        return ok({ task, nextStep: `Poll action="get" with taskId="${task.id}".` })
      })
    },
  }))
}
