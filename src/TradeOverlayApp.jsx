import { useCallback, useEffect, useRef, useState } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'

const FFMPEG_CORE_BASE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm'
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024 // 100MB
const MAX_DURATION_SECONDS = 120 // ~2 minutes

const DIRECTIONS = ['Long', 'Short']
const TRADE_TYPES = ['Stock', 'Option']
const DURATION_UNITS = [
  { value: 's', label: 'sec' },
  { value: 'm', label: 'min' },
  { value: 'h', label: 'hr' },
]

function formatCurrency(amount) {
  const n = Number(amount)
  if (Number.isNaN(n)) return '$0.00'
  const sign = n > 0 ? '+' : n < 0 ? '-' : ''
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${sign}$${abs}`
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, radius)
    return
  }
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

const FONT = 'Inter, system-ui, -apple-system, sans-serif'

function withTextShadow(ctx, fn) {
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)'
  ctx.shadowBlur = 8
  ctx.shadowOffsetY = 1
  fn()
  ctx.restore()
}

function fillTextTracked(ctx, text, x, y, spacing) {
  let cursor = x
  for (const char of text) {
    ctx.fillText(char, cursor, y)
    cursor += ctx.measureText(char).width + spacing
  }
  return cursor - spacing
}

/**
 * Draws the trade overlay onto a canvas: symbol, a solid PnL pill, and plain
 * stat rows underneath, sitting on a soft gradient scrim for legibility.
 * Reused for both the live preview canvas and the full-resolution overlay
 * PNG fed to FFmpeg.
 */
function drawOverlay(ctx, canvasWidth, canvasHeight, trade) {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight)

  const isProfit = Number(trade.pnl) >= 0
  const accent = isProfit ? '#4ade80' : '#f87171'
  const pillBg = isProfit ? '#86efac' : '#fca5a5'
  const unit = Math.max(canvasWidth, canvasHeight) * 0.012

  const rows = [
    {
      label: trade.tradeType === 'Option' ? 'CONTRACTS' : 'SHARES',
      value: String(trade.contracts || 0),
    },
    { label: 'DURATION', value: trade.durationDisplay || '-' },
    { label: 'DIRECTION', value: trade.direction || '-', dot: true },
  ]
  if (trade.tradeType === 'Option') {
    rows.push({ label: 'STRIKE', value: trade.strike ? `$${trade.strike}` : '-' })
    rows.push({ label: 'EXPIRATION', value: trade.expiration || '-' })
  }

  const marginX = unit * 2.4
  const marginTop = unit * 2.6
  const symbolFont = Math.round(unit * 3.2)
  const pnlFont = Math.round(unit * 4.6)
  const labelFont = Math.round(unit * 1.15)
  const valueFont = Math.round(unit * 1.7)
  const rowGap = valueFont * 1.9
  const pillPaddingX = unit * 1.7
  const pillPaddingY = unit * 1.15
  const labelValueGap = unit * 0.5
  const valueColX = marginX + unit * 12

  // Soft gradient scrim behind the whole block so text stays legible on any footage.
  const scrimHeight =
    marginTop +
    symbolFont * 1.3 +
    pnlFont * 1.5 +
    rowGap * (rows.length + 0.6)
  const scrimWidth = Math.min(canvasWidth * 0.62, valueColX + unit * 20)
  const scrim = ctx.createLinearGradient(0, 0, 0, scrimHeight)
  scrim.addColorStop(0, 'rgba(0, 0, 0, 0.55)')
  scrim.addColorStop(1, 'rgba(0, 0, 0, 0)')
  const scrimH = ctx.createLinearGradient(0, 0, scrimWidth, 0)
  scrimH.addColorStop(0, 'rgba(0, 0, 0, 0.42)')
  scrimH.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.save()
  ctx.fillStyle = scrim
  ctx.fillRect(0, 0, canvasWidth, scrimHeight)
  ctx.globalCompositeOperation = 'multiply'
  ctx.fillStyle = scrimH
  ctx.fillRect(0, 0, scrimWidth, scrimHeight)
  ctx.restore()

  let cursorY = marginTop
  ctx.textBaseline = 'top'

  withTextShadow(ctx, () => {
    ctx.font = `800 ${symbolFont}px ${FONT}`
    ctx.fillStyle = '#ffffff'
    ctx.fillText(trade.symbol || 'SYMBOL', marginX, cursorY)
  })
  cursorY += symbolFont * 1.3

  ctx.font = `800 ${pnlFont}px ${FONT}`
  const arrow = isProfit ? '▲' : '▼'
  const pnlText = `${arrow} ${formatCurrency(trade.pnl)}`
  const pnlTextWidth = ctx.measureText(pnlText).width
  const pillWidth = pnlTextWidth + pillPaddingX * 2
  const pillHeight = pnlFont + pillPaddingY * 2

  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)'
  ctx.shadowBlur = 14
  ctx.shadowOffsetY = 4
  ctx.fillStyle = pillBg
  drawRoundedRect(ctx, marginX, cursorY, pillWidth, pillHeight, pillHeight * 0.22)
  ctx.fill()
  ctx.restore()

  ctx.fillStyle = isProfit ? '#052e16' : '#450a0a'
  ctx.fillText(pnlText, marginX + pillPaddingX, cursorY + pillPaddingY)
  cursorY += pillHeight + rowGap * 0.5

  for (const row of rows) {
    withTextShadow(ctx, () => {
      ctx.font = `700 ${labelFont}px ${FONT}`
      ctx.fillStyle = '#9ca3af'
      fillTextTracked(ctx, row.label, marginX, cursorY + (valueFont - labelFont) / 2 + unit * 0.15, unit * 0.16)

      let valueX = valueColX
      if (row.dot) {
        const dotR = valueFont * 0.16
        const dotY = cursorY + valueFont / 2
        ctx.beginPath()
        ctx.fillStyle = row.value === 'Short' ? '#f87171' : '#4ade80'
        ctx.arc(valueX + dotR, dotY, dotR, 0, Math.PI * 2)
        ctx.fill()
        valueX += dotR * 2 + unit * 0.7
      }

      ctx.font = `700 ${valueFont}px ${FONT}`
      ctx.fillStyle = '#ffffff'
      ctx.fillText(row.value, valueX, cursorY)
    })
    cursorY += rowGap
  }

  withTextShadow(ctx, () => {
    ctx.font = `700 ${Math.round(unit * 1.1)}px ${FONT}`
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)'
    ctx.textAlign = 'right'
    ctx.fillText('bruhtrade', canvasWidth - unit * 1.6, canvasHeight - unit * 2.4)
    ctx.textAlign = 'left'
  })
}

async function canvasToPngBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

function formatBytes(bytes) {
  if (!bytes) return '0 MB'
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function TradeOverlayApp() {
  const [symbol, setSymbol] = useState('AAPL')
  const [pnl, setPnl] = useState('250.00')
  const [direction, setDirection] = useState('Long')
  const [contracts, setContracts] = useState('1')
  const [tradeType, setTradeType] = useState('Stock')
  const [strike, setStrike] = useState('')
  const [expiration, setExpiration] = useState('')
  const [durationValue, setDurationValue] = useState('15')
  const [durationUnit, setDurationUnit] = useState('m')

  const [videoFile, setVideoFile] = useState(null)
  const [videoUrl, setVideoUrl] = useState(null)
  const [videoMeta, setVideoMeta] = useState(null) // { width, height, duration }
  const [fileError, setFileError] = useState('')

  const [ffmpegLoaded, setFfmpegLoaded] = useState(false)
  const [status, setStatus] = useState('idle') // idle | loading-engine | processing | done | error
  const [progress, setProgress] = useState(0)
  const [statusMessage, setStatusMessage] = useState('')
  const [outputUrl, setOutputUrl] = useState(null)

  const [fontsReady, setFontsReady] = useState(false)

  const videoRef = useRef(null)
  const previewCanvasRef = useRef(null)
  const ffmpegRef = useRef(null)

  const durationDisplay = `${durationValue || 0}${durationUnit}`

  const trade = {
    symbol: symbol.trim().toUpperCase(),
    pnl,
    direction,
    contracts,
    tradeType,
    strike,
    expiration,
    durationDisplay,
  }

  // Overlay text uses a self-hosted Inter font; canvas won't wait for it to
  // load on its own, so load the weights we draw with before the first paint.
  useEffect(() => {
    Promise.all([
      document.fonts.load('700 32px Inter'),
      document.fonts.load('800 32px Inter'),
    ]).then(() => setFontsReady(true))
  }, [])

  // Live preview: redraw overlay canvas whenever trade details or video metadata change.
  useEffect(() => {
    const canvas = previewCanvasRef.current
    if (!canvas || !videoMeta || !fontsReady) return
    canvas.width = videoMeta.width
    canvas.height = videoMeta.height
    const ctx = canvas.getContext('2d')
    drawOverlay(ctx, videoMeta.width, videoMeta.height, trade)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    symbol,
    pnl,
    direction,
    contracts,
    tradeType,
    strike,
    expiration,
    durationValue,
    durationUnit,
    videoMeta,
    fontsReady,
  ])

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl)
      if (outputUrl) URL.revokeObjectURL(outputUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleFileChange = useCallback((e) => {
    const file = e.target.files?.[0]
    if (!file) return

    setOutputUrl(null)
    setStatus('idle')
    setFileError('')

    if (file.size > MAX_FILE_SIZE_BYTES) {
      setFileError(
        `File is ${formatBytes(file.size)}, which exceeds the 100MB limit. Please upload a smaller clip.`,
      )
      setVideoFile(null)
      setVideoMeta(null)
      return
    }

    const url = URL.createObjectURL(file)
    setVideoFile(file)
    setVideoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return url
    })
  }, [])

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    const { videoWidth, videoHeight, duration } = video

    if (duration > MAX_DURATION_SECONDS) {
      setFileError(
        `Video is ${Math.round(duration)}s long, which exceeds the ~2 minute limit. Please upload a shorter clip.`,
      )
      setVideoMeta(null)
      return
    }

    setVideoMeta({ width: videoWidth, height: videoHeight, duration })
  }, [])

  const getFfmpeg = useCallback(async () => {
    if (ffmpegRef.current) return ffmpegRef.current

    const ffmpeg = new FFmpeg()
    ffmpeg.on('progress', ({ progress: p }) => {
      setProgress(Math.min(100, Math.round(p * 100)))
    })

    setStatus('loading-engine')
    setStatusMessage('Loading FFmpeg engine (first run only, ~30MB)...')

    const [coreURL, wasmURL] = await Promise.all([
      toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
    ])
    await ffmpeg.load({ coreURL, wasmURL })

    ffmpegRef.current = ffmpeg
    setFfmpegLoaded(true)
    return ffmpeg
  }, [])

  const handleGenerate = useCallback(async () => {
    if (!videoFile || !videoMeta) return

    try {
      setOutputUrl(null)
      setProgress(0)
      await document.fonts.ready
      const ffmpeg = await getFfmpeg()

      setStatus('processing')
      setStatusMessage('Rendering overlay...')

      const overlayCanvas = document.createElement('canvas')
      overlayCanvas.width = videoMeta.width
      overlayCanvas.height = videoMeta.height
      drawOverlay(overlayCanvas.getContext('2d'), videoMeta.width, videoMeta.height, trade)
      const overlayBlob = await canvasToPngBlob(overlayCanvas)

      setStatusMessage('Compositing overlay onto video (this can take a bit)...')

      const inputName = 'input' + (videoFile.name.match(/\.\w+$/)?.[0] || '.mp4')
      await ffmpeg.writeFile(inputName, await fetchFile(videoFile))
      await ffmpeg.writeFile('overlay.png', await fetchFile(overlayBlob))

      await ffmpeg.exec([
        '-i',
        inputName,
        '-i',
        'overlay.png',
        '-filter_complex',
        '[0:v][1:v]overlay=0:0:format=auto',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '23',
        '-c:a',
        'aac',
        'output.mp4',
      ])

      const data = await ffmpeg.readFile('output.mp4')
      const blob = new Blob([data.buffer], { type: 'video/mp4' })
      const url = URL.createObjectURL(blob)

      await ffmpeg.deleteFile(inputName)
      await ffmpeg.deleteFile('overlay.png')
      await ffmpeg.deleteFile('output.mp4')

      setOutputUrl(url)
      setStatus('done')
      setStatusMessage('Done! Your video is ready to download.')
    } catch (err) {
      console.error(err)
      setStatus('error')
      setStatusMessage(`Something went wrong while processing: ${err.message || err}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoFile, videoMeta, trade, getFfmpeg])

  const canGenerate =
    !!videoFile && !!videoMeta && !fileError && status !== 'loading-engine' && status !== 'processing'

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">
          bruh<span className="text-emerald-400">trade</span>
        </h1>
        <p className="text-sm text-gray-400">Overlay your trade stats onto your trading videos</p>
      </header>

      <main className="grid grid-cols-1 lg:grid-cols-2 gap-8 p-6 max-w-6xl mx-auto">
        {/* Left: form */}
        <section className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Symbol</label>
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="AAPL"
              className="w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-2 text-gray-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 uppercase"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">P&amp;L Amount ($)</label>
            <input
              type="number"
              step="0.01"
              value={pnl}
              onChange={(e) => setPnl(e.target.value)}
              placeholder="250.00 or -125.50"
              className="w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-2 text-gray-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Direction</label>
            <div className="flex gap-2">
              {DIRECTIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDirection(d)}
                  className={`flex-1 rounded-md px-3 py-2 font-medium border transition-colors ${
                    direction === d
                      ? d === 'Long'
                        ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400'
                        : 'bg-red-500/20 border-red-500 text-red-400'
                      : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1">Trade Type</label>
              <div className="flex gap-2">
                {TRADE_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTradeType(t)}
                    className={`flex-1 rounded-md px-3 py-2 font-medium border transition-colors ${
                      tradeType === t
                        ? 'bg-blue-500/20 border-blue-500 text-blue-400'
                        : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1">
                {tradeType === 'Option' ? 'Contracts' : 'Shares'}
              </label>
              <input
                type="number"
                min="0"
                value={contracts}
                onChange={(e) => setContracts(e.target.value)}
                className="w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-2 text-gray-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Duration</label>
            <div className="flex gap-2">
              <input
                type="number"
                min="0"
                value={durationValue}
                onChange={(e) => setDurationValue(e.target.value)}
                className="flex-1 rounded-md bg-gray-800 border border-gray-700 px-3 py-2 text-gray-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <select
                value={durationUnit}
                onChange={(e) => setDurationUnit(e.target.value)}
                className="rounded-md bg-gray-800 border border-gray-700 px-3 py-2 text-gray-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                {DURATION_UNITS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {tradeType === 'Option' && (
            <div className="grid grid-cols-2 gap-3 rounded-md border border-gray-800 bg-gray-800/40 p-3">
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">Strike ($)</label>
                <input
                  type="number"
                  step="0.5"
                  value={strike}
                  onChange={(e) => setStrike(e.target.value)}
                  placeholder="150"
                  className="w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-2 text-gray-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">Expiration</label>
                <input
                  type="date"
                  value={expiration}
                  onChange={(e) => setExpiration(e.target.value)}
                  className="w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-2 text-gray-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Trade Video</label>
            <input
              type="file"
              accept="video/*"
              onChange={handleFileChange}
              className="w-full text-sm text-gray-400 file:mr-4 file:rounded-md file:border-0 file:bg-emerald-600 file:px-4 file:py-2 file:text-white file:font-medium hover:file:bg-emerald-500 file:cursor-pointer cursor-pointer"
            />
            <p className="mt-1 text-xs text-gray-500">Max 100MB, ~2 minutes.</p>
            {fileError && <p className="mt-1 text-sm text-red-400">{fileError}</p>}
          </div>

          <button
            type="button"
            onClick={handleGenerate}
            disabled={!canGenerate}
            className="w-full rounded-md bg-emerald-600 px-4 py-3 font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-500"
          >
            {status === 'loading-engine' || status === 'processing'
              ? `Processing... ${progress}%`
              : 'Generate Video with Overlay'}
          </button>

          {statusMessage && (
            <p
              className={`text-sm ${
                status === 'error' ? 'text-red-400' : status === 'done' ? 'text-emerald-400' : 'text-gray-400'
              }`}
            >
              {statusMessage}
            </p>
          )}

          {outputUrl && (
            <a
              href={outputUrl}
              download={`bruhtrade-${trade.symbol || 'trade'}.mp4`}
              className="block w-full rounded-md border border-emerald-500 px-4 py-3 text-center font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/10"
            >
              Download Final Video
            </a>
          )}
        </section>

        {/* Right: preview */}
        <section className="space-y-3">
          <label className="block text-sm font-medium text-gray-400">Preview</label>
          <div className="relative overflow-hidden rounded-lg border border-gray-800 bg-black">
            {videoUrl ? (
              <>
                <video
                  ref={videoRef}
                  src={videoUrl}
                  controls
                  muted
                  playsInline
                  onLoadedMetadata={handleLoadedMetadata}
                  className="w-full"
                />
                <canvas
                  ref={previewCanvasRef}
                  className="pointer-events-none absolute inset-0 h-full w-full"
                />
              </>
            ) : (
              <div className="flex h-72 items-center justify-center text-gray-600">
                Upload a video to see the live overlay preview
              </div>
            )}
          </div>

          {status === 'processing' && (
            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-800">
              <div
                className="h-full bg-emerald-500 transition-all duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          {outputUrl && (
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1">Final Result</label>
              <video src={outputUrl} controls playsInline className="w-full rounded-lg border border-gray-800" />
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
