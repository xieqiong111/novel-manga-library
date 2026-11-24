import { Button } from './ui'

export function PageControls({ label, offset, total, nextOffset, onChange }: {
  label: string
  offset: number
  total: number
  nextOffset: number | null
  onChange: (offset: number) => void
}) {
  if (offset === 0 && nextOffset === null) return null
  return (
    <nav aria-label={label} className="my-4 flex flex-wrap items-center justify-center gap-3 text-xs text-ink-soft">
      <Button size="sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - 40))}>上一页</Button>
      <span>{label} · 第 {Math.floor(offset / 40) + 1} 页 · 共 {total} 项</span>
      <Button size="sm" disabled={nextOffset === null} onClick={() => nextOffset !== null && onChange(nextOffset)}>下一页</Button>
    </nav>
  )
}
