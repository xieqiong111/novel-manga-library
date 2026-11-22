import type { Manga, MangaChapter } from '@/types/manga'

type Citation = { label: string; url: string }
interface PublishedVolume {
  number: number
  chapters: readonly string[]
  citation: Citation
}

// Bind published assignments to an extension and its exact work URL.
const catalogs: Record<string, PublishedVolume[]> = {
  '774030471139699415:baozimh.org/manga/weimeihaodeshijiexianshangzhufu-xiaonatumetuntamazi': [
    {
      number: 1,
      chapters: ['1', '2', '3', '4', '5'],
      citation: {
        label: '出版社第 1 卷目录',
        url: 'https://yenpress.com/titles/9780316552561-konosuba-god-s-blessing-on-this-wonderful-world-vol-1-manga',
      },
    },
  ],
}

const chapterAtStart = /^(?:第\s*|ch(?:apter)?\.?\s*)?(\d{1,4}(?:\.\d{1,4})?)(?=$|[\s话話章节節回:：、_—-])/iu
const volumeAtStart = /^(?:第\s*(\d{1,4})\s*[卷巻册冊]|vol(?:ume)?\.?\s*(\d{1,4}))(?=$|\D)/iu

function chapterLabels(name: string) {
  const title = name.normalize('NFKC').trim()
  const volume = volumeAtStart.exec(title)
  const rest = volume ? title.slice(volume[0].length).replace(/^[\s.·:：_—–\-（(\[【]+/u, '') : title
  const numbered = chapterAtStart.exec(rest)
  return {
    volume: volume ? Number(volume[1] ?? volume[2]) : null,
    chapter: numbered ? String(Number(numbered[1])) : null,
  }
}

export interface MangaVolumeGroup {
  number: number
  chapters: MangaChapter[]
  expected?: readonly string[]
  citation?: Citation
}

export function mangaVolumeGroups(manga: Manga | null, chapters: MangaChapter[]) {
  const url = manga?.url && URL.canParse(manga.url) ? new URL(manga.url) : null
  const catalog = url ? catalogs[`${manga?.sourceId}:${url.hostname}${url.pathname.replace(/\/$/, '')}`] ?? [] : []
  const volumes = new Map<number, MangaVolumeGroup>(catalog.map((entry) => [entry.number, {
    number: entry.number, expected: entry.chapters, citation: entry.citation, chapters: [],
  }]))
  const assignments = new Map(catalog.flatMap((entry) => entry.chapters.map((chapter) => [chapter, entry.number] as const)))
  const labelled = chapters.map((item) => ({ item, ...chapterLabels(item.name) }))
  const count = new Map<string, number>()
  for (const { chapter } of labelled) if (chapter !== null) count.set(chapter, (count.get(chapter) ?? 0) + 1)
  const unassigned: MangaChapter[] = []
  const order = new Map<string, number>()
  for (const { item, volume, chapter } of labelled) {
    const matched = chapter === null ? undefined : assignments.get(chapter)
    const groupNumber = volume ?? (chapter !== null && count.get(chapter) === 1 ? matched : undefined)
    const group = groupNumber ? volumes.get(groupNumber) : undefined
    if (!groupNumber || chapter === null || (matched !== undefined && matched !== groupNumber)
        || (group?.expected && !group.expected.includes(chapter))) {
      unassigned.push(item)
      continue
    }
    if (group) group.chapters.push(item)
    else volumes.set(groupNumber, { number: groupNumber, chapters: [item] })
    order.set(item.id, Number(chapter))
  }
  for (const group of volumes.values()) group.chapters.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  return { groups: [...volumes.values()].sort((a, b) => a.number - b.number), unassigned }
}
