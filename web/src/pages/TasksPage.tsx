import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  CheckCircle2,
  Clock3,
  Download,
  Info,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
  XCircle,
} from 'lucide-react'
import { Badge, Button, Card, EmptyState, Progress, Spinner } from '@/components/common/ui'
import { MediaFilterTabs, useMediaFilter } from '@/components/common/MediaFilter'
import { MangaNotice } from '@/components/manga/MangaNotice'
import { MangaTaskCard } from '@/components/manga/MangaTaskCard'
import { useMangaTasks } from '@/hooks/useMangaTasks'
import { useAsync } from '@/hooks/useAsync'
import type { UnifiedDownloadTask } from '@/types/manga'
import { Modal } from '@/components/common/Modal'
import { PageHeader } from '@/components/common/PageHeader'
import { PageControls } from '@/components/common/PageControls'
import { CoverArt } from '@/components/novel/CoverArt'
import { useToast } from '@/components/common/Toast'
import { useTasks, taskStore } from '@/services/taskStore'
import { listTaskPage, novelApi, type TaskPage } from '@/services/novelApi'
import { apiFetch, DEMO, IS_LIVE } from '@/services/runtime'
import type { DownloadTask, LibraryItem, TaskState } from '@/types'
import { cn } from '@/services/utils'

type TaskFilter = 'all' | 'unknown' | TaskState

const tabs: { id: TaskFilter; label: string }[] = [
  { id: 'all', label: '全部状态' },
  { id: 'running', label: '进行中' },
  { id: 'queued', label: '排队中' },
  { id: 'completed', label: '已完成' },
  { id: 'failed', label: '失败' },
  { id: 'cancelled', label: '已取消' },
  { id: 'unknown', label: '状态未知' },
]

const stateMeta: Record<TaskState, { label: string; tone: 'violet' | 'green' | 'amber' | 'rose' | 'gray'; icon: JSX.Element }> = {
  running: { label: '进行中', tone: 'violet', icon: <Loader2 className="h-3 w-3 animate-spin" /> },
  queued: { label: '排队中', tone: 'amber', icon: <Clock3 className="h-3 w-3" /> },
  completed: { label: '已完成', tone: 'green', icon: <CheckCircle2 className="h-3 w-3" /> },
  failed: { label: '失败', tone: 'rose', icon: <XCircle className="h-3 w-3" /> },
  cancelled: { label: '已取消', tone: 'gray', icon: <XCircle className="h-3 w-3" /> },
}

interface SavedGroup {
  id: string
  type: 'novel' | 'manga'
  title: string
  observedAt: number
  files: Array<{ path: string; bytes: number }>
}

export function TasksPage() {
  const mockNovels = useTasks(!IS_LIVE)
  const type = useMediaFilter()
  const mangaTasks = useMangaTasks(type !== 'novel')
  const { toast } = useToast()
  const [params, setParams] = useSearchParams()
  const state = params.get('state')
  const tab = tabs.find((item) => item.id === state)?.id ?? 'all'
  const query = (params.get('q') ?? '').trim().toLowerCase()
  const offset = Math.max(0, Number(params.get('offset')) || 0)
  const [novelPage, setNovelPage] = useState<TaskPage | null>(null)
  const [novelError, setNovelError] = useState<string | null>(null)
  const [taskRefresh, setTaskRefresh] = useState(0)
  const setOffset = (value: number) => setParams((previous) => {
    const next = new URLSearchParams(previous)
    if (value) next.set('offset', String(value))
    else next.delete('offset')
    return next
  }, { replace: true })
  useEffect(() => {
    if (!IS_LIVE || type === 'manga') return
    const controller = new AbortController()
    let timer: number | undefined
    const reload = async () => {
      try {
        const page = await listTaskPage({ offset, query, state: tab === 'all' ? undefined : tab, signal: controller.signal })
        if (!controller.signal.aborted) {
          setNovelPage(page)
          setNovelError(null)
        }
      } catch (error) {
        if (!controller.signal.aborted) setNovelError(error instanceof Error ? error.message : '读取轻小说任务失败')
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => void reload(), 2000)
      }
    }
    void reload()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [type, offset, query, tab, taskRefresh])
  const novels = IS_LIVE ? novelPage?.items ?? [] : mockNovels
  const [fileRefresh, setFileRefresh] = useState(0)
  const saved = useAsync(() => IS_LIVE
    ? apiFetch<{ files: SavedGroup[]; errors: string[] }>('/tasks/files')
    : Promise.resolve({ files: [], errors: [] }), [fileRefresh])
  const [detail, setDetail] = useState<DownloadTask | null>(null)
  const [cancelTarget, setCancelTarget] = useState<DownloadTask | null>(null)

  const tasks: UnifiedDownloadTask[] = [
    ...(type === 'manga' ? [] : novels.map((task): UnifiedDownloadTask => ({ type: 'novel', id: `novel:${task.id}`, task }))),
    ...[...mangaTasks.queue, ...mangaTasks.history].map((task): UnifiedDownloadTask => ({ type: 'manga', id: `manga:${task.id}`, task })),
  ]
  const matching = tasks.filter(({ task, type }) => IS_LIVE && type === 'novel' || !query || task.title.toLowerCase().includes(query))
  const filtered = tab === 'all' ? matching : matching.filter(({ task }) => task.state === tab)
  const archived = new Set(mangaTasks.history.flatMap((task) => task.archive?.file ? [task.archive.file] : []))
  const savedMatches = (saved.data?.files ?? []).filter((item) => type === 'all' || item.type === type)
    .map((item) => ({
      ...item, files: item.type === 'manga' ? item.files.filter((file) => !archived.has(file.path)) : item.files,
    }))
    .filter((item) => item.files.length > 0 && (!query || item.title.toLowerCase().includes(query) ||
      item.files.some((file) => file.path.toLowerCase().includes(query))))
  const visibleFiles = tab === 'all' || tab === 'completed' ? savedMatches : []
  const base = IS_LIVE && type !== 'manga' ? novelPage?.counts : undefined
  const countTasks = (state: TaskFilter, entries: UnifiedDownloadTask[]) => {
    const local = entries.filter((entry) => (!IS_LIVE || entry.type !== 'novel') &&
      (state === 'all' || entry.task.state === state)).length
    if (!base || state === 'unknown') return local
    return local + (state === 'all' ? Object.values(base).reduce((sum, count) => sum + count, 0) : base[state])
  }
  const runningCount = countTasks('running', tasks)
  const completedCount = countTasks('completed', tasks)

  const cancel = async (task: DownloadTask) => {
    try {
      await novelApi.cancelTask(task.id)
      setTaskRefresh((value) => value + 1)
      setCancelTarget(null)
      setDetail(null)
      toast({ tone: 'warning', title: '任务已取消', description: `${task.title} · 未完成的章节不会写入书库。` })
    } catch (error) {
      toast({ tone: 'warning', title: '取消失败', description: error instanceof Error ? error.message : '未知错误' })
    }
  }

  const retry = async (task: DownloadTask) => {
    try {
      await novelApi.retryTask(task.id)
      setTaskRefresh((value) => value + 1)
      toast({ tone: 'info', title: '已重新排队', description: `${task.title} 将从头开始重试。` })
    } catch (error) {
      toast({ tone: 'warning', title: '重试失败', description: error instanceof Error ? error.message : '未知错误' })
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Download queue"
        title="下载任务"
        description={
          IS_LIVE
            ? '查看轻小说与漫画的下载进度、完成记录及已保存文件。'
            : '体验 EPUB 下载和漫画章节排队。'
        }
        actions={
          <>
            <Badge tone={IS_LIVE ? 'green' : 'amber'} className="h-7 px-3">
              {IS_LIVE ? <Download className="h-3 w-3" /> : null}
              {!IS_LIVE ? DEMO.label : mangaTasks.error || mangaTasks.loading ? '当前队列部分可用' : `${runningCount} 个进行中 · ${completedCount} 个已完成`}
            </Badge>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className="h-3.5 w-3.5" />}
              onClick={() => {
                if (type !== 'manga') taskStore.refresh()
                if (type !== 'novel') mangaTasks.refresh()
                setTaskRefresh((value) => value + 1)
                setFileRefresh((value) => value + 1)
              }}
            >
              刷新
            </Button>
          </>
        }
      />

      <MediaFilterTabs />
      <input aria-label="搜索下载记录" placeholder="搜索作品或文件名" type="search"
        value={params.get('q') ?? ''} onChange={(event) => setParams((previous) => {
          const next = new URLSearchParams(previous)
          next.delete('offset')
          if (event.target.value) next.set('q', event.target.value)
          else next.delete('q')
          return next
        }, { replace: true })}
        className="mb-4 block w-full max-w-sm rounded-full border border-line bg-surface px-4 py-2 text-sm text-ink" />
      {type !== 'manga' && novelError && <div className="mb-4"><MangaNotice message={novelError} /></div>}
      {mangaTasks.error && <div className="mb-4"><MangaNotice message={`漫画下载队列不可用 · ${mangaTasks.error}`} /></div>}
      {mangaTasks.historyError && <div className="mb-4"><MangaNotice message={mangaTasks.historyError} /></div>}
      {mangaTasks.loading && <p role="status" className="mb-3 text-xs text-ink-soft"><Spinner /> 正在读取漫画队列…</p>}
      {saved.error && <div className="mb-4"><MangaNotice message={saved.error} /></div>}
      {saved.data?.errors.map((error) => <div className="mb-4" key={error}><MangaNotice message={error} /></div>)}

      <div role="group" aria-label="任务状态" className="mb-5 flex flex-wrap items-center gap-2">
        {tabs.map((item) => {
          const count = countTasks(item.id, matching) +
            (item.id === 'all' || item.id === 'completed' ? savedMatches.length : 0)
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={tab === item.id}
              onClick={() => setParams((previous) => {
                const next = new URLSearchParams(previous)
                next.delete('offset')
                if (item.id === 'all') next.delete('state')
                else next.set('state', item.id)
                return next
              })}
              className={cn(
                'h-8 rounded-full border px-3.5 text-[11px] transition',
                tab === item.id
                  ? 'border-accent-line bg-accent-soft font-semibold text-accent'
                  : 'border-line bg-surface text-ink-soft hover:border-accent-line hover:text-accent',
              )}
            >
              {item.label}
              <span className={cn('ml-1.5 text-[9.5px]', tab === item.id ? 'text-accent' : 'text-ink-muted')}>{count}</span>
            </button>
          )
        })}
      </div>

      {filtered.length === 0 && visibleFiles.length === 0 ? (!mangaTasks.loading && !mangaTasks.error && !saved.loading && (!IS_LIVE || type === 'manga' || novelPage) && (
        <Card>
          <EmptyState
            icon={<Download className="h-6 w-6" />}
            title="该状态下暂无任务"
            description="可在作品详情页选择轻小说卷或漫画章节，提交下载。"
          />
        </Card>
      )) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {filtered.map((entry) => {
            if (entry.type === 'manga') return <MangaTaskCard key={entry.id} id={entry.id} task={entry.task} />
            const task = entry.task
            const meta = stateMeta[task.state]
            return (
              <Card key={entry.id} hoverable className="p-5" data-task-id={entry.id} data-media-type="novel">
                <div className="flex items-start gap-4">
                  <CoverArt
                    theme={task.cover}
                    index={task.coverIndex}
                    mini
                    className="h-[62px] w-[46px] shrink-0 rounded-[8px] shadow-[0_8px_18px_-10px_rgba(43,42,85,0.6)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="truncate text-[13.5px] font-semibold text-ink">{task.title}</p>
                      <Badge tone={meta.tone}>
                        {meta.icon}
                        {meta.label}
                      </Badge>
                      {task.origin === 'dsh' && <Badge tone="gray">DSH 旧任务</Badge>}
                    </div>
                    <p className="mt-1 text-[10.5px] text-ink-muted">
                      轻小说 · {entry.id} · {task.volumeLabel} · {task.chapterLabel}
                    </p>
                    {task.message && (
                      <p className="mt-1.5 rounded-[6px] bg-negative-soft px-2 py-1 text-[9.5px] text-negative">{task.message}</p>
                    )}
                  </div>
                </div>

                <div className="mt-4">
                  <div className="mb-1.5 flex items-center justify-between text-[10px]">
                    <span className="text-ink-muted">
                      {task.state === 'completed' ? '已完成' : task.state === 'failed' ? '已中断' : '进度'}
                      {task.speed && <span className="ml-2 text-[#C4B5FB]">{task.speed}</span>}
                    </span>
                    <span className="font-semibold text-ink-soft">{task.percent}%</span>
                  </div>
                  <Progress
                    value={task.percent}
                    tone={
                      task.state === 'failed'
                        ? 'rose'
                        : task.state === 'completed'
                          ? 'green'
                          : task.state === 'cancelled'
                            ? 'gray'
                            : 'violet'
                    }
                    className="h-[6px]"
                  />
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  <Button variant="secondary" size="sm" onClick={() => setDetail(task)}>
                    任务详情
                  </Button>
                  {(task.state === 'running' || task.state === 'queued') && task.taskState !== 'cancelling' && (
                    <>
                      {!IS_LIVE && (task.state === 'running' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Pause className="h-3 w-3" />}
                          onClick={() => {
                            taskStore.pause(task.id)
                            toast({ tone: 'info', title: '任务已暂停', description: `${task.title} 可在空闲时恢复。` })
                          }}
                        >
                          暂停
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Play className="h-3 w-3" />}
                          onClick={() => taskStore.resume(task.id)}
                        >
                          恢复
                        </Button>
                      ))}
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Trash2 className="h-3 w-3" />}
                        className="text-negative hover:bg-negative-soft hover:text-negative"
                        onClick={() => setCancelTarget(task)}
                      >
                        取消
                      </Button>
                    </>
                  )}
                  {(task.state === 'failed' || task.state === 'cancelled') && (
                    <Button variant="soft" size="sm" icon={<RotateCcw className="h-3 w-3" />} onClick={() => retry(task)}>
                      重试
                    </Button>
                  )}
                  <span className="ml-auto text-[9.5px] text-ink-muted">{task.updatedAt}</span>
                </div>
              </Card>
            )
          })}
          {visibleFiles.map((entry) => <Card key={entry.id} data-task-id={entry.id} data-media-type={entry.type} className="min-w-0 p-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="min-w-0 break-words text-sm font-semibold text-ink">{entry.title}</p>
              <Badge tone="green">已保存</Badge>
            </div>
            <p className="mt-2 text-xs text-ink-soft">
              {entry.type === 'manga' ? '漫画 · CBZ' : '轻小说 · EPUB'} · 从保存目录恢复 {entry.files.length} 个文件
            </p>
            <details className="mt-3 break-words text-xs text-ink-soft">
              <summary className="cursor-pointer text-accent">查看保存文件</summary>
              <ul className="mt-2 space-y-1">{entry.files.map((file) => <li key={file.path}>{file.path}</li>)}</ul>
            </details>
          </Card>)}
        </div>
      )}

      {IS_LIVE && type !== 'manga' && novelPage && <PageControls label="轻小说任务" offset={offset}
        total={novelPage.total} nextOffset={novelPage.nextOffset} onChange={setOffset} />}
      {mangaTasks.hasOlder && ['all', 'completed'].includes(tab) && <div className="mt-4 text-center">
        <Button size="sm" loading={mangaTasks.loadingHistory} onClick={() => void mangaTasks.loadMore()}>加载更多漫画完成记录</Button>
      </div>}
      <div className="mt-5 flex items-start gap-2 rounded-[12px] border border-accent-line bg-accent-soft px-4 py-3 text-[10.5px] leading-relaxed text-ink-soft">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
        <span>
          {IS_LIVE
            ? '漫画任务会保留已完成的章节及 CBZ 保存记录。归档与 Komga 收录状态分别显示。'
            : '演示操作只修改当前页面会话中的样例状态。'}
        </span>
      </div>

      <TaskDetailModal task={detail} onClose={() => setDetail(null)} />

      <Modal
        open={Boolean(cancelTarget)}
        onClose={() => setCancelTarget(null)}
        eyebrow="Confirm"
        title="取消这个下载任务？"
        width="max-w-[420px]"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setCancelTarget(null)}>
              保留任务
            </Button>
            <Button variant="danger" size="sm" onClick={() => cancelTarget && cancel(cancelTarget)}>
              确认取消
            </Button>
          </div>
        }
      >
        <div className="px-6 py-5 text-[11.5px] leading-relaxed text-ink-soft">
          <p>
            「{cancelTarget?.title}」当前已完成 <span className="font-semibold text-accent">{cancelTarget?.percent}%</span>。
            当前执行安全退出后会显示已取消。已经完成入库的 EPUB 会保留。
          </p>
            <p className="mt-2 text-[10px] text-ink-muted">
              {IS_LIVE
                ? '后端按任务 ID 取消，不接受文件路径参数，避免任意路径删除。'
                : 'Mock 演示不会修改任何真实任务或文件。'}
            </p>
        </div>
      </Modal>
    </div>
  )
}

function TaskDetailModal({ task, onClose }: { task: DownloadTask | null; onClose: () => void }) {
  const { toast } = useToast()
  const result = useAsync(() => IS_LIVE && task
    ? apiFetch<{ id: string; artifacts: LibraryItem[] }>(`/tasks/${encodeURIComponent(task.id)}`)
    : Promise.resolve(null), [task?.id])
  const artifacts = result.data?.id === task?.id ? result.data?.artifacts ?? [] : []
  return (
    <Modal open={Boolean(task)} onClose={onClose} eyebrow="Task detail" title={task?.title} width="max-w-[560px]">
      {task && (
        <div className="p-6">
          <div className="flex items-start gap-4">
            <CoverArt theme={task.cover} index={task.coverIndex} mini className="h-[92px] w-[68px] rounded-[9px]" />
            <div className="flex-1">
              <Badge tone={stateMeta[task.state].tone}>
                {stateMeta[task.state].icon}
                {stateMeta[task.state].label}
              </Badge>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-soft">
                {task.volumeLabel} · {task.chapterLabel}
                {task.speed ? ` · ${task.speed}` : ''}
              </p>
              <div className="mt-3 flex items-center gap-3">
                <Progress
                  value={task.percent}
                  tone={task.state === 'failed' ? 'rose' : task.state === 'completed' ? 'green' : 'violet'}
                  className="flex-1"
                />
                <span className="text-[11px] font-semibold text-ink-soft">{task.percent}%</span>
              </div>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-2.5">
            {[
              ['任务 ID', task.id],
              ['状态', stateMeta[task.state].label],
              ['分卷', task.volumeLabel],
              ['当前章节', task.chapterLabel],
              ['预计大小', task.size ?? '—'],
              ['最近更新', task.updatedAt],
            ].map(([label, value]) => (
              <div key={label} className="rounded-[10px] border border-line bg-surface-soft px-3 py-2.5">
                <p className="text-[9.5px] text-ink-muted">{label}</p>
                <p className="mt-1 truncate font-mono text-[10.5px] text-ink">{value}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 rounded-[10px] border border-line px-3.5 py-3">
            <p className="text-[10px] font-semibold text-ink">入库文件</p>
            {IS_LIVE ? (
              result.loading ? <p className="mt-2 text-xs text-ink-soft">正在读取文件…</p>
                : result.error ? <p className="mt-2 text-xs text-negative">{result.error}</p>
                  : artifacts.length ? <ul className="mt-2 max-h-48 space-y-1 overflow-auto">
                    {artifacts.map((file) => <li key={file.id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="break-all">{file.fileName} · {file.size}</span>
                      <Button size="sm" onClick={() => void novelApi.downloadFile(file.id, file.fileName).catch((error: unknown) =>
                        toast({ tone: 'warning', title: '下载失败', description: error instanceof Error ? error.message : '读取文件失败' }))}>
                        下载
                      </Button>
                    </li>)}
                  </ul> : <p className="mt-2 text-xs text-ink-soft">书库暂无可关联的 EPUB 文件。</p>
            ) : <p className="mt-2 text-xs text-ink-soft">{`volume-${task.id}.epub`}</p>}
          </div>
        </div>
      )}
    </Modal>
  )
}
