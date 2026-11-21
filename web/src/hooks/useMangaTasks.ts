import { useEffect, useRef, useState } from 'react'
import { mangaApi } from '@/services/mangaApi'
import { ApiError } from '@/services/runtime'
import type { MangaTask } from '@/types/manga'

export function useMangaTasks(enabled: boolean) {
  const [queue, setQueue] = useState<MangaTask[]>([])
  const [history, setHistory] = useState<MangaTask[]>([])
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const extended = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let alive = true
    let timer: number | undefined

    const poll = async () => {
      let delay = 5000
      try {
        const result = await mangaApi.tasks()
        if (!alive) return
        setQueue(result.queue)
        setError(result.queueError ?? null)
        setHistoryError(result.historyError ?? null)
        if (result.history) {
          const latest = result.history
          const ids = new Set(latest.map((task) => task.id))
          setHistory((previous) => extended.current ? [...latest, ...previous.filter((task) => !ids.has(task.id))] : latest)
          if (!extended.current) setNextBefore(result.nextBefore ?? null)
        }
      } catch (failure) {
        if (!alive) return
        setQueue([])
        if (failure instanceof ApiError && failure.status === 429) delay = Math.max(delay, failure.retryAfterMs)
        setError(failure instanceof Error ? failure.message : '读取下载队列失败')
      } finally {
        if (alive) {
          setLoading(false)
          timer = window.setTimeout(() => void poll(), delay)
        }
      }
    }

    setLoading(true)
    void poll()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [enabled, attempt])

  async function loadMore() {
    if (nextBefore === null || loadingHistory) return
    setLoadingHistory(true)
    try {
      const result = await mangaApi.tasks(nextBefore)
      if (result.historyError) throw new Error(result.historyError)
      extended.current = true
      const older = result.history ?? []
      setHistory((previous) => [...new Map([...older, ...previous].map((task) => [task.id, task])).values()]
        .sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0)))
      setNextBefore(result.nextBefore ?? null)
      setHistoryError(null)
    } catch (failure) {
      setHistoryError(failure instanceof Error ? failure.message : '读取完成记录失败')
    } finally {
      setLoadingHistory(false)
    }
  }

  const activeIds = new Set(queue.map((task) => task.id))
  return {
    queue: enabled ? queue : [],
    history: enabled ? history.filter((task) => !activeIds.has(task.id)) : [],
    historyError: enabled ? historyError : null,
    hasOlder: enabled && nextBefore !== null,
    loadingHistory,
    loadMore,
    error: enabled ? error : null,
    loading: enabled && loading,
    refresh: () => setAttempt((current) => current + 1),
  }
}
