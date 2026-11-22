import { DatabaseSync } from 'node:sqlite'
import { chapterList } from './manga-volume-catalog.mjs'
import { MetadataError } from './bangumi-komga.mjs'

export function openTomeVolumes(filename, anchorIsbn, anchorVolume) {
  if (!filename) throw new MetadataError(503, 'OPENTOME_UNCONFIGURED', '尚未挂载 OpenTomeDB SQLite 目录。')
  let db
  try {
    db = new DatabaseSync(filename, { readOnly: true, enableDoubleQuotedStringLiterals: false })
    db.exec('PRAGMA trusted_schema=OFF')
    const lines = db.prepare(`SELECT DISTINCT s.gcd_series_id AS id, s.tome_id AS line, s.tome_work_id AS work
      FROM series s JOIN volumes v USING (gcd_series_id)
      WHERE s.medium = 'manga' AND s.is_omnibus = 0 AND v.isbn13 = ? AND v.volume_number = ? LIMIT 2`)
      .all(anchorIsbn, anchorVolume)
    if (lines.length !== 1) throw new MetadataError(409, 'OPENTOME_EDITION_UNCONFIRMED', 'ISBN 未唯一定位到同卷号的 OpenTomeDB 漫画版本。')
    const rows = db.prepare(`SELECT volume_number AS number, isbn13 AS isbn, volume_chapters AS chapters
      FROM volumes WHERE gcd_series_id = ? ORDER BY volume_number LIMIT 501`).all(lines[0].id)
    if (rows.length > 500) throw Error()
    return {
      line: lines[0].line,
      editions: rows.filter(({ number, isbn }) => Number.isInteger(number) && number > 0 && /^\d{13}$/.test(isbn ?? ''))
        .map(({ number, isbn }) => ({ number, isbn })),
      volumes: rows.flatMap((row) => {
        let chapters
        try { chapters = chapterList(JSON.parse(row.chapters)) } catch { return [] }
        if (!chapters.length || !Number.isInteger(row.number) || row.number < 1 || row.number > 9999) return []
        return [{ number: row.number, chapters, source: 'opentome', url: 'https://opentomedb.com/data/', confirmed: true }]
      }),
    }
  } catch (error) {
    if (error instanceof MetadataError) throw error
    throw new MetadataError(502, 'OPENTOME_UNAVAILABLE', 'OpenTomeDB 文件不可读或字段不兼容。')
  } finally { db?.close() }
}
