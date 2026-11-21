import { readLimitedBody } from './komga-client.mjs'

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

export async function downloadBangumiCover(url, fetchImpl) {
  const response = await fetchImpl(url, {
    redirect: 'error', signal: AbortSignal.timeout(8000), headers: { accept: 'image/jpeg, image/png, image/webp' },
  })
  try {
    const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    const ext = extensions.get(mime)
    if (!response.ok || !ext) throw new Error('Bangumi did not return a supported cover image')
    const bytes = await readLimitedBody(response, 5 * 1024 * 1024, 'Bangumi')
    if (!bytes.length) throw new Error('Bangumi returned an empty cover image')
    return { image: new Blob([bytes], { type: mime }), filename: `bangumi.${ext}` }
  } catch (error) {
    void response.body?.cancel().catch(() => {})
    throw error
  }
}
