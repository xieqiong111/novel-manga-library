import { readLimitedBody } from './komga-client.mjs'

const maxCoverBytes = 5 * 1024 * 1024
const extensions = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'],
])

export function bangumiCoverUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return null
  try {
    const url = new URL(value)
    return url.origin === 'https://lain.bgm.tv' && !url.username && !url.password &&
      !url.hash && !url.search && /^\/pic\/cover\/[A-Za-z0-9_/-]+\.(?:jpe?g|png|webp)$/i.test(url.pathname)
      ? url.href : null
  } catch {
    return null
  }
}

function coverFile(bytes, mime) {
  const ext = extensions.get(mime)
  if (!ext || !bytes.length || bytes.length > maxCoverBytes) throw new Error('Bangumi cover is invalid')
  return { image: new Blob([bytes], { type: mime }), filename: `bangumi.${ext}` }
}

export function decodeBangumiCover({ data, mime } = {}) {
  if (typeof data !== 'string' || data.length > Math.ceil(maxCoverBytes / 3) * 4) {
    throw new Error('Bangumi cover payload exceeded size limit')
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data) throw new Error('Bangumi cover encoding is invalid')
  return coverFile(bytes, mime)
}

export async function downloadBangumiCover(url, fetchImpl) {
  const response = await fetchImpl(url, {
    redirect: 'error', signal: AbortSignal.timeout(8000), headers: { accept: 'image/jpeg, image/png, image/webp' },
  })
  try {
    const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (!response.ok || !extensions.has(mime)) throw new Error('Bangumi did not return a supported cover image')
    return coverFile(await readLimitedBody(response, maxCoverBytes, 'Bangumi'), mime)
  } catch (error) {
    void response.body?.cancel().catch(() => {})
    throw error
  }
}
