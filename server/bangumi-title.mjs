import { Converter } from 'opencc-js'

const simplify = Converter({ from: 't', to: 'cn' })
const traditional = Converter({ from: 'cn', to: 'tw' })
export const bangumiTitleKey = (title) => simplify(title.normalize('NFKC')).toLowerCase().trim()
  .replace(/\s+/gu, ' ').replace(/ *([\p{P}\p{S}]) */gu, '$1')
export const sameBangumiTitle = (left, right) => Boolean(left && right && bangumiTitleKey(left) === bangumiTitleKey(right))
export const traditionalBangumiTitle = (title) => traditional(title)
