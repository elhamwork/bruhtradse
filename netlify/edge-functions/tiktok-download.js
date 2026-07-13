// Resolves a public TikTok link to a direct video file and streams it back
// through our own origin, so the browser never has to fight TikTok's CDN
// CORS restrictions. Uses the free, unofficial tikwm.com resolver — no API
// key, no cost. Personal-use only: for pulling down your own trade clips to
// re-upload here, not for bulk scraping.

const TIKWM_API = 'https://www.tikwm.com/api/'
const UA = 'Mozilla/5.0 (compatible; bruhtrade/1.0)'

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export default async (request) => {
  const reqUrl = new URL(request.url)
  const tiktokUrl = reqUrl.searchParams.get('url')

  if (!tiktokUrl) {
    return jsonError('Missing "url" query parameter.', 400)
  }

  let parsed
  try {
    parsed = new URL(tiktokUrl)
  } catch {
    return jsonError('That does not look like a valid URL.', 400)
  }
  if (!/(^|\.)tiktok\.com$/i.test(parsed.hostname)) {
    return jsonError('Only tiktok.com links are supported.', 400)
  }

  let resolved
  try {
    const apiRes = await fetch(`${TIKWM_API}?url=${encodeURIComponent(tiktokUrl)}&hd=1`, {
      headers: { 'User-Agent': UA },
    })
    if (!apiRes.ok) throw new Error(`resolver returned ${apiRes.status}`)
    resolved = await apiRes.json()
  } catch (err) {
    return jsonError(`Could not resolve that TikTok link: ${err.message}`, 502)
  }

  // Only hdplay/play are watermark-free; wmplay is deliberately excluded so we
  // never silently hand back a watermarked video.
  const videoUrl = resolved?.data?.hdplay || resolved?.data?.play
  if (!videoUrl) {
    return jsonError(
      'Could not find a watermark-free version of that video. It may be private, age-restricted, or the resolver is down.',
      502,
    )
  }

  let videoRes
  try {
    videoRes = await fetch(videoUrl, { headers: { 'User-Agent': UA } })
    if (!videoRes.ok || !videoRes.body) throw new Error(`video fetch returned ${videoRes.status}`)
  } catch (err) {
    return jsonError(`Could not download the video: ${err.message}`, 502)
  }

  return new Response(videoRes.body, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'inline; filename="tiktok-video.mp4"',
      'Cache-Control': 'no-store',
    },
  })
}

export const config = { path: '/api/tiktok-download' }
