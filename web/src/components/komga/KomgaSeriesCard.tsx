import { ApiCover } from '@/components/common/ApiCover'
import { Card } from '@/components/common/ui'
import { CoverArt } from '@/components/novel/CoverArt'
import { komgaCoverPath } from '@/services/komgaApi'
import type { KomgaSeries } from '@/services/komgaApi'
import { IS_LIVE } from '@/services/runtime'

export function KomgaSeriesCard({ series, compact = false }: { series: KomgaSeries; compact?: boolean }) {
  const coverClass = 'aspect-[3/4] w-full rounded-[11px]'
  return (
    <Card className="h-full min-w-0 overflow-hidden p-[6px]" hoverable data-komga-series={series.id}>
      {IS_LIVE ? <ApiCover path={komgaCoverPath(series.id)} title={series.title} className={coverClass} />
        : series.mockCover && <CoverArt theme={series.mockCover} index={0} title={series.title} media="manga" className={coverClass} />}
      <div className="space-y-1.5 px-2 pb-2 pt-3">
        <h3 className="break-words text-[13px] font-bold text-ink">{series.title}</h3>
        <p className="text-xs text-ink-soft">{series.booksCount} 本 · 已读 {series.booksReadCount}</p>
        {!compact && series.summary && <p className="line-clamp-2 break-words text-[11px] leading-relaxed text-ink-soft">{series.summary}</p>}
      </div>
    </Card>
  )
}
