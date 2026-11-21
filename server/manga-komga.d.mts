import type { SuwayomiClient, SuwayomiTask } from './suwayomi-client.mjs'

type MangaArchiveState = 'idle' | 'archived' | 'waiting_archive' | 'archive_failed' | 'failed' | 'downloading' | 'queued' | 'in_legacy_volume'

export interface MangaArchiveSelection {
  chapterIds?: string[]
  offset?: number
  limit?: number
}

export interface MangaArchiveStatus {
  available: boolean
  archiveMode?: 'volume' | 'chapter' | 'unsupported'
  volumes: Array<{
    number: number
    chapterIds?: string[]
    total: number
    downloaded: number
    filename: string | null
    state: MangaArchiveState
    tasks: SuwayomiTask[]
  }>
  chapters?: Array<{
    id: string
    number: string | null
    name: string
    downloaded: boolean
    filename: string | null
    legacyVolume?: string
    state: MangaArchiveState
    task: SuwayomiTask | null
  }>
  chapterPage?: { total: number; offset: number; nextOffset: number | null }
  missingChapterIds?: string[]
}

type MangaArchiveDownload = Omit<Awaited<ReturnType<SuwayomiClient['download']>>, 'queue'> & {
  queue?: SuwayomiTask[]
  filename: string | null
  archived?: Array<{ chapterId: string; filename: string }>
}

export interface MangaKomga {
  history(mangaId?: string | null, before?: number): Promise<{
    history: Array<SuwayomiTask & { observedAt: number; archive: { state: string; file: string | null } }>
    nextBefore: number | null
  } | { historyError: string } | null>
  status(mangaId: string, volume?: number, selection?: MangaArchiveSelection): Promise<MangaArchiveStatus>
  download(mangaId: string, volume: number): Promise<MangaArchiveDownload>
  downloadChapters(mangaId: string, chapterIds: string[]): Promise<MangaArchiveDownload>
}

export declare function createMangaKomga(client: SuwayomiClient, getVolumes?: undefined, archiveUrl?: string): MangaKomga
