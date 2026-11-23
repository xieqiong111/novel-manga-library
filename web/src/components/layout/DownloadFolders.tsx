import { useState } from 'react'
import { ChevronRight, Folder, FolderOpen, HardDrive, RefreshCw } from 'lucide-react'
import { Button, Card, SectionTitle, Spinner } from '@/components/common/ui'
import { Modal } from '@/components/common/Modal'
import { apiFetch } from '@/services/runtime'
import { useAsync } from '@/hooks/useAsync'
import { useToast } from '@/components/common/Toast'

type Kind = 'novel' | 'manga'
const catalogSources = [
  ['publisher', '出版社官方目录'],
  ['reference', '核对过的参考目录'],
  ['opentome', 'OpenTomeDB 本地目录'],
] as const
const archiveChoices = [
  ['chapter', '不分卷 · 单话 CBZ', '所有新章节直接保存在作品文件夹。'],
  ['volume-chapters', '按单行本分目录 · 单话 CBZ', '每卷一个文件夹，里面每话各有一个 CBZ。'],
  ['volume-cbz', '按单行本合卷 · 整卷 CBZ', '凑齐一卷后合成一个带章节书签的 CBZ。缺话期间仍可阅读已下载的单话。'],
] as const
type ArchiveMode = typeof archiveChoices[number][0]
type ArchiveOptions = { mode: ArchiveMode; sources: string[] }
type FolderSettings = { enabled: boolean; root: string | null; folder: string | null; legacyFolder?: string; archive?: ArchiveOptions }
type Folders = Record<Kind, FolderSettings>
type Library = { id: string; name: string; selectable: boolean; folder: string | null }
const endpoint = '/settings/download-folders'
const komgaEndpoint = endpoint + '/komga'
const inputStyle = 'w-full rounded-lg border border-line bg-surface-soft px-3 py-2 text-sm focus:border-[#7E5EE9] focus:outline-none'
const join = (...parts: (string | null)[]) => parts.filter(Boolean).join('/')
const post = <T,>(url: string, data: object) => apiFetch<T>(url, { method: 'POST', body: JSON.stringify(data) })

export function DownloadFolders() {
  const [revision, setRevision] = useState(0)
  const catalog = useAsync(() => apiFetch<Folders>(endpoint), [revision])
  const reload = () => setRevision((value) => value + 1)
  return (
    <Card className="p-5">
      <SectionTitle title="NAS 保存目录" />
      <p className="mb-4 mt-2 text-xs text-ink-soft">选择轻小说 EPUB 和漫画 CBZ 的保存位置。</p>
      {catalog.loading && !catalog.data && <p role="status"><Spinner /> 读取保存目录…</p>}
      {catalog.error && <p role="alert" className="text-sm text-negative">{catalog.error}</p>}
      {catalog.data && <div className="grid gap-4 md:grid-cols-2">
        <FolderPicker kind="novel" label="轻小说 EPUB" saved={catalog.data.novel} reload={reload} />
        <FolderPicker kind="manga" label="漫画 CBZ" saved={catalog.data.manga} reload={reload} />
      </div>}
      {catalog.data?.manga.enabled && catalog.data.manga.archive && (
        <MangaArchiveSettings key={JSON.stringify(catalog.data.manga.archive)} saved={catalog.data.manga.archive} reload={reload} />
      )}
    </Card>
  )
}

function MangaArchiveSettings({ saved, reload }: { saved: ArchiveOptions; reload: () => void }) {
  const { toast } = useToast()
  const [options, setOptions] = useState(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const changed = JSON.stringify(options) !== JSON.stringify(saved)
  const toggle = (source: string) => setOptions((current) => ({
    ...current,
    sources: catalogSources.map(([key]) => key).filter((key) =>
      key === source ? !current.sources.includes(key) : current.sources.includes(key)),
  }))
  async function save() {
    setError('')
    setBusy(true)
    try {
      await post(endpoint + '/manga-archive', { mode: options.mode, sources: options.sources })
      toast({ tone: 'success', title: '漫画归档设置已保存' })
      reload()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存漫画归档设置失败。')
    } finally { setBusy(false) }
  }
  return <section className="mt-4 space-y-3 rounded-xl border border-line p-4">
    <fieldset disabled={busy} className="space-y-2">
      <legend className="mb-2 text-sm font-semibold text-ink">漫画归档方式</legend>
      {archiveChoices.map(([mode, label, description]) => <label key={mode} className="flex items-start gap-2 text-sm">
        <input type="radio" name="manga-archive-mode" value={mode} className="mt-1 shrink-0 accent-accent"
          checked={options.mode === mode} onChange={() => setOptions({ ...options, mode })} />
        <span>{label}<span className="block text-xs text-ink-soft">{description}</span></span>
      </label>)}
    </fieldset>
    {options.mode !== 'chapter' && <p className="text-xs text-ink-soft">按已核验卷目录分组，待确认章节进入「未分卷」。</p>}
    <fieldset disabled={busy || options.mode === 'chapter'} className="flex flex-wrap gap-3 text-xs">
      <legend className="mb-2 font-semibold">卷目录来源</legend>
      {catalogSources.map(([source, label]) => <label key={source} className="flex items-center gap-1.5">
        <input type="checkbox" className="accent-accent" checked={options.sources.includes(source)} onChange={() => toggle(source)} />
        {label}
      </label>)}
    </fieldset>
    {options.mode !== 'chapter' && options.sources.includes('opentome') && <p className="text-xs text-ink-soft">OpenTomeDB 由服务端挂载 SQLite 文件后可用。</p>}
    {error && <p role="alert" className="text-xs text-negative">{error}</p>}
    <Button size="sm" variant="primary" loading={busy} disabled={busy || !changed} onClick={() => void save()}>保存漫画归档设置</Button>
  </section>
}

function FolderPicker({ kind, label, saved, reload }: { kind: Kind; label: string; saved: FolderSettings; reload: () => void }) {
  const { toast } = useToast()
  const [dialog, setDialog] = useState<'nas' | 'komga' | null>(null)
  const current = saved.folder === null ? saved.legacyFolder : join(saved.root, saved.folder)
  async function reset() {
    try {
      await post(endpoint, { kind, folder: null })
      reload()
    } catch (error) {
      toast({ tone: 'warning', title: error instanceof Error ? error.message : '恢复路径失败。' })
    }
  }

  return (
    <section className="min-w-0 rounded-xl border border-line p-4">
      <h3 className="text-sm font-semibold text-ink">{label}</h3>
      {!saved.enabled ? (
        <p className="mt-2 text-xs text-ink-soft">当前实例未挂载可选目录。</p>
      ) : (
        <>
          <p className="my-2 break-all text-xs text-ink-soft">{current}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={() => setDialog('nas')}>浏览 NAS</Button>
            <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => setDialog('komga')}>同步 Komga 路径</Button>
            {kind === 'novel' && saved.folder !== null && <Button size="sm" onClick={() => void reset()}>恢复默认路径</Button>}
          </div>
          {dialog === 'nas' && <NasDialog kind={kind} label={label} saved={saved} onClose={() => setDialog(null)} onSave={reload} />}
          {dialog === 'komga' && <KomgaDialog kind={kind} label={label} root={saved.root} onClose={() => setDialog(null)} onSave={reload} />}
        </>
      )}
    </section>
  )
}

function NasDialog({ kind, label, saved, onClose, onSave }: {
  kind: Kind; label: string; saved: FolderSettings; onClose: () => void; onSave: () => void
}) {
  const [folder, setFolder] = useState(saved.folder ?? '')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const parts = folder ? folder.split('/') : []
  const browse = useAsync(() => apiFetch<{ folder: string; entries: string[] }>(
    `${endpoint}/browse?${new URLSearchParams({ kind, folder })}`,
  ), [kind, folder])
  const move = (destination: string) => { setFolder(destination); setName(''); setError('') }
  const waiting = browse.loading || (!browse.error && browse.data?.folder !== folder)
  const enabled = !busy && !waiting && !browse.error

  const save = async (create = false) => {
    setError('')
    setBusy(true)
    try {
      await post(endpoint, { kind, folder: create ? join(folder, name.trim()) : folder, create })
      onSave()
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败。')
    } finally {
      setBusy(false)
    }
  }

  return <Modal open onClose={() => { if (!busy) onClose() }} title={`选择${label}目录`}
    footer={<div className="flex justify-end gap-2">
      <Button size="sm" disabled={busy} onClick={onClose}>取消</Button>
      <Button size="sm" variant="primary" disabled={!enabled} onClick={() => void save()}>使用此目录</Button>
    </div>}>
    <div className="space-y-4 p-5">
      <nav aria-label="NAS 目录层级" className="flex flex-wrap items-center gap-1 text-sm">
        <Button size="sm" icon={<HardDrive className="h-3.5 w-3.5" />} disabled={busy} onClick={() => move('')}>挂载根目录</Button>
        {parts.map((part, index) => <span key={parts.slice(0, index + 1).join('/')} className="flex max-w-full items-center">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-soft" />
          <Button className="min-w-0 break-all" size="sm" disabled={busy} onClick={() => move(parts.slice(0, index + 1).join('/'))}>{part}</Button>
        </span>)}
      </nav>
      <p className="break-all rounded-lg bg-accent-soft p-2 text-xs text-accent">{join(saved.root, folder)}</p>
      <div className="max-h-64 overflow-auto rounded-xl border border-line">
        {waiting ? <p className="p-3 text-xs" role="status"><Spinner /> 读取文件夹…</p>
          : browse.error ? <p className="p-3 text-xs text-negative" role="alert">{browse.error}</p>
            : browse.data?.entries.length ? <ul className="divide-y divide-[#EFEDF6]">
              {browse.data.entries.map((entry) => <li key={entry}>
                <button type="button" disabled={busy} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent-soft"
                  onClick={() => move(join(folder, entry))}>
                  <Folder className="h-4 w-4 shrink-0 text-accent" /><span className="min-w-0 flex-1 break-all">{entry}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-ink-soft" />
                </button>
              </li>)}
            </ul> : <p className="p-3 text-xs text-ink-soft">这个目录没有可浏览的子文件夹。</p>}
      </div>
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void save(true) }}>
        <input className={inputStyle} aria-label="新文件夹名称" placeholder="新文件夹名称" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
        <Button type="submit" size="sm" disabled={!enabled || !name.trim() || /[\\/]/.test(name)}>新建并使用</Button>
      </form>
      {error && <p role="alert" className="text-xs text-negative">{error}</p>}
    </div>
  </Modal>
}

function KomgaDialog({ kind, label, root, onClose, onSave }: {
  kind: Kind; label: string; root: string | null; onClose: () => void; onSave: () => void
}) {
  const { toast } = useToast()
  const [id, setId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const connection = useAsync(() => apiFetch<{ libraries: Library[]; refreshOnSync?: boolean }>(`${komgaEndpoint}?kind=${kind}`), [kind])
  const libraries = connection.data?.libraries ?? []
  const refreshOnSync = connection.data?.refreshOnSync !== false
  const library = libraries.find((item) => item.id === id) ?? libraries.find((item) => item.selectable)
  async function submit(action: 'scan' | 'sync') {
    if (!library) return
    setBusy(true)
    setError('')
    try {
      const result = await post<{ scan: { accepted: boolean; skipped?: boolean; message: string } }>(komgaEndpoint, { kind, action, libraryId: library.id })
      if (action === 'sync') onSave()
      if (result.scan.skipped && action === 'sync') {
        toast({ tone: 'success', title: 'Komga 路径已同步' })
        onClose()
      } else if (result.scan.accepted) {
        toast({ tone: 'success', title: action === 'sync' ? '目录已同步，Komga 已接受刷新' : 'Komga 已接受刷新' })
        onClose()
      } else setError((action === 'sync' ? '目录已同步。' : '') + result.scan.message)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作失败。')
    } finally { setBusy(false) }
  }

  return <Modal open onClose={() => { if (!busy) onClose() }} title={`同步${label}到 Komga 书库`}
    footer={<div className="flex flex-wrap justify-end gap-2">
      <Button size="sm" disabled={busy || !library} onClick={() => void submit('scan')}>仅刷新书库</Button>
      <Button size="sm" variant="primary" disabled={busy || !library?.selectable} onClick={() => void submit('sync')}>{refreshOnSync ? '同步路径并刷新' : '同步路径'}</Button>
    </div>}>
    <div className="space-y-3 p-5">
      {connection.loading && <p role="status" className="text-sm"><Spinner /> 读取 Komga 书库…</p>}
      {connection.error && <p role="alert" className="text-sm text-negative">无法读取 Komga 书库。请在「服务集成」检查连接。{connection.error}</p>}
      {connection.data && (libraries.length ? <label className="block text-sm font-semibold text-ink">Komga 书库
        <select className={inputStyle + ' mt-2'} value={library?.id ?? ''} disabled={busy} onChange={(event) => setId(event.target.value)}>
          {!library && <option value="" disabled>选择一个书库</option>}
          {libraries.map((item) => <option key={item.id} value={item.id}>{item.name}{item.selectable ? '' : '（目录不可同步）'}</option>)}
        </select>
      </label> : <p className="text-sm text-ink-soft">当前 Komga 账号没有可访问的书库。</p>)}
      {library?.selectable && <p className="break-all rounded-lg bg-accent-soft p-2 text-xs text-accent">新文件将保存到 {join(root, library.folder)}</p>}
      {library && !library.selectable && <p className="text-xs text-ink-soft">此书库目录不在当前类型的可写 NAS 挂载中。</p>}
      <p className="text-xs text-ink-soft">刷新由 Komga 在后台执行，需要 Komga 管理员权限。</p>
      {error && <p role="alert" className="text-xs text-negative">{error}</p>}
    </div>
  </Modal>
}
