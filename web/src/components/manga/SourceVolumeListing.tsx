import { useState } from 'react'
import { Button } from '@/components/common/ui'
import { mangaVolumeApi, type MangaSourceListing } from '@/services/mangaApi'

const comparisons = {
  matches: '话号与核验目录一致',
  differs: '与核验目录有差异',
  ambiguous: '话号重复或有未编号条目',
  unverified: '暂无核验目录',
}

export function SourceVolumeListing({ mangaId, workUrl }: { mangaId: string; workUrl: string }) {
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<MangaSourceListing | null>(null)
  const [volume, setVolume] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = result?.volumes.find((row) => row.number === volume)

  async function inspect() {
    if (!file || !url.trim()) return
    setBusy(true)
    setError('')
    setResult(null)
    try {
      if (file.size > 512 * 1024) throw new Error('目录 JSON 最大为 512 KiB。')
      const listing: unknown = JSON.parse(await file.text())
      const audited = await mangaVolumeApi.inspectSource(mangaId, url.trim(), listing)
      setResult(audited)
      setVolume(audited.volumes[0]?.number ?? 0)
    } catch (failure) {
      setError(failure instanceof SyntaxError ? '目录文件不是有效的 JSON。'
        : failure instanceof Error ? failure.message : '暂时无法核对源站卷目录。')
    } finally { setBusy(false) }
  }

  return <details className="mt-3 rounded-xl border border-line p-3 text-xs">
    <summary className="cursor-pointer font-semibold text-ink">导入 Manga Downloader 源站卷目录</summary>
    <form className="mt-2 space-y-2" onSubmit={(event) => { event.preventDefault(); void inspect() }}>
      <p className="break-words text-ink-soft">用 <code>manga-downloader list --json</code> 导出当前源站的目录。结果用于核对卷和话号。</p>
      <label className="block text-ink-soft">导出时使用的作品网址
        <input type="url" required value={url} maxLength={1024} placeholder={workUrl} disabled={busy}
          className="mt-1 w-full rounded-lg border border-line bg-surface-soft px-2 py-1.5 text-ink"
          onChange={(event) => { setUrl(event.target.value); setResult(null) }} />
      </label>
      <label className="block text-ink-soft">Manga Downloader JSON 目录
        <input type="file" required accept=".json,application/json" disabled={busy} className="mt-1 block w-full"
          onChange={(event) => { setFile(event.target.files?.[0] ?? null); setResult(null) }} />
      </label>
      <Button type="submit" size="sm" loading={busy} disabled={busy || !file || !url.trim()}>核对源站卷目录</Button>
    </form>
    {error && <p className="mt-2 text-negative" role="alert">{error}</p>}
    {result && <div className="mt-3 space-y-2">
      <p role="status" className="text-ink-soft">{result.volumes.length ? `源站标注了 ${result.volumes.length} 卷` : '源站目录没有提供卷号'} · {result.unassigned} 个条目无卷号</p>
      {active && <>
        <label className="flex flex-wrap items-center gap-2 text-ink">选择源站卷
          <select value={volume} onChange={(event) => setVolume(Number(event.target.value))}
            className="max-w-full rounded-lg border border-line bg-surface-soft px-2 py-1.5">
            {result.volumes.map((row) => <option key={row.number} value={row.number}>第 {row.number} 卷 · {comparisons[row.comparison]}</option>)}
          </select>
        </label>
        {active.missing.length > 0 && <p className="break-words text-ink-soft">源站目录缺少 {active.missing.join('、')} 话</p>}
        {active.extra.length > 0 && <p className="break-words text-ink-soft">源站目录另有 {active.extra.join('、')} 话</p>}
        <ul className="max-h-52 space-y-1 overflow-y-auto break-words text-ink-soft" aria-label="源站该卷条目">
          {active.releases.map((row, index) => <li key={`${row.id ?? row.name}-${index}`}>
            {row.number === null ? '无话号' : `第 ${row.number} 话`} · {row.name || '无标题'}
            {row.language && ` · ${row.language}`}{row.group && ` · ${row.group}`}{row.locked && ' · 已锁定'}
          </li>)}
        </ul>
      </>}
    </div>}
  </details>
}
