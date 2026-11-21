export const defaultScrapeOptions = Object.freeze({
  minimumScore: 0,
  libraries: Object.freeze([]),
  sortTitle: false,
  addLocalVersion: false,
  seriesCover: false,
  bookCover: false,
})

export function parseScrapeOptions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const { minimumScore, libraries, sortTitle, addLocalVersion, seriesCover, bookCover } = input
  if (!Number.isInteger(minimumScore) || minimumScore < 0 || minimumScore > 100 ||
      ![sortTitle, addLocalVersion, seriesCover, bookCover].every((value) => typeof value === 'boolean') ||
      !Array.isArray(libraries) || libraries.length > 100) return null
  const seen = new Set()
  const rules = []
  for (const rule of libraries) {
    if (typeof rule?.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(rule.id) ||
        !['all', 'novel', 'manga'].includes(rule.kind) || seen.has(rule.id)) return null
    seen.add(rule.id)
    rules.push({ id: rule.id, kind: rule.kind })
  }
  rules.sort((a, b) => a.id.localeCompare(b.id))
  return { minimumScore, libraries: rules, sortTitle, addLocalVersion, seriesCover, bookCover }
}
