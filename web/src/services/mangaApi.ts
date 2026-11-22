import { mangaMock } from '@/data/mangaMock'
import { IS_LIVE, apiFetch } from '@/services/runtime'
import type { Manga, MangaChapter, MangaHealth, MangaSource, MangaTask } from '@/types/manga'

type MangaPage = { mangas: Manga[]; hasNextPage: boolean }
type ChapterPage = { chapters: MangaChapter[]; hasNextPage: boolean }
type SearchResult = MangaPage & { nextOffset?: number | null; resultId?: string | null; truncated?: boolean; errors?: { sourceId: string; message: string }[] }
type DownloadResult = { queued: string[]; skipped: string[]; completed?: string[]; unconfirmed?: string[] }
type MangaTaskPage = {
  queue: MangaTask[]
  history?: MangaTask[]
  nextBefore?: number | null
  queueError?: string
  historyError?: string
}

const mangaPath = (id: string) => `/manga/${encodeURIComponent(id)}`
const jsonPost = (body?: object): RequestInit => ({ method: 'POST', body: JSON.stringify(body ?? {}) })

const liveMangaApi = {
  sources: () => apiFetch<{ sources: MangaSource[] }>('/manga/sources'),
  health: () => apiFetch<MangaHealth>('/manga/health'),
  search: (query: string, sourceId: string, page: number, offset: number, resultId?: string) => {
    const params = new URLSearchParams({ query, page: String(page), offset: String(offset) })
    if (sourceId) params.set('sourceId', sourceId)
    if (resultId) params.set('resultId', resultId)
    return apiFetch<SearchResult>(`/manga/search?${params}`)
  },
  details: (id: string) => apiFetch<Manga>(mangaPath(id)),
  chapters: (id: string, offset: number, limit = 50) => apiFetch<ChapterPage>(`${mangaPath(id)}/chapters?offset=${offset}&limit=${limit}`),
  refresh: (id: string) => apiFetch<ChapterPage>(`${mangaPath(id)}/chapters/refresh`, jsonPost()),
  library: (offset: number) => apiFetch<MangaPage>(`/manga/library?offset=${offset}`),
  setLibrary: (id: string, inLibrary: boolean) => apiFetch<Manga>(`${mangaPath(id)}/library`, jsonPost({ inLibrary })),
  subscribe: (id: string, subscribed: boolean) => apiFetch<Manga>(`${mangaPath(id)}/subscribe`, jsonPost({ subscribed })),
  tasks: (before?: number): Promise<MangaTaskPage> => apiFetch(
    before === undefined ? '/manga/downloads' : `/manga/downloads?before=${before}`,
  ),
  download: (mangaId: string, chapterIds: string[]) => apiFetch<DownloadResult>('/manga/downloads', jsonPost({ mangaId, chapterIds })),
}

export const mangaApi: typeof liveMangaApi = IS_LIVE ? liveMangaApi : mangaMock

export interface MangaVolumeCatalog {
  enabled: boolean
  sources: string[]
  bound: boolean
  openTomeConfigured: boolean
  volumes: { number: number; chapters: string[]; source: string; url: string; confirmed: boolean; conflict?: boolean }[]
  volumeMetadata: { number: number; subjectId: number; isbn?: string; date?: string }[]
}
export const mangaVolumeApi = {
  get: (id: string) => apiFetch<MangaVolumeCatalog>(mangaPath(id) + '/volume-catalog'),
  resolve: (id: string, action: 'resolve' | 'opentome', volume?: number) =>
    apiFetch<MangaVolumeCatalog>(mangaPath(id) + '/volume-catalog', jsonPost({ action, volume })),
}

export async function chaptersForVolumeView(id: string) {
  const chapters = new Map<string, MangaChapter>()
  let offset = 0
  while (offset < 5000) {
    const page = await mangaApi.chapters(id, offset, 100)
    for (const chapter of page.chapters) chapters.set(chapter.id, chapter)
    if (!page.hasNextPage) return [...chapters.values()]
    if (!page.chapters.length) break
    offset += page.chapters.length
  }
  throw new Error('无法读取完整的章节目录，请切回按话查看。')
}

export interface KomgaChapter {
  id: string
  filename: string | null
  legacyVolume?: string
  packedVolume?: true
  state: 'idle' | 'archived' | 'waiting_archive' | 'archive_failed' | 'failed' | 'downloading' | 'queued' | 'in_legacy_volume'
  task: MangaTask | null
}

export const mangaKomgaApi = {
  status: (id: string, chapterIds: string[]) => apiFetch<{
    available: boolean
    archiveMode?: 'chapter' | 'unsupported' | 'volume'
    chapters?: KomgaChapter[]
    missingChapterIds?: string[]
  }>(`${mangaPath(id)}/komga?${new URLSearchParams({ chapterIds: chapterIds.join(',') })}`),
  download: (id: string, chapterIds: string[]) => apiFetch<DownloadResult>(`${mangaPath(id)}/komga`, jsonPost({ chapterIds })),
}
