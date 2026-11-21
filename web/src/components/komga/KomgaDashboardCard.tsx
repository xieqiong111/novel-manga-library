import { useEffect, useState } from 'react'
import { ArrowRight, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Modal } from '@/components/common/Modal'
import { Badge, Button, Card, SectionTitle, Spinner } from '@/components/common/ui'
import { KomgaSeriesCard } from '@/components/komga/KomgaSeriesCard'
import { useAsync } from '@/hooks/useAsync'
import { komgaApi } from '@/services/komgaApi'
import type { KomgaMaintenanceJob } from '@/services/komgaApi'
import { IS_LIVE } from '@/services/runtime'

function libraryUrl(libraryId: string, query = '') {
  const params = new URLSearchParams({ provider: 'komga' })
  if (libraryId) params.set('library', libraryId)
  if (query) params.set('q', query)
  return `/library?${params}`
}

export function KomgaDashboardCard() {
  const [attempt, setAttempt] = useState(0)
  const { data, loading, error } = useAsync(() => komgaApi.libraries(), [attempt])
  const [selected, setSelected] = useState('')
  const libraries = data?.libraries ?? []
  const library = libraries.find((item) => item.id === selected) ?? libraries[0]

  return (
    <Card className="space-y-4 p-4 sm:px-6 sm:py-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SectionTitle title="Komga 书库" />
          {!IS_LIVE && <Badge tone="amber">演示数据</Badge>}
        </div>
        <Link to={libraryUrl(library?.id ?? '')} className="inline-flex items-center gap-1.5 text-xs font-medium text-accent">
          查看完整书库 <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      {loading ? <p className="flex items-center gap-2 text-sm text-ink-soft" role="status"><Spinner /> 正在读取 Komga 书库…</p>
        : error ? <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-ink-soft" role="alert">Komga 书库读取失败。{error}</p>
          <Button size="sm" onClick={() => setAttempt((value) => value + 1)}>重试</Button>
        </div>
        : !library ? <p className="text-sm text-ink-soft">暂无可访问的 Komga 书库。</p>
        : <>
          <label className="flex w-full flex-wrap items-center gap-2 text-xs font-medium text-ink-soft sm:w-fit">
            选择 Komga 书库
            <select value={library.id} onChange={(event) => setSelected(event.target.value)}
              className="h-9 min-w-0 max-w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink">
              {libraries.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <LibraryOverview key={library.id} libraryId={library.id} name={library.name} />
        </>}
    </Card>
  )
}

function LibraryOverview({ libraryId, name }: { libraryId: string; name: string }) {
  const [maintenance, setMaintenance] = useState<Awaited<ReturnType<typeof komgaApi.maintenance>> | null>(null)
  const [statusError, setStatusError] = useState('')
  const [actionError, setActionError] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [poll, setPoll] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const job = maintenance?.job
  const finished = job?.libraryId === libraryId && job.state === 'finished' ? job : null
  const { data, loading, error } = useAsync(() => komgaApi.series(libraryId, '', 0, 4), [attempt, finished])
  const running = job?.state === 'running'

  useEffect(() => {
    if (!IS_LIVE) return
    const controller = new AbortController()
    let timer: number | undefined
    let keepPolling = poll > 0
    async function readStatus() {
      try {
        const status = await komgaApi.maintenance(libraryId, controller.signal)
        if (controller.signal.aborted) return
        setStatusError('')
        setMaintenance(status)
        keepPolling = status.job?.state === 'running'
        if (keepPolling) timer = window.setTimeout(readStatus, 1500)
      } catch (failure) {
        if (controller.signal.aborted) return
        setStatusError(failure instanceof Error ? failure.message : '无法读取刮削状态。')
        if (keepPolling) timer = window.setTimeout(readStatus, 4000)
      }
    }
    void readStatus()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [libraryId, poll])

  async function start() {
    setStarting(true)
    setActionError('')
    try {
      setMaintenance(await komgaApi.startMaintenance(libraryId))
      setConfirmOpen(false)
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : '无法启动刮削与刷新。')
      setConfirmOpen(false)
    } finally {
      setPoll((value) => value + 1)
      setStarting(false)
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5">
        <Button size="sm" variant="soft" icon={<Sparkles className="h-3.5 w-3.5" />}
          disabled={!IS_LIVE || !maintenance || Boolean(maintenance.unavailable) || running || Boolean(statusError)}
          loading={starting} onClick={() => setConfirmOpen(true)}>一键刮削并刷新</Button>
        {!IS_LIVE && <p className="text-xs text-ink-muted">演示模式下无法修改书库。</p>}
        {maintenance?.unavailable && <Link to="/settings/scraping" className="text-xs text-accent">{maintenance.unavailable}</Link>}
        {statusError && <p role="alert" className="text-xs text-negative">{statusError}</p>}
        {statusError && <Button size="sm" onClick={() => setPoll((value) => value + 1)}>重试状态</Button>}
      </div>
      {actionError && <p role="alert" className="text-sm text-negative">{actionError}</p>}
      {job && <MaintenanceResult job={job} />}

      {loading ? <p className="flex items-center gap-2 text-sm text-ink-soft" role="status"><Spinner /> 正在读取 Komga 系列…</p>
        : error ? <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-ink-soft">无法读取系列。{error}</p>
          <Button size="sm" onClick={() => setAttempt((value) => value + 1)}>重试</Button>
        </div>
        : data?.content.length ? <>
          <p className="text-xs text-ink-soft">{data.page.totalElements} 个系列</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {data.content.map((series) => <Link
              key={series.id} to={libraryUrl(libraryId, series.title)} className="min-w-0 rounded-[20px] focus-visible:outline focus-visible:outline-accent"
              aria-label={`在 Komga 书库中查找 ${series.title}`}>
              <KomgaSeriesCard series={series} compact />
            </Link>)}
          </div>
        </> : <p className="text-sm text-ink-soft">这个 Komga 书库暂无系列。</p>}

      <Modal open={confirmOpen} title="一键刮削并刷新" onClose={() => !starting && setConfirmOpen(false)}
        footer={<div className="flex flex-wrap justify-end gap-2">
          <Button disabled={starting} onClick={() => setConfirmOpen(false)}>取消</Button>
          <Button variant="primary" loading={starting} onClick={() => void start()}>开始刮削并刷新</Button>
        </div>}>
        <div className="space-y-2 px-6 py-4 text-sm leading-relaxed text-ink-soft">
          <p>所选书库 <strong className="break-words text-ink">{name}</strong></p>
          <p>仅写入搜索结果中有唯一同名条目的系列。已有 Bangumi 关联和锁定字段会保留，最后会请求 Komga 扫描该书库。</p>
        </div>
      </Modal>
    </>
  )
}

function MaintenanceResult({ job }: { job: KomgaMaintenanceJob }) {
  const stage = job.stage === 'loading' ? '正在读取系列'
    : job.stage === 'scanning' ? '正在请求 Komga 扫描' : `已检查 ${job.checked} / ${job.total} 个系列`
  return (
    <div className="space-y-1.5 rounded-xl border border-line bg-surface-soft px-3 py-2.5 text-xs leading-relaxed text-ink-soft">
      <p className="break-words font-medium text-ink" role="status">
        {job.libraryName} · {job.state === 'running' ? stage : `已检查 ${job.checked}${job.total === null ? '' : ` / ${job.total}`} 个系列`}
      </p>
      <p>更新 {job.updated} · 跳过 {job.skipped} · 失败 {job.failed}{job.coverFailures > 0 && ` · 封面写入失败 ${job.coverFailures}`}</p>
      {job.error && <p className="text-negative" role="alert">刮削中止。{job.error}</p>}
      {job.scan && <p className={job.scan.accepted ? 'text-positive' : 'text-caution'}>{job.scan.message}</p>}
      {job.issues.length > 0 && <details>
        <summary className="cursor-pointer text-accent">查看跳过与失败详情</summary>
        <ul className="mt-1 space-y-1">
          {job.issues.map(({ title, message }, index) => <li key={index} className="break-words">{title} · {message}</li>)}
        </ul>
      </details>}
    </div>
  )
}
