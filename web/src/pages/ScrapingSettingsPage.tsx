import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/common/PageHeader'
import { Button, Card, SectionTitle, Spinner } from '@/components/common/ui'
import { useToast } from '@/components/common/Toast'
import { useAsync } from '@/hooks/useAsync'
import { komgaApi } from '@/services/komgaApi'
import { apiFetch, IS_LIVE } from '@/services/runtime'

type RefreshMode = 'manual' | 'after-sync' | 'after-sync-or-scrape'
type SourceMode = 'live' | 'archive'
type LibraryKind = 'all' | 'novel' | 'manga'
interface ScrapeOptions {
  minimumScore: number
  libraries: Array<{ id: string; kind: LibraryKind }>
  sortTitle: boolean
  addLocalVersion: boolean
  seriesCover: boolean
  bookCover: boolean
}
const defaultOptions: ScrapeOptions = {
  minimumScore: 0, libraries: [], sortTitle: false, addLocalVersion: false, seriesCover: false, bookCover: false,
}
const switches = [
  ['sortTitle', '为系列排序标题添加首字母', '用原始目录名排序。需要时在开头加上 Bangumi 标题的英文或拼音首字母。'],
  ['addLocalVersion', '添加本地出版社标签', '识别原始目录名中的出版社，将其加入 Komga 系列的流派栏。'],
  ['seriesCover', '使用 Bangumi 系列封面', '仅在 Komga 没有上传的系列封面时添加。'],
  ['bookCover', '使用 Bangumi 单册封面', '仅在 Komga 没有上传的单册封面时添加。'],
] as const
interface ScrapingStatus {
  preferences: {
    scrapeEnabled: boolean; scraperConfigured: boolean; refreshMode: RefreshMode; scrapeOptions?: ScrapeOptions
    postDownloadRefresh?: boolean; postDownloadScrape?: boolean
  }
  bangumi: {
    managed: boolean
    archiveAvailable: boolean
    archiveVersion: string | null
    sourceMode: SourceMode
    hasAccessToken: boolean
    hasSavedAccessToken: boolean
    proxyUrl?: string
  }
}

interface BangumiProbe {
  connected: true
  authenticated: true | null
  viaProxy: boolean
  elapsedMs: number
}

const endpoint = '/settings/integrations'
const tokenMask = '••••••••••••'
const input = 'mt-1 w-full rounded-lg border border-line bg-surface-soft px-3 py-2 text-sm outline-none focus:border-accent'

export function ScrapingSettingsPage() {
  const info = useAsync(() => IS_LIVE ? apiFetch<ScrapingStatus>(endpoint) : Promise.resolve(null), [])
  return (
    <div>
      <PageHeader eyebrow="设置" title="刮削"
        actions={<Link to="/settings" className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-accent hover:bg-accent-soft">
          <ArrowLeft className="h-4 w-4" /> 系统设置
        </Link>} />
      {!IS_LIVE && <Card className="p-5 text-sm text-ink-soft">连接 Studio 服务并登录管理员账号后即可配置刮削。</Card>}
      {info.loading && IS_LIVE && <p role="status"><Spinner /> 读取刮削设置…</p>}
      {info.error && <p role="alert" className="text-sm text-negative">{info.error}</p>}
      {info.data && <ScrapingForms initial={info.data} />}
    </div>
  )
}

function ScrapingForms({ initial }: { initial: ScrapingStatus }) {
  const { toast } = useToast()
  const [status, setStatus] = useState(initial)
  const [scrapeEnabled, setScrapeEnabled] = useState(initial.preferences.scrapeEnabled)
  const [refreshMode, setRefreshMode] = useState<RefreshMode>(initial.preferences.refreshMode)
  const [postDownloadRefresh, setPostDownloadRefresh] = useState(Boolean(initial.preferences.postDownloadRefresh))
  const [postDownloadScrape, setPostDownloadScrape] = useState(Boolean(initial.preferences.postDownloadScrape))
  const [options, setOptions] = useState(initial.preferences.scrapeOptions ?? defaultOptions)
  const libraries = useAsync(() => komgaApi.libraries(), [])
  const libraryChoices = new Map(libraries.data?.libraries.map(({ id, name }) => [id, name]))
  for (const { id } of options.libraries) {
    if (!libraryChoices.has(id)) libraryChoices.set(id, id)
  }
  const [sourceMode, setSourceMode] = useState<SourceMode>(initial.bangumi.sourceMode)
  const [accessToken, setAccessToken] = useState('')
  const [editingAccessToken, setEditingAccessToken] = useState(false)
  const [proxyUrl, setProxyUrl] = useState(initial.bangumi.proxyUrl ?? '')
  const [testResult, setTestResult] = useState<{ message: string; success: boolean } | null>(null)
  const [saving, setSaving] = useState<'scrape' | 'bangumi' | 'bangumi-test' | null>(null)
  const [error, setError] = useState('')
  const busy = saving !== null
  const preferencesChanged = scrapeEnabled !== status.preferences.scrapeEnabled || refreshMode !== status.preferences.refreshMode ||
    postDownloadRefresh !== Boolean(status.preferences.postDownloadRefresh) ||
    postDownloadScrape !== Boolean(status.preferences.postDownloadScrape) ||
    JSON.stringify(options) !== JSON.stringify(status.preferences.scrapeOptions ?? defaultOptions)
  const showTokenMask = status.bangumi.hasAccessToken && !editingAccessToken
  const bangumiChanged = sourceMode !== status.bangumi.sourceMode || Boolean(accessToken.trim()) ||
    proxyUrl.trim() !== (status.bangumi.proxyUrl ?? '')

  async function testBangumi() {
    setSaving('bangumi-test')
    setTestResult(null)
    setError('')
    try {
      const token = accessToken.trim()
      const result = await apiFetch<BangumiProbe>(endpoint, {
        method: 'POST', body: JSON.stringify({
          action: 'test-bangumi-connection', proxyUrl: proxyUrl.trim(), ...(token ? { accessToken: token } : {}),
        }),
      })
      const route = result.viaProxy ? '通过代理' : '直连'
      setTestResult({ success: true,
        message: `Bangumi 连接成功 · ${route} · ${result.elapsedMs} 毫秒${result.authenticated ? ' · 令牌验证通过' : ''}` })
    } catch (failure) {
      setTestResult({ success: false, message: failure instanceof Error ? failure.message : 'Bangumi 测试失败。' })
    } finally {
      setSaving(null)
    }
  }

  async function save(section: 'scrape' | 'bangumi', clearAccessToken = false) {
    setSaving(section)
    setError('')
    try {
      const token = accessToken.trim()
      const body = section === 'scrape' ? {
        action: 'save-komga-preferences', scrapeEnabled, refreshMode, scrapeOptions: options, postDownloadRefresh, postDownloadScrape,
      }
        : {
            action: 'save-bangumi-settings', sourceMode: clearAccessToken ? status.bangumi.sourceMode : sourceMode,
            ...(clearAccessToken ? { clearAccessToken: true }
              : { proxyUrl: proxyUrl.trim(), ...(token ? { accessToken: token } : {}) }),
          }
      const next = await apiFetch<ScrapingStatus>(endpoint, { method: 'POST', body: JSON.stringify(body) })
      setStatus(next)
      if (section === 'bangumi') {
        setAccessToken('')
        setEditingAccessToken(false)
        if (clearAccessToken) setTestResult(null)
        else setProxyUrl(next.bangumi.proxyUrl ?? '')
      } else setOptions(next.preferences.scrapeOptions ?? defaultOptions)
      toast({ tone: 'success', title: section === 'scrape' ? '刮削设置已保存' : 'Bangumi 配置已保存' })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败。')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="max-w-[960px] space-y-4">
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle title="刮削设置" />
          <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void save('scrape') }}>
            <div>
              <label className="flex items-center gap-2 py-2 text-sm text-ink">
                <input type="checkbox" role="switch" className="h-4 w-4 shrink-0 accent-accent"
                  checked={scrapeEnabled} onChange={(event) => setScrapeEnabled(event.target.checked)}
                  aria-describedby="scrape-enabled-help" disabled={busy} />
                启用元数据刮削
              </label>
              <p id="scrape-enabled-help" className="text-xs leading-relaxed text-ink-soft">
                {status.preferences.scraperConfigured
                  ? '允许 DSH 搜索、预览并写入轻小说和漫画元数据。'
                  : '还需为 Studio 和 DSH 部署元数据密钥文件。'}
              </p>
            </div>
            <div>
              <label className="block text-sm text-ink-soft">自动刷新 Komga 书库
                <select className={input} value={refreshMode} disabled={busy} aria-describedby="komga-refresh-help"
                  onChange={(event) => setRefreshMode(event.target.value as RefreshMode)}>
                  <option value="manual">仅手动刷新</option>
                  <option value="after-sync">同步路径后</option>
                  <option value="after-sync-or-scrape">同步路径或刮削写入后</option>
                </select>
              </label>
              <p id="komga-refresh-help" className="mt-2 text-xs leading-relaxed text-ink-soft">
                刷新由 Komga 在后台执行。「同步 Komga 路径」里也可手动刷新。
              </p>
            </div>
            <fieldset className="space-y-2 border-t border-line pt-4" disabled={busy}>
              <legend className="pr-3 text-sm font-semibold text-ink">漫画下载完成后</legend>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" role="switch" className="h-4 w-4 accent-accent" checked={postDownloadRefresh}
                  onChange={(event) => setPostDownloadRefresh(event.target.checked)} /> CBZ 写入后刷新 Komga 书库
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" role="switch" className="h-4 w-4 accent-accent" checked={postDownloadScrape}
                  onChange={(event) => setPostDownloadScrape(event.target.checked)} /> Komga 收录后自动刮削
              </label>
              <p className="text-xs leading-relaxed text-ink-soft">只处理新打包的漫画。自动刮削同时受刮削开关、书库范围和匹配规则控制。</p>
            </fieldset>
            <fieldset className="space-y-4 border-t border-line pt-4" disabled={busy}>
              <legend className="pr-3 text-sm font-semibold text-ink">匹配与写入</legend>
              <div>
                <label className="block text-sm text-ink-soft">标题匹配最低分
                  <input type="number" min={0} max={100} step={1} required className={input}
                    value={Number.isNaN(options.minimumScore) ? '' : options.minimumScore}
                    aria-describedby="scrape-minimum-help"
                    onChange={(event) => setOptions({ ...options, minimumScore: event.target.valueAsNumber })} />
                </label>
                <p id="scrape-minimum-help" className="mt-2 text-xs text-ink-soft">0 表示不过滤候选，BangumiKomga 的默认值为 80。手动选择条目 ID 时仍可预览。</p>
              </div>
              <div className="space-y-2">
                <p className="text-sm text-ink-soft">允许刮削的 Komga 书库</p>
                <p className="text-xs text-ink-soft">不指定书库时允许所有书库。为任一书库指定类型后，仅允许列表内所选的书库和类型。</p>
                {libraries.loading && <p role="status" className="text-xs text-ink-soft">读取 Komga 书库…</p>}
                {libraries.error && <p className="text-xs text-negative">暂时无法读取 Komga 书库。已保存的规则仍可查看和修改。</p>}
                {!libraries.loading && !libraries.error && libraryChoices.size === 0 && <p className="text-xs text-ink-soft">Komga 暂无书库。</p>}
                {[...libraryChoices].map(([id, name]) => (
                  <label key={id} className="block break-words text-sm text-ink-soft">{name}
                    <select className={input} value={options.libraries.find((item) => item.id === id)?.kind ?? ''}
                      onChange={(event) => {
                        const kind = event.target.value as LibraryKind | ''
                        setOptions({ ...options, libraries: [
                          ...options.libraries.filter((item) => item.id !== id), ...(kind ? [{ id, kind }] : []),
                        ] })
                      }}>
                      <option value="">未指定</option>
                      <option value="all">轻小说与漫画</option>
                      <option value="novel">仅轻小说</option>
                      <option value="manga">仅漫画</option>
                    </select>
                  </label>
                ))}
              </div>
              {status.bangumi.managed && <div className="space-y-2">
                {switches.map(([key, label, hint]) => <div key={key}>
                  <label className="flex items-center gap-2 py-1 text-sm text-ink">
                    <input type="checkbox" role="switch" className="h-4 w-4 shrink-0 accent-accent"
                      checked={options[key]} onChange={(event) => setOptions({ ...options, [key]: event.target.checked })}
                      aria-describedby={`scrape-${key}-help`} />
                    {label}
                  </label>
                  <p id={`scrape-${key}-help`} className="text-xs leading-relaxed text-ink-soft">{hint}</p>
                </div>)}
                <p className="text-xs text-ink-soft">封面选项仅在使用 Bangumi 实时 API 时生效。</p>
              </div>}
            </fieldset>
            <Button type="submit" size="sm" variant="primary" loading={saving === 'scrape'}
              disabled={busy || !preferencesChanged}>保存刮削设置</Button>
          </form>
        </Card>
        <Card className="p-5">
          <SectionTitle title="Bangumi 配置" />
          <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void save('bangumi') }}>
            <div>
              <label className="block text-sm text-ink-soft">Bangumi 数据源
                <select className={input} value={sourceMode} disabled={busy || !status.bangumi.managed}
                  aria-describedby="bangumi-source-help" onChange={(event) => setSourceMode(event.target.value as SourceMode)}>
                  <option value="live">官方实时 API</option>
                  <option value="archive" disabled={!status.bangumi.archiveAvailable}>官方离线档案</option>
                </select>
              </label>
              <p id="bangumi-source-help" className="mt-2 text-xs leading-relaxed text-ink-soft">
                {!status.bangumi.managed ? '当前部署尚未启用内置 Bangumi 配置。'
                  : status.bangumi.archiveAvailable
                    ? status.bangumi.archiveVersion
                      ? '已安装官方档案 · ' + new Date(status.bangumi.archiveVersion).toLocaleDateString('zh-CN')
                      : '已安装官方档案'
                    : '尚未安装官方离线档案。'}
              </p>
            </div>
            <div>
              <label className="block text-sm text-ink-soft">Bangumi 访问令牌（可选）
                <input type="password" name="bangumi-access-token" autoComplete="new-password" className={input}
                  value={showTokenMask ? tokenMask : accessToken} maxLength={768} readOnly={showTokenMask}
                  onChange={(event) => { setAccessToken(event.target.value); setTestResult(null) }}
                  aria-describedby="bangumi-token-help" placeholder="输入 Bangumi 访问令牌"
                  disabled={busy || !status.bangumi.managed} />
              </label>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <p id="bangumi-token-help" className="text-xs text-ink-soft">
                  {status.bangumi.hasSavedAccessToken ? '已保存 · 仅实时 API 使用'
                    : status.bangumi.hasAccessToken ? '已由服务器配置 · 仅实时 API 使用' : '仅实时 API 使用'}
                </p>
                {status.bangumi.hasAccessToken && <Button type="button" size="sm" disabled={busy || !status.bangumi.managed}
                  onClick={() => { setEditingAccessToken(!editingAccessToken); setAccessToken(''); setTestResult(null) }}>
                  {editingAccessToken ? '取消修改令牌' : '修改令牌'}
                </Button>}
              </div>
            </div>
            <div>
              <label className="block text-sm text-ink-soft">Bangumi 代理地址（可选）
                <input type="text" name="bangumi-proxy-url" autoComplete="off" className={input}
                  value={proxyUrl} onChange={(event) => { setProxyUrl(event.target.value); setTestResult(null) }}
                  maxLength={512} placeholder="http://192.168.1.10:7890" aria-describedby="bangumi-proxy-help"
                  disabled={busy || !status.bangumi.managed} />
              </label>
              <p id="bangumi-proxy-help" className="mt-2 text-xs leading-relaxed text-ink-soft">
                填写 Studio 容器可访问的 HTTP(S) 代理地址。留空则直连。连接测试使用当前输入的配置。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" variant="primary" loading={saving === 'bangumi'}
                disabled={busy || !status.bangumi.managed || !bangumiChanged}>保存 Bangumi 配置</Button>
              <Button type="button" size="sm" loading={saving === 'bangumi-test'} disabled={busy || !status.bangumi.managed}
                onClick={() => void testBangumi()}>测试 Bangumi 连接</Button>
              {status.bangumi.hasSavedAccessToken && <Button type="button" size="sm" disabled={busy}
                onClick={() => void save('bangumi', true)}>清除已保存令牌</Button>}
            </div>
            {testResult && <p role={testResult.success ? 'status' : 'alert'}
              className={`text-sm ${testResult.success ? 'text-positive' : 'text-negative'}`}>{testResult.message}</p>}
          </form>
        </Card>
      </div>
      {error && <p role="alert" className="text-sm text-negative">{error}</p>}
    </div>
  )
}
