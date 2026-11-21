import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/common/PageHeader'
import { Button, Card, SectionTitle, Spinner } from '@/components/common/ui'
import { useToast } from '@/components/common/Toast'
import { useAsync } from '@/hooks/useAsync'
import { apiFetch, IS_LIVE } from '@/services/runtime'

type RefreshMode = 'manual' | 'after-sync' | 'after-sync-or-scrape'
type SourceMode = 'live' | 'archive'
interface ScrapingStatus {
  preferences: { scrapeEnabled: boolean; scraperConfigured: boolean; refreshMode: RefreshMode }
  bangumi: {
    managed: boolean
    archiveAvailable: boolean
    archiveVersion: string | null
    sourceMode: SourceMode
    hasAccessToken: boolean
    hasSavedAccessToken: boolean
  }
}

const endpoint = '/settings/integrations'
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
  const [sourceMode, setSourceMode] = useState<SourceMode>(initial.bangumi.sourceMode)
  const [accessToken, setAccessToken] = useState('')
  const [saving, setSaving] = useState<'scrape' | 'bangumi' | null>(null)
  const [error, setError] = useState('')
  const busy = saving !== null
  const preferencesChanged = scrapeEnabled !== status.preferences.scrapeEnabled || refreshMode !== status.preferences.refreshMode
  const bangumiChanged = sourceMode !== status.bangumi.sourceMode || Boolean(accessToken.trim())

  async function save(section: 'scrape' | 'bangumi', clearAccessToken = false) {
    setSaving(section)
    setError('')
    try {
      const token = accessToken.trim()
      const body = section === 'scrape' ? { action: 'save-komga-preferences', scrapeEnabled, refreshMode }
        : {
            action: 'save-bangumi-settings', sourceMode,
            ...(clearAccessToken ? { clearAccessToken: true } : token ? { accessToken: token } : {}),
          }
      const next = await apiFetch<ScrapingStatus>(endpoint, { method: 'POST', body: JSON.stringify(body) })
      setStatus(next)
      if (section === 'bangumi') setAccessToken('')
      toast({ tone: 'success', title: section === 'scrape' ? '刮削设置已保存' : 'Bangumi 配置已保存' })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败。')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="max-w-[960px] space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
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
            <label className="block text-sm text-ink-soft">Bangumi 访问令牌（可选）
              <input type="password" name="bangumi-access-token" autoComplete="off" className={input}
                value={accessToken} onChange={(event) => setAccessToken(event.target.value)} maxLength={768}
                placeholder={status.bangumi.hasAccessToken ? '已配置 · 输入新令牌可替换' : '仅实时 API 使用'}
                disabled={busy || !status.bangumi.managed || sourceMode !== 'live'} />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" variant="primary" loading={saving === 'bangumi'}
                disabled={busy || !status.bangumi.managed || !bangumiChanged}>保存 Bangumi 配置</Button>
              {status.bangumi.hasSavedAccessToken && <Button type="button" size="sm" disabled={busy}
                onClick={() => void save('bangumi', true)}>清除已保存令牌</Button>}
            </div>
          </form>
        </Card>
      </div>
      {error && <p role="alert" className="text-sm text-negative">{error}</p>}
    </div>
  )
}
