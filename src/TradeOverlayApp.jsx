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

const OVERLAY_STYLES = ['Minimal', 'Card', 'Bold', 'Ticker']
const ORIENTATIONS = ['Auto', 'Landscape', 'Portrait']

function buildStatRows(trade) {
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
    if (trade.entryCredit !== '' && trade.entryCredit != null) {
      rows.push({ label: 'ENTRY', value: formatCurrency(trade.entryCredit) })
    }
    if (trade.exitCredit !== '' && trade.exitCredit != null) {
      rows.push({ label: 'EXIT', value: formatCurrency(trade.exitCredit) })
    }
    rows.push({ label: 'EXPIRATION', value: trade.expiration || '-' })
  }
  return rows
}

function drawScrim(ctx, canvasWidth, scrimHeight, scrimWidth) {
  const vScrim = ctx.createLinearGradient(0, 0, 0, scrimHeight)
  vScrim.addColorStop(0, 'rgba(0, 0, 0, 0.55)')
  vScrim.addColorStop(1, 'rgba(0, 0, 0, 0)')
  const hScrim = ctx.createLinearGradient(0, 0, scrimWidth, 0)
  hScrim.addColorStop(0, 'rgba(0, 0, 0, 0.42)')
  hScrim.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.save()
  ctx.fillStyle = vScrim
  ctx.fillRect(0, 0, canvasWidth, scrimHeight)
  ctx.globalCompositeOperation = 'multiply'
  ctx.fillStyle = hScrim
  ctx.fillRect(0, 0, scrimWidth, scrimHeight)
  ctx.restore()
}

// Gradient-filled pill with a colored glow and a soft glossy highlight, used
// for the PnL callout across styles.
function drawPill(ctx, x, y, width, height, colorFrom, colorTo, glowColor, radius) {
  const r = radius ?? height * 0.24
  ctx.save()
  ctx.shadowColor = glowColor
  ctx.shadowBlur = height * 0.55
  ctx.shadowOffsetY = height * 0.1
  const grad = ctx.createLinearGradient(x, y, x, y + height)
  grad.addColorStop(0, colorFrom)
  grad.addColorStop(1, colorTo)
  ctx.fillStyle = grad
  drawRoundedRect(ctx, x, y, width, height, r)
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.globalAlpha = 0.22
  ctx.fillStyle = '#ffffff'
  drawRoundedRect(ctx, x + width * 0.04, y + height * 0.08, width * 0.92, height * 0.3, height * 0.15)
  ctx.fill()
  ctx.restore()
}

// Circular badge with an up/down triangle glyph, replacing a plain dot.
function drawDirectionBadge(ctx, x, y, r, direction) {
  const isShort = direction === 'Short'
  const bg = isShort ? '#f87171' : '#4ade80'
  const fg = isShort ? '#450a0a' : '#052e16'
  ctx.save()
  ctx.fillStyle = bg
  ctx.beginPath()
  ctx.arc(x + r, y, r, 0, Math.PI * 2)
  ctx.fill()

  const t = r * 0.85
  ctx.fillStyle = fg
  ctx.beginPath()
  if (isShort) {
    ctx.moveTo(x + r - t * 0.55, y - t * 0.3)
    ctx.lineTo(x + r + t * 0.55, y - t * 0.3)
    ctx.lineTo(x + r, y + t * 0.5)
  } else {
    ctx.moveTo(x + r - t * 0.55, y + t * 0.3)
    ctx.lineTo(x + r + t * 0.55, y + t * 0.3)
    ctx.lineTo(x + r, y - t * 0.5)
  }
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function drawGlow(ctx, x, y, radius, color) {
  const grad = ctx.createRadialGradient(x, y, 0, x, y, radius)
  grad.addColorStop(0, color)
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.save()
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function measureChip(ctx, row, font, paddingX) {
  ctx.font = font
  const text = `${row.label} ${row.value}`
  return { text, width: ctx.measureText(text).width + paddingX * 2 }
}

function layoutChips(ctx, rows, font, maxWidth, paddingX, gap) {
  const chips = rows.map((r) => measureChip(ctx, r, font, paddingX))
  const lines = []
  let current = []
  let currentWidth = 0
  for (const chip of chips) {
    const added = chip.width + (current.length ? gap : 0)
    if (current.length && currentWidth + added > maxWidth) {
      lines.push(current)
      current = [chip]
      currentWidth = chip.width
    } else {
      current.push(chip)
      currentWidth += added
    }
  }
  if (current.length) lines.push(current)
  return lines
}

function drawChipLine(ctx, chips, x, y, height, gap, textColor, bgColor, font, paddingX, align = 'left') {
  const totalWidth = chips.reduce((sum, c) => sum + c.width, 0) + gap * (chips.length - 1)
  let cursorX = align === 'center' ? x - totalWidth / 2 : x
  for (const chip of chips) {
    ctx.save()
    ctx.fillStyle = bgColor
    drawRoundedRect(ctx, cursorX, y, chip.width, height, height / 2)
    ctx.fill()
    ctx.restore()

    ctx.font = font
    ctx.fillStyle = textColor
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(chip.text, cursorX + paddingX, y + height / 2 + 1)
    cursorX += chip.width + gap
  }
  ctx.textBaseline = 'top'
}

function drawWatermark(ctx, canvasWidth, canvasHeight, unit, align = 'right') {
  withTextShadow(ctx, () => {
    ctx.font = `700 ${Math.round(unit * 1.1)}px ${FONT}`
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)'
    ctx.textAlign = align
    const x = align === 'right' ? canvasWidth - unit * 1.6 : canvasWidth / 2
    ctx.fillText('bruhtrade', x, canvasHeight - unit * 2.4)
    ctx.textAlign = 'left'
  })
}

// "Minimal": accent-marked symbol + glowing gradient PnL pill, top-left,
// tracked stat rows with direction badges below.
function drawMinimalStyle(ctx, canvasWidth, canvasHeight, trade, ctxInfo) {
  const { isPortrait, isProfit, accent, pillFrom, pillTo, glow, unit, rows } = ctxInfo

  const marginX = unit * 2.4
  const marginTop = unit * 2.6
  const symbolFont = Math.round(unit * 3.2)
  const pnlFont = Math.round(unit * 4.6)
  const labelFont = Math.round(unit * 1.15)
  const valueFont = Math.round(unit * 1.7)
  const rowGap = valueFont * 1.9
  const pillPaddingX = unit * 1.7
  const pillPaddingY = unit * 1.15
  const valueColX = marginX + unit * (isPortrait ? 8.6 : 12)
  const markW = unit * 0.55

  const scrimHeight = marginTop + symbolFont * 1.3 + pnlFont * 1.5 + rowGap * (rows.length + 0.6)
  const scrimWidth = Math.min(canvasWidth * (isPortrait ? 0.92 : 0.62), valueColX + unit * (isPortrait ? 13 : 20))
  drawScrim(ctx, canvasWidth, scrimHeight, scrimWidth)

  let cursorY = marginTop
  ctx.textBaseline = 'top'

  ctx.save()
  ctx.fillStyle = accent
  ctx.shadowColor = accent
  ctx.shadowBlur = unit * 1.2
  drawRoundedRect(ctx, marginX, cursorY + symbolFont * 0.18, markW, symbolFont * 0.66, unit * 0.16)
  ctx.fill()
  ctx.restore()

  withTextShadow(ctx, () => {
    ctx.font = `800 ${symbolFont}px ${FONT}`
    ctx.fillStyle = '#ffffff'
    ctx.fillText(trade.symbol || 'SYMBOL', marginX + markW + unit * 0.9, cursorY)
  })
  cursorY += symbolFont * 1.3

  ctx.font = `800 ${pnlFont}px ${FONT}`
  const arrow = isProfit ? '▲' : '▼'
  const pnlText = `${arrow} ${formatCurrency(trade.pnl)}`
  const pnlTextWidth = ctx.measureText(pnlText).width
  const pillWidth = pnlTextWidth + pillPaddingX * 2
  const pillHeight = pnlFont + pillPaddingY * 2

  drawPill(ctx, marginX, cursorY, pillWidth, pillHeight, pillFrom, pillTo, glow)
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
        const dotR = valueFont * 0.18
        drawDirectionBadge(ctx, valueX, cursorY + valueFont / 2, dotR, row.value)
        valueX += dotR * 2 + unit * 0.7
      }

      ctx.font = `700 ${valueFont}px ${FONT}`
      ctx.fillStyle = '#ffffff'
      ctx.fillText(row.value, valueX, cursorY)
    })
    cursorY += rowGap
  }

  drawWatermark(ctx, canvasWidth, canvasHeight, unit)
}

// "Card": a glass-look panel with a glowing accent edge, gradient PnL text,
// and a stat grid. Sits at the bottom for landscape (lower-third style) and
// up top for portrait, since the bottom of vertical clips is usually
// covered by captions/UI.
function drawCardStyle(ctx, canvasWidth, canvasHeight, trade, ctxInfo) {
  const { isPortrait, isProfit, accent, unit, rows } = ctxInfo

  const padding = unit * 2.2
  const symbolFont = Math.round(unit * 2.4)
  const pnlFont = Math.round(unit * 3.4)
  const labelFont = Math.round(unit * 1.05)
  const valueFont = Math.round(unit * 1.5)
  const rowGap = (labelFont + valueFont) * 1.3

  // Two columns once there are enough rows (e.g. options with entry/exit
  // credit) that a single column would stretch the panel too tall.
  const cols = isPortrait || rows.length > 4 ? 2 : 1
  const rowsPerCol = Math.ceil(rows.length / cols)
  const cardWidth = isPortrait
    ? canvasWidth * 0.9
    : Math.min(canvasWidth * (cols === 2 ? 0.6 : 0.46), unit * (cols === 2 ? 70 : 54))
  const colWidth = (cardWidth - padding * 2) / cols
  const headerHeight = symbolFont * 1.25 + unit * 0.7 + pnlFont * 1.3 + unit * 1.2
  const cardHeight = padding * 2 + headerHeight + rowsPerCol * rowGap

  const cardX = isPortrait ? (canvasWidth - cardWidth) / 2 : unit * 2.2
  const cardY = isPortrait ? unit * 2.4 : canvasHeight - cardHeight - unit * 2.4

  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
  ctx.shadowBlur = 24
  ctx.shadowOffsetY = 6
  const panelGrad = ctx.createLinearGradient(cardX, cardY, cardX, cardY + cardHeight)
  panelGrad.addColorStop(0, 'rgba(26, 28, 35, 0.8)')
  panelGrad.addColorStop(1, 'rgba(8, 9, 12, 0.8)')
  ctx.fillStyle = panelGrad
  drawRoundedRect(ctx, cardX, cardY, cardWidth, cardHeight, unit * 1.6)
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.strokeStyle = `${accent}55`
  ctx.lineWidth = Math.max(1, unit * 0.09)
  drawRoundedRect(ctx, cardX + 0.5, cardY + 0.5, cardWidth - 1, cardHeight - 1, unit * 1.6)
  ctx.stroke()
  ctx.restore()

  ctx.save()
  ctx.shadowColor = accent
  ctx.shadowBlur = unit * 2
  ctx.fillStyle = accent
  drawRoundedRect(ctx, cardX, cardY, unit * 0.5, cardHeight, unit * 0.25)
  ctx.fill()
  ctx.restore()

  let cursorY = cardY + padding
  const textX = cardX + padding
  ctx.textBaseline = 'top'

  ctx.font = `800 ${symbolFont}px ${FONT}`
  ctx.fillStyle = '#ffffff'
  ctx.fillText(trade.symbol || 'SYMBOL', textX, cursorY)
  cursorY += symbolFont * 1.25 + unit * 0.7

  ctx.font = `800 ${pnlFont}px ${FONT}`
  const arrow = isProfit ? '▲' : '▼'
  const pnlText = `${arrow} ${formatCurrency(trade.pnl)}`
  const pnlGrad = ctx.createLinearGradient(textX, 0, textX + ctx.measureText(pnlText).width, 0)
  pnlGrad.addColorStop(0, isProfit ? '#4ade80' : '#f87171')
  pnlGrad.addColorStop(1, isProfit ? '#a7f3d0' : '#fecaca')
  ctx.fillStyle = pnlGrad
  ctx.fillText(pnlText, textX, cursorY)
  cursorY += pnlFont * 1.3 + unit * 1.2

  const gridTop = cursorY
  rows.forEach((row, i) => {
    const col = Math.floor(i / rowsPerCol)
    const rowInCol = i % rowsPerCol
    const x = textX + col * colWidth
    const labelY = gridTop + rowInCol * rowGap
    const valueY = labelY + labelFont * 1.35

    ctx.font = `700 ${labelFont}px ${FONT}`
    ctx.fillStyle = '#9ca3af'
    fillTextTracked(ctx, row.label, x, labelY, unit * 0.14)

    let valueX = x
    if (row.dot) {
      const dotR = valueFont * 0.15
      drawDirectionBadge(ctx, valueX, valueY + valueFont / 2, dotR, row.value)
      valueX += dotR * 2 + unit * 0.6
    }
    ctx.font = `700 ${valueFont}px ${FONT}`
    ctx.fillStyle = '#ffffff'
    ctx.fillText(row.value, valueX, valueY)
  })

  drawWatermark(ctx, canvasWidth, canvasHeight, unit)
}

// "Bold": big centered statement — symbol, huge glowing PnL, stat chips
// below. Anchored near the top for portrait so it reads well on vertical
// clips without competing with bottom-of-screen captions/UI.
function drawBoldStyle(ctx, canvasWidth, canvasHeight, trade, ctxInfo) {
  const { isPortrait, isProfit, accent, unit, rows } = ctxInfo

  const symbolFont = Math.round(unit * (isPortrait ? 2.6 : 2.4))
  const pnlFont = Math.round(unit * (isPortrait ? 6.4 : 5.6))
  const chipFont = Math.round(unit * 1.3)
  const chipPaddingX = unit * 1.1
  const chipGap = unit * 0.7
  const chipHeight = chipFont * 2.1
  const centerX = canvasWidth / 2
  const maxWidth = canvasWidth * 0.9

  const chipLines = layoutChips(ctx, rows, `700 ${chipFont}px ${FONT}`, maxWidth, chipPaddingX, chipGap)

  const blockHeight =
    symbolFont * 1.4 + pnlFont * 1.3 + chipLines.length * (chipHeight + unit * 0.6) + unit * 2
  const anchorY = isPortrait ? unit * 3.2 : canvasHeight / 2 - blockHeight / 2

  const scrimHeight = anchorY + blockHeight + unit * 2
  ctx.save()
  const scrim = ctx.createLinearGradient(0, 0, 0, scrimHeight)
  scrim.addColorStop(0, 'rgba(0, 0, 0, 0.5)')
  scrim.addColorStop(1, 'rgba(0, 0, 0, 0.05)')
  ctx.fillStyle = scrim
  ctx.fillRect(0, Math.max(0, anchorY - unit * 2), canvasWidth, scrimHeight)
  ctx.restore()

  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  let cursorY = anchorY

  withTextShadow(ctx, () => {
    ctx.font = `800 ${symbolFont}px ${FONT}`
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.fillText((trade.symbol || 'SYMBOL').toUpperCase(), centerX, cursorY)
  })
  cursorY += symbolFont * 1.4

  drawGlow(
    ctx,
    centerX,
    cursorY + pnlFont * 0.5,
    pnlFont * 1.7,
    isProfit ? 'rgba(74, 222, 128, 0.32)' : 'rgba(248, 113, 113, 0.32)',
  )
  withTextShadow(ctx, () => {
    ctx.font = `800 ${pnlFont}px ${FONT}`
    ctx.fillStyle = accent
    const arrow = isProfit ? '▲' : '▼'
    ctx.fillText(`${arrow} ${formatCurrency(trade.pnl)}`, centerX, cursorY)
  })
  cursorY += pnlFont * 1.3

  for (const line of chipLines) {
    drawChipLine(
      ctx,
      line,
      centerX,
      cursorY,
      chipHeight,
      chipGap,
      '#f3f4f6',
      'rgba(255, 255, 255, 0.14)',
      `700 ${chipFont}px ${FONT}`,
      chipPaddingX,
      'center',
    )
    cursorY += chipHeight + unit * 0.6
  }

  ctx.textAlign = 'left'
  drawWatermark(ctx, canvasWidth, canvasHeight, unit, isPortrait ? 'center' : 'right')
}

// "Ticker": broadcast-style full-width bar — direction badge, symbol, PnL,
// and stat chips inline. Sits at the very bottom for landscape (classic
// lower-third) and up top for portrait, clear of captions/UI.
function drawTickerStyle(ctx, canvasWidth, canvasHeight, trade, ctxInfo) {
  const { isPortrait, isProfit, accent, unit, rows } = ctxInfo

  const padX = unit * 2.4
  const padY = unit * 1.5
  const symbolFont = Math.round(unit * 2.1)
  const pnlFont = Math.round(unit * 2.5)
  const chipFont = Math.round(unit * 1.25)
  const chipPaddingX = unit * 1.05
  const chipGap = unit * 0.7
  const chipHeight = chipFont * 2.1
  const headerHeight = Math.max(symbolFont, pnlFont) * 1.3

  const maxWidth = canvasWidth - padX * 2
  const chipLines = layoutChips(ctx, rows, `700 ${chipFont}px ${FONT}`, maxWidth, chipPaddingX, chipGap)

  const barHeight = padY * 2 + headerHeight + unit * 0.7 + chipLines.length * (chipHeight + unit * 0.45)
  const barY = isPortrait ? unit * 2 : canvasHeight - barHeight

  ctx.save()
  const barGrad = ctx.createLinearGradient(0, barY, 0, barY + barHeight)
  barGrad.addColorStop(0, 'rgba(9, 10, 14, 0.55)')
  barGrad.addColorStop(0.2, 'rgba(7, 8, 11, 0.85)')
  barGrad.addColorStop(1, 'rgba(4, 5, 7, 0.92)')
  ctx.fillStyle = barGrad
  ctx.fillRect(0, barY, canvasWidth, barHeight)
  ctx.restore()

  ctx.save()
  ctx.shadowColor = accent
  ctx.shadowBlur = unit * 1.6
  ctx.fillStyle = accent
  ctx.fillRect(0, barY, canvasWidth, unit * 0.22)
  ctx.restore()

  let cursorY = barY + padY
  let cursorX = padX
  ctx.textBaseline = 'middle'
  const headerMidY = cursorY + headerHeight / 2

  const badgeR = headerHeight * 0.3
  drawDirectionBadge(ctx, cursorX, headerMidY, badgeR, trade.direction)
  cursorX += badgeR * 2 + unit * 1

  withTextShadow(ctx, () => {
    ctx.font = `800 ${symbolFont}px ${FONT}`
    ctx.fillStyle = '#ffffff'
    ctx.fillText(trade.symbol || 'SYMBOL', cursorX, headerMidY)
  })
  cursorX += ctx.measureText(trade.symbol || 'SYMBOL').width + unit * 1.6

  withTextShadow(ctx, () => {
    ctx.font = `800 ${pnlFont}px ${FONT}`
    ctx.fillStyle = accent
    const arrow = isProfit ? '▲' : '▼'
    ctx.fillText(`${arrow} ${formatCurrency(trade.pnl)}`, cursorX, headerMidY)
  })

  cursorY += headerHeight + unit * 0.7
  ctx.textBaseline = 'top'

  for (const line of chipLines) {
    drawChipLine(
      ctx,
      line,
      padX,
      cursorY,
      chipHeight,
      chipGap,
      '#e5e7eb',
      'rgba(255, 255, 255, 0.12)',
      `700 ${chipFont}px ${FONT}`,
      chipPaddingX,
      'left',
    )
    cursorY += chipHeight + unit * 0.45
  }

  drawWatermark(ctx, canvasWidth, canvasHeight, unit, 'right')
}

/**
 * Draws the trade overlay onto a canvas in one of several selectable
 * styles, adapting position/scale to the video's orientation. Reused for
 * both the live preview canvas and the full-resolution overlay PNG fed to
 * FFmpeg. `orientation` lets the caller override the auto-detected
 * landscape/portrait layout for videos whose framing doesn't match their
 * raw pixel dimensions (e.g. a horizontally-shot TikTok clip you still
 * want laid out as portrait, or vice versa).
 */
function drawOverlay(ctx, canvasWidth, canvasHeight, trade, style = 'Minimal', orientation = 'Auto') {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight)

  const isPortrait =
    orientation === 'Portrait'
      ? true
      : orientation === 'Landscape'
        ? false
        : canvasHeight > canvasWidth
  const isProfit = Number(trade.pnl) >= 0
  const accent = isProfit ? '#4ade80' : '#f87171'
  const pillFrom = isProfit ? '#bbf7d0' : '#fecaca'
  const pillTo = isProfit ? '#4ade80' : '#f87171'
  const glow = isProfit ? 'rgba(74, 222, 128, 0.55)' : 'rgba(248, 113, 113, 0.55)'
  // Scale off the constraining dimension so text stays proportionate in
  // both landscape (16:9-ish) and portrait (9:16-ish, e.g. TikTok) video.
  const unit = Math.min(canvasWidth, canvasHeight) * 0.02
  const rows = buildStatRows(trade)

  const ctxInfo = { isPortrait, isProfit, accent, pillFrom, pillTo, glow, unit, rows }

  if (style === 'Card') drawCardStyle(ctx, canvasWidth, canvasHeight, trade, ctxInfo)
  else if (style === 'Bold') drawBoldStyle(ctx, canvasWidth, canvasHeight, trade, ctxInfo)
  else if (style === 'Ticker') drawTickerStyle(ctx, canvasWidth, canvasHeight, trade, ctxInfo)
  else drawMinimalStyle(ctx, canvasWidth, canvasHeight, trade, ctxInfo)
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
  const [entryCredit, setEntryCredit] = useState('')
  const [exitCredit, setExitCredit] = useState('')
  const [durationValue, setDurationValue] = useState('15')
  const [durationUnit, setDurationUnit] = useState('m')
  const [overlayStyle, setOverlayStyle] = useState('Minimal')
  const [overlayOrientation, setOverlayOrientation] = useState('Auto')

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
    entryCredit,
    exitCredit,
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
    drawOverlay(ctx, videoMeta.width, videoMeta.height, trade, overlayStyle, overlayOrientation)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    symbol,
    pnl,
    direction,
    contracts,
    tradeType,
    strike,
    expiration,
    entryCredit,
    exitCredit,
    durationValue,
    durationUnit,
    videoMeta,
    fontsReady,
    overlayStyle,
    overlayOrientation,
  ])

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl)
      if (outputUrl) URL.revokeObjectURL(outputUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyVideoFile = useCallback((file) => {
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

  const handleFileChange = useCallback(
    (e) => {
      const file = e.target.files?.[0]
      if (!file) return
      applyVideoFile(file)
    },
    [applyVideoFile],
  )

  const [tiktokUrl, setTiktokUrl] = useState('')
  const [tiktokLoading, setTiktokLoading] = useState(false)

  const handleTiktokFetch = useCallback(async () => {
    const trimmed = tiktokUrl.trim()
    if (!trimmed) return

    setTiktokLoading(true)
    setFileError('')
    try {
      const res = await fetch(`/api/tiktok-download?url=${encodeURIComponent(trimmed)}`)
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error || `Request failed (${res.status})`)
      }
      const blob = await res.blob()
      const file = new File([blob], 'tiktok-video.mp4', { type: 'video/mp4' })
      applyVideoFile(file)
    } catch (err) {
      setFileError(`Couldn't fetch that TikTok video: ${err.message}`)
    } finally {
      setTiktokLoading(false)
    }
  }, [tiktokUrl, applyVideoFile])

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
      drawOverlay(overlayCanvas.getContext('2d'), videoMeta.width, videoMeta.height, trade, overlayStyle, overlayOrientation)
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
  }, [videoFile, videoMeta, trade, overlayStyle, overlayOrientation, getFfmpeg])

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
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">Entry Credit ($)</label>
                <input
                  type="number"
                  step="0.01"
                  value={entryCredit}
                  onChange={(e) => setEntryCredit(e.target.value)}
                  placeholder="e.g. 1.20 received"
                  className="w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-2 text-gray-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">Exit Credit ($)</label>
                <input
                  type="number"
                  step="0.01"
                  value={exitCredit}
                  onChange={(e) => setExitCredit(e.target.value)}
                  placeholder="e.g. -0.40 paid"
                  className="w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-2 text-gray-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <p className="col-span-2 text-xs text-gray-500">
                Optional. Shown on the overlay as premium received/paid at open (Entry) and close (Exit) —
                use negative numbers for debits.
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Overlay Style</label>
            <div className="flex gap-2">
              {OVERLAY_STYLES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setOverlayStyle(s)}
                  className={`flex-1 rounded-md px-3 py-2 font-medium border transition-colors ${
                    overlayStyle === s
                      ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400'
                      : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Layout Orientation</label>
            <div className="flex gap-2">
              {ORIENTATIONS.map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => setOverlayOrientation(o)}
                  className={`flex-1 rounded-md px-3 py-2 font-medium border transition-colors ${
                    overlayOrientation === o
                      ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400'
                      : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'
                  }`}
                >
                  {o}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Auto detects from the video's pixel dimensions. Override it if a clip is shot
              horizontally/vertically but you want the other layout.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Trade Video</label>
            <input
              type="file"
              accept="video/*"
              onChange={handleFileChange}
              className="w-full text-sm text-gray-400 file:mr-4 file:rounded-md file:border-0 file:bg-emerald-600 file:px-4 file:py-2 file:text-white file:font-medium hover:file:bg-emerald-500 file:cursor-pointer cursor-pointer"
            />
            <p className="mt-1 text-xs text-gray-500">Max 100MB, ~2 minutes.</p>

            <div className="mt-3 flex gap-2">
              <input
                type="url"
                value={tiktokUrl}
                onChange={(e) => setTiktokUrl(e.target.value)}
                placeholder="Or paste a TikTok video link..."
                className="flex-1 rounded-md bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <button
                type="button"
                onClick={handleTiktokFetch}
                disabled={!tiktokUrl.trim() || tiktokLoading}
                className="rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm font-medium text-gray-200 transition-colors hover:border-gray-600 disabled:cursor-not-allowed disabled:text-gray-600"
              >
                {tiktokLoading ? 'Fetching...' : 'Fetch'}
              </button>
            </div>

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
