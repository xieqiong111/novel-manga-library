import { paginate } from '../dist/core/pagination.js'
import { readDshTasks } from './download-history.mjs'
import { HttpError } from './http-error.mjs'
import { taskDisplayState, toTask } from './mapping.mjs'

function pageOptions(params) {
  const integer = (name, fallback, min, max) => {
    if (!params.has(name)) return fallback
    const value = params.get(name)
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
      throw new HttpError(400, 'INVALID_PAGE', `Invalid ${name}`)
    }
    return Number(value)
  }
  return { offset: integer('offset', 0, 0, Number.MAX_SAFE_INTEGER), limit: integer('limit', 200, 1, 200) }
}

export function createNovelLists(runtime, settings, logger, libraryItem) {
  let historyPromise
  let historyExpires = 0
  const dshHistory = () => {
    if (!historyPromise || Date.now() >= historyExpires) {
      historyExpires = Date.now() + 30_000
      historyPromise = readDshTasks(settings.novelTaskHistoryDir).catch(() => {
        logger.warn('downloads', 'dsh_history_unavailable')
        return []
      })
    }
    return historyPromise
  }

  return {
    async tasks(params) {
      const options = pageOptions(params)
      const state = params.get('state')
      const query = (params.get('query') ?? '').trim().toLowerCase()
      const sort = params.get('sort') ?? 'recent'
      if (!['recent', 'oldest'].includes(sort)) throw new HttpError(400, 'INVALID_SORT', 'Invalid task sort')
      const records = [...runtime.tasks.records()]
      const ids = new Set(records.map((task) => task.id))
      const past = (await dshHistory()).filter((task) => !ids.has(task.id))
        .map((task) => ({ ...task, id: 'dsh:' + task.id }))
      const matches = [...records, ...past].filter((task) => !query ||
        [task.request?.title ?? '', ...(task.request?.volumeNames ?? [])].some((value) => value.toLowerCase().includes(query)))
      const counts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }
      for (const task of matches) counts[taskDisplayState(task.state)]++
      const filtered = matches.filter((task) => !state || task.state === state ||
        (state === 'running' || state === 'failed') && taskDisplayState(task.state) === state)
      filtered.sort((a, b) => (sort === 'oldest' ? 1 : -1) * a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id))
      const page = paginate(filtered, options)
      const items = page.items.map((task) => ({ ...toTask(task), ...(task.id.startsWith('dsh:') ? { origin: 'dsh' } : {}) }))
      return params.has('offset') ? { ...page, items, counts } : items
    },
    async task(id) {
      const live = id.startsWith('dsh:') ? null : runtime.tasks.get(id)
      const historical = !live
      const task = live ?? (await dshHistory()).find((entry) => entry.id === id || 'dsh:' + entry.id === id)
      if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', 'No matching download task')
      const entries = runtime.library.forTask(task.id)
      return {
        ...toTask({ ...task, id: historical ? 'dsh:' + task.id : id }), ...(historical ? { origin: 'dsh' } : {}),
        progress: task.progress, downloadedChapters: task.downloadedChapters, downloadedVolumes: task.downloadedVolumes,
        artifacts: await Promise.all(entries.map(libraryItem)),
      }
    },
    async library(params) {
      const options = pageOptions(params)
      const integrity = params.get('integrity')
      const sort = params.get('sort') ?? 'recent'
      if (integrity && !['ok', 'failed', 'unknown'].includes(integrity)) {
        throw new HttpError(400, 'INVALID_INTEGRITY', 'Invalid library integrity filter')
      }
      if (!['recent', 'name', 'size'].includes(sort)) throw new HttpError(400, 'INVALID_SORT', 'Invalid library sort')
      await runtime.library.load()
      const page = runtime.library.page({ ...options, query: params.get('query') ?? '', integrity, sort })
      const items = await Promise.all(page.items.map(libraryItem))
      return params.has('offset') ? { ...page, items } : items
    },
  }
}
