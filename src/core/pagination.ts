export interface Page<T> {
  items: T[]
  total: number
  offset: number
  limit: number
  nextOffset: number | null
}

export function paginate<T>(items: T[], options: { offset?: number; limit?: number }): Page<T> {
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 20)))
  return {
    items: items.slice(offset, offset + limit), total: items.length, offset, limit,
    nextOffset: offset + limit < items.length ? offset + limit : null,
  }
}
