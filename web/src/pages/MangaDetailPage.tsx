import { useEffect, useState } from 'react'
import { ArrowLeft, BookOpen, Download, ExternalLink, RefreshCw } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { Badge, Button, Card, EmptyState, SectionTitle, Spinner } from '@/components/common/ui'
import { PageHeader } from '@/components/common/PageHeader'
import { Modal } from '@/components/common/Modal'
import { useToast } from '@/components/common/Toast'
import { MangaCover, mangaDate, mangaSource, mangaStatus } from '@/components/manga/MangaCard'
import { MangaNotice } from '@/components/manga/MangaNotice'
import { useAsync } from '@/hooks/useAsync'
import { mangaApi, mangaKomgaApi, type KomgaChapter } from '@/services/mangaApi'
import { IS_LIVE } from '@/services/runtime'
import type { MangaChapter } from '@/types/manga'

export function MangaDetailPage() {
  const { id = '' } = useParams()
  return <MangaDetail key={id} id={id} />
}

const failureTitles = {
  library: '书架更新失败',
  subscribe: '订阅更新失败',
  refresh: '章节更新失败',
  download: '下载提交失败',
}

function MangaDetail({ id }: { id: string }) {
  const { toast } = useToast()
  const [revision, setRevision] = useState(0)
  const detail = useAsync(() => mangaApi.details(id), [id, revision])
  const [offset, setOffset] = useState(0)
  const [chapters, setChapters] = useState<MangaChapter[]>([])
  const [hasNextPage, setHasNextPage] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState('')
  const [actionError, setActionError] = useState('')
  const [confirmUnsubscribe, setConfirmUnsubscribe] = useState(false)
  const [archiveRevision, setArchiveRevision] = useState(0)
  const chapterPage = useAsync(() => mangaApi.chapters(id, offset), [id, offset, revision])
  const manga = detail.error ? null : detail.data
  const localSource = manga?.sourceId === '0'
  const archive = useAsync(() => !IS_LIVE || localSource || !chapters.length ? Promise.resolve(null)
    : mangaKomgaApi.status(id, chapters.slice(-100).map((chapter) => chapter.id)), [id, localSource, chapters, archiveRevision])
  const archiveRows = new Map(archive.data?.chapters?.map((chapter) => [chapter.id, chapter]) ?? [])
  const excluded = new Set(archive.data?.missingChapterIds)
  const needsArchivePoll = archive.data?.chapters?.some((chapter) =>
    ['queued', 'downloading', 'waiting_archive'].includes(chapter.state))

  useEffect(() => {
    if (!needsArchivePoll) return
    const timer = window.setInterval(() => setArchiveRevision((current) => current + 1), 10000)
    return () => window.clearInterval(timer)
  }, [needsArchivePoll])

  useEffect(() => {
    if (!chapterPage.data || chapterPage.error || chapterPage.loading) return
    const page = chapterPage.data
    setChapters((previous) => {
      const next = new Map((offset === 0 ? [] : previous).map((chapter) => [chapter.id, chapter]))
      for (const chapter of page.chapters) next.set(chapter.id, chapter)
      return [...next.values()]
    })
    setHasNextPage(page.hasNextPage)
  }, [chapterPage.data, chapterPage.error, chapterPage.loading, offset])

  const reload = () => {
    setOffset(0)
    setRevision((current) => current + 1)
  }

  const run = async (action: keyof typeof failureTitles, perform: () => Promise<void>) => {
    setBusy(action)
    setActionError('')
    try {
      await perform()
    } catch (error) {
      setActionError(error instanceof Error ? `${failureTitles[action]} · ${error.message}` : failureTitles[action])
    } finally {
      setBusy('')
    }
  }

  const changeMembership = (operation: 'library' | 'subscribe', add: boolean) => run(operation, async () => {
    if (operation === 'library') await mangaApi.setLibrary(id, add)
    else await mangaApi.subscribe(id, add)
    toast({
      tone: 'success',
      title: operation === 'library' ? '已加入漫画书架' : add ? '已订阅漫画追更' : '已取消订阅并移出漫画书架',
    })
    setConfirmUnsubscribe(false)
    setRevision((current) => current + 1)
  })

  const download = () => run('download', async () => {
    const submit = archive.data?.available ? mangaKomgaApi.download : mangaApi.download
    const { queued, skipped, completed = [], unconfirmed = [] } = await submit(id, selected)
    setSelected([])
    const summary = [
      completed.length ? `${completed.length} 个章节已下载。` : '',
      skipped.length ? `跳过 ${skipped.length} 个已下载或已排队的章节。` : '',
    ].filter(Boolean).join(' ')
    toast(unconfirmed.length ? {
      tone: 'warning',
      title: `${unconfirmed.length} 个章节的下载状态待确认`,
      description: `队列确认 ${queued.length} 个章节。请查看 Suwayomi 下载队列和已下载章节。${summary}`,
    } : {
      tone: queued.length || completed.length ? 'success' : 'info',
      title: queued.length ? `已在下载队列确认 ${queued.length} 个章节` : completed.length ? '已确认章节下载完成' : '没有新增下载任务',
      description: summary || undefined,
    })
    reload()
    setArchiveRevision((current) => current + 1)
  })

  const refresh = () => run('refresh', async () => {
    await mangaApi.refresh(id)
    setSelected([])
    reload()
    toast({ tone: 'success', title: '已向漫画源更新章节' })
  })

  const canDownload = (chapter: MangaChapter) => !localSource && !chapter.downloaded && !excluded.has(chapter.id) &&
    !['archived', 'in_legacy_volume'].includes(archiveRows.get(chapter.id)?.state ?? '')
  const selectable = chapters.filter(canDownload)
  const maxSelection = 50
  const latestId = chapters[0]?.id

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to="/search?type=manga" className="inline-flex items-center gap-2 text-xs font-semibold text-accent">
          <ArrowLeft className="h-4 w-4" /> 搜索漫画
        </Link>
        <Link to="/tasks?type=manga" className="text-xs font-semibold text-accent">查看漫画下载队列</Link>
      </div>
      {detail.loading && !manga ? <p role="status" className="text-xs text-ink-soft"><Spinner /> 读取漫画资料…</p>
        : !manga ? (
          <Card>
            <EmptyState icon={<BookOpen />} title="漫画详情不可用" description={detail.error ?? undefined}
              action={<Button size="sm" onClick={reload}>重试</Button>} />
          </Card>
        ) : (
          <>
            <Card className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-4 gap-y-3 p-4 sm:grid-cols-[170px_minmax(0,1fr)] sm:gap-x-5 sm:p-6">
              <MangaCover manga={manga} className="aspect-[3/4] w-full self-start rounded-[12px] shadow-card sm:row-span-2" eager />
              <div className="min-w-0 self-start">
                <PageHeader
                  eyebrow="Manga"
                  className="gap-2 pb-3 [&_h1]:break-words"
                  title={manga.title}
                  description={`${manga.author || '作者未知'} · ${mangaSource(manga)} · ${manga.source?.lang ?? '语言未知'}`}
                  actions={<Badge tone={IS_LIVE ? 'violet' : 'amber'}>{IS_LIVE ? mangaStatus(manga.status) : '演示数据'}</Badge>}
                />
                <div className="flex flex-wrap gap-1.5">
                  {!IS_LIVE && <Badge>{mangaStatus(manga.status)}</Badge>}
                  {manga.inLibrary && <Badge tone="green">已在漫画书架</Badge>}
                  {manga.subscribed && <Badge tone="green">已订阅</Badge>}
                  <Badge tone="gray">ID {manga.id}</Badge>
                </div>
              </div>
              <div className="col-span-2 min-w-0 sm:col-span-1 sm:col-start-2">
                {manga.url && /^https?:\/\//i.test(manga.url) && (
                  <a href={manga.url} target="_blank" rel="noreferrer" className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-accent">
                    <ExternalLink className="h-3.5 w-3.5" /> 来源网站
                  </a>
                )}
                <p className="whitespace-pre-line break-words text-sm leading-relaxed text-ink-soft">{manga.description || '暂无简介。'}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button size="sm" disabled={Boolean(busy) || detail.loading || manga.inLibrary} loading={busy === 'library'}
                    onClick={() => void changeMembership('library', true)}>加入漫画书架</Button>
                  <Button size="sm" variant="soft" disabled={Boolean(busy) || detail.loading} loading={busy === 'subscribe'}
                    onClick={() => manga.subscribed ? setConfirmUnsubscribe(true) : void changeMembership('subscribe', true)}>
                    {manga.subscribed ? '取消订阅' : '订阅追更'}
                  </Button>
                  <Button size="sm" disabled={Boolean(busy) || chapterPage.loading} loading={busy === 'refresh'} onClick={() => void refresh()}
                    icon={<RefreshCw className="h-3.5 w-3.5" />}>更新章节</Button>
                </div>
                <p className="mt-2 text-xs text-ink-soft">追更以 Suwayomi 书架成员身份管理，检查频率和更新策略由 Suwayomi 设置决定。</p>
              </div>
            </Card>
            {actionError && <MangaNotice message={actionError} />}
            <Card className="p-4 sm:p-5">
              <SectionTitle title="章节" />
              {IS_LIVE && !localSource && <div className="mt-2 flex flex-wrap items-center gap-2">
                <p className="text-xs text-ink-soft">
                  {archive.error ? archive.error
                    : archive.data?.archiveMode === 'unsupported' ? '这个来源没有可单独归档的章节，请选择有分话目录的来源。'
                    : archive.data?.archiveMode === 'volume' ? '归档服务尚未启用按章模式。'
                    : archive.data?.available === false ? '未配置 Docker 归档，可下载到 Suwayomi。'
                    : '每章下载完成后，Docker 自动生成一个 CBZ 并写入作品文件夹。'}
                </p>
                <Button size="sm" disabled={!chapters.length || archive.loading} onClick={() => setArchiveRevision((current) => current + 1)}
                  icon={<RefreshCw className="h-3.5 w-3.5" />}>刷新归档状态</Button>
              </div>}
              <div className="my-3 flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={!selectable.length || Boolean(busy)} onClick={() => setSelected(
                  selectable.slice(0, maxSelection).every((chapter) => selected.includes(chapter.id))
                    ? []
                    : selectable.slice(0, maxSelection).map((chapter) => chapter.id),
                )}>选择可下载章节</Button>
                <Button size="sm" variant="primary" loading={busy === 'download'}
                  disabled={!selected.length || Boolean(busy) || chapterPage.loading || Boolean(chapterPage.error) ||
                    (IS_LIVE && (archive.loading || Boolean(archive.error) || ['volume', 'unsupported'].includes(archive.data?.archiveMode ?? '')))}
                  icon={<Download className="h-3.5 w-3.5" />} onClick={() => void download()}>下载选中章节（{selected.length}）</Button>
                <span className="text-xs text-ink-soft">
                  {localSource ? '本地漫画中的章节已存放在 Suwayomi 数据目录。' : `每次最多 ${maxSelection} 章`}
                </span>
              </div>
              {chapterPage.error && <MangaNotice message={`章节不可用 · ${chapterPage.error}`} />}
              {!chapterPage.loading && !chapterPage.error && !chapters.length && (
                <EmptyState icon={<BookOpen />} title="暂无章节" description="点击更新章节，从漫画源读取最新目录。" />
              )}
              {!chapterPage.error && (
                <ul className="divide-y divide-line">
                  {chapters.map((chapter) => (
                    <li key={chapter.id}>
                      <label className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-xs">
                        <input type="checkbox" aria-label={chapter.name} checked={selected.includes(chapter.id)}
                          disabled={(!canDownload(chapter) && !selected.includes(chapter.id)) || Boolean(busy) || (!selected.includes(chapter.id) && selected.length >= maxSelection)}
                          className="h-4 w-4 accent-[#7E5EE9]"
                          onChange={(event) => setSelected(event.target.checked ? [...selected, chapter.id] : selected.filter((entry) => entry !== chapter.id))} />
                        <span className="min-w-0 flex-1 break-words font-semibold text-ink">{chapter.name}</span>
                        <span className="flex flex-wrap gap-1">
                          {chapter.id === latestId && <Badge>最新</Badge>}
                          {chapter.downloaded && <Badge tone="green">已下载</Badge>}
                          {excluded.has(chapter.id) && <Badge tone="gray">不在按章归档目录</Badge>}
                          <ChapterArchiveBadge archive={archiveRows.get(chapter.id)} />
                          {chapter.read && <Badge tone="gray">已读</Badge>}
                        </span>
                        <time className="text-ink-soft">{mangaDate(chapter.uploadDate)}</time>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {chapterPage.loading ? <p role="status" className="mt-3 text-xs text-ink-soft"><Spinner /> 读取章节…</p>
                : hasNextPage && !chapterPage.error && (
                  <Button size="sm" className="mt-3" disabled={Boolean(busy)} onClick={() => setOffset(chapters.length)}>加载更多章节</Button>
                )}
            </Card>
          </>
        )}
      <Modal open={confirmUnsubscribe} onClose={() => setConfirmUnsubscribe(false)} title="取消漫画追更？" width="max-w-[440px]"
        footer={<div className="flex justify-end gap-2">
          <Button size="sm" onClick={() => setConfirmUnsubscribe(false)}>保留订阅</Button>
          <Button size="sm" variant="danger" loading={busy === 'subscribe'}
            onClick={() => void changeMembership('subscribe', false)}>取消订阅并移出书架</Button>
        </div>}>
        <p className="p-5 text-sm text-ink-soft">Suwayomi 通过漫画书架决定追更范围。取消订阅会把此漫画移出书架。</p>
        {actionError && <MangaNotice message={actionError} />}
      </Modal>
    </div>
  )
}

function ChapterArchiveBadge({ archive }: { archive?: KomgaChapter }) {
  if (archive?.state === 'archived') return <Badge tone="green" className="max-w-full"><span className="truncate">CBZ · {archive.filename}</span></Badge>
  if (archive?.state === 'in_legacy_volume') return <Badge tone="gray">已在旧卷包 · {archive.legacyVolume}</Badge>
  if (archive?.state === 'waiting_archive') return <Badge tone="amber">等待打包</Badge>
  if (archive?.state === 'archive_failed') return <Badge tone="rose">打包失败</Badge>
  if (archive?.state === 'failed') return <Badge tone="rose">下载失败</Badge>
  if (archive?.state === 'queued') return <Badge tone="gray">已排队</Badge>
  if (archive?.state === 'downloading') return <Badge>下载中{archive.task?.percent != null ? ` ${archive.task.percent}%` : ''}</Badge>
  return null
}
