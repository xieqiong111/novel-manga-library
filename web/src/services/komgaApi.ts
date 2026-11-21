import { IS_LIVE, apiFetch } from '@/services/runtime'
import type { CoverTheme } from '@/types'

export interface KomgaLibrary {
  id: string
  name: string
}

export interface KomgaSeries {
  id: string
  libraryId: string
  title: string
  summary: string | null
  booksCount: number
  booksReadCount: number
  mockCover?: CoverTheme
}

interface SeriesPage {
  content: KomgaSeries[]
  page: { number: number; size: number; totalElements: number; totalPages: number; first: boolean; last: boolean }
}

export interface KomgaMaintenanceJob {
  libraryId: string
  libraryName: string
  state: 'running' | 'finished'
  stage: 'loading' | 'scraping' | 'scanning'
  total: number | null
  checked: number
  updated: number
  skipped: number
  failed: number
  coverFailures: number
  issues: Array<{ title: string; message: string }>
  scan: { accepted: boolean; message: string } | null
  error: string | null
}

interface MaintenanceStatus {
  unavailable: string | null
  job: KomgaMaintenanceJob | null
}

const size = 24
const demoLibraries: KomgaLibrary[] = [
  { id: 'demo-manga', name: '演示漫画库' },
  { id: 'demo-comics', name: '演示图像小说库' },
]
const demoSeries: KomgaSeries[] = [
  { id: 'demo-001', libraryId: 'demo-manga', title: '海边邮局', summary: '海风停下的时候，邮局只为岛上最后一班船开门。', booksCount: 4, booksReadCount: 2, mockCover: 'mountain' },
  { id: 'demo-002', libraryId: 'demo-manga', title: '暮色书店', summary: '一间夜间营业的书店和它的三个常客。', booksCount: 2, booksReadCount: 0, mockCover: 'night' },
  { id: 'demo-003', libraryId: 'demo-comics', title: '去山那边', summary: '一趟沿着旧铁路展开的旅行。', booksCount: 1, booksReadCount: 1, mockCover: 'paper' },
]

export const komgaApi = {
  async libraries(): Promise<{ libraries: KomgaLibrary[] }> {
    return IS_LIVE ? apiFetch('/komga/libraries') : { libraries: demoLibraries }
  },

  async series(libraryId: string, query: string, page: number, pageSize = size): Promise<SeriesPage> {
    if (IS_LIVE) {
      const params = new URLSearchParams({ libraryId, query, page: String(page), size: String(pageSize) })
      return apiFetch(`/komga/series?${params}`)
    }
    const title = query.trim().toLocaleLowerCase()
    const filtered = demoSeries.filter((item) => item.libraryId === libraryId && item.title.toLocaleLowerCase().includes(title))
    const totalPages = Math.ceil(filtered.length / pageSize)
    return {
      content: filtered.slice(page * pageSize, (page + 1) * pageSize),
      page: { number: page, size: pageSize, totalElements: filtered.length, totalPages, first: page === 0, last: page + 1 >= totalPages },
    }
  },

  maintenance(libraryId: string, signal?: AbortSignal): Promise<MaintenanceStatus> {
    return apiFetch(`/komga/maintenance?${new URLSearchParams({ libraryId })}`, { signal })
  },

  startMaintenance(libraryId: string): Promise<MaintenanceStatus> {
    return apiFetch('/komga/maintenance', { method: 'POST', body: JSON.stringify({ libraryId }) })
  },
}

export function komgaCoverPath(id: string) {
  return `/komga/series/${encodeURIComponent(id)}/thumbnail`
}
