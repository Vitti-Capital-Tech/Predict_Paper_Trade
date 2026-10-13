import { useEffect, useRef } from 'react'

/**
 * A live-feeling market chart for the sign-in screen — what Predict is, at a
 * glance (BTC/ETH up-down trading), without shipping a video.
 *
 * It is a canvas drawing a synthetic BTC tape, but with enough market texture
 * to read as real: momentum that persists, volatility that clusters (calm
 * stretches and bursts), candles that auto-scale to fill the panel, a gradient
 * area fill, and a current-price tag with a pulsing marker on the right. Pauses
 * when the tab is hidden (rAF) and under prefers-reduced-motion.
 */
export default function SignInVisual() {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const CANDLE_W = 6
    const GAP = 4
    const step = CANDLE_W + GAP
    const PAD_Y = 26
    const RIGHT = 6

    let w = 0
    let h = 0
    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = Math.max(1, Math.round(w * dpr))
      canvas.height = Math.max(1, Math.round(h * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    // ---- synthetic market ---------------------------------------------------
    let price = 67000 + Math.random() * 1200
    let vol = 70          // current volatility regime, in dollars
    let momentum = 0      // persistent drift
    const BAND_LO = 61000
    const BAND_HI = 73000

    const makeCandle = () => {
      // Volatility clusters: it drifts, and now and then a burst arrives.
      vol += (Math.random() - 0.5) * 22
      vol = Math.max(28, Math.min(260, vol))
      if (Math.random() < 0.035) vol = Math.min(340, vol + 150)

      // Momentum persists (trends) but decays toward zero (mean reversion).
      momentum = momentum * 0.8 + (Math.random() - 0.5) * vol * 1.15

      const o = price
      let c = o + momentum + (Math.random() - 0.5) * vol * 0.6
      // Soft walls so the tape never wanders off the band forever.
      if (c > BAND_HI) { c = BAND_HI - Math.random() * 300; momentum = -Math.abs(momentum) }
      if (c < BAND_LO) { c = BAND_LO + Math.random() * 300; momentum = Math.abs(momentum) }
      const hi = Math.max(o, c) + Math.random() * vol * 0.9
      const lo = Math.min(o, c) - Math.random() * vol * 0.9
      price = c
      return { o, h: hi, l: lo, c }
    }

    const BUFFER = Math.ceil((w || 900) / step) + 6
    const candles = Array.from({ length: BUFFER }, makeCandle)

    // Smoothly-tracked vertical view bounds, so the chart rescales to fill the
    // panel as it moves instead of sitting in a flat band.
    let viewLo = null
    let viewHi = null

    let offset = 0
    const SPEED = 0.45
    let raf = 0
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches

    // newest candle is j = 0, anchored near the right edge
    const xOf = (j) => w - RIGHT - CANDLE_W / 2 - j * step - offset

    const fmt = (p) => '$' + Math.round(p).toLocaleString('en-US')

    const draw = (t) => {
      ctx.clearRect(0, 0, w, h)
      const N = candles.length

      // Keep enough candles to fill the width after a resize.
      const need = Math.ceil(w / step) + 6
      while (candles.length < need) candles.unshift(makeCandle())

      // Which candles are on screen, and the price range they span.
      let lo = Infinity
      let hi = -Infinity
      for (let j = 0; j < candles.length; j += 1) {
        const x = xOf(j)
        if (x < -step || x > w + step) continue
        const k = candles[N - 1 - j]
        if (!k) continue
        if (k.l < lo) lo = k.l
        if (k.h > hi) hi = k.h
      }
      if (!isFinite(lo) || !isFinite(hi)) { raf = requestAnimationFrame(draw); return }
      const pad = (hi - lo) * 0.12 || 50
      const targetLo = lo - pad
      const targetHi = hi + pad
      viewLo = viewLo == null ? targetLo : viewLo + (targetLo - viewLo) * 0.08
      viewHi = viewHi == null ? targetHi : viewHi + (targetHi - viewHi) * 0.08
      const yOf = (p) => PAD_Y + ((viewHi - p) / (viewHi - viewLo || 1)) * (h - PAD_Y * 2)

      // Grid.
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.07)'
      ctx.lineWidth = 1
      for (let i = 1; i < 4; i += 1) {
        const gy = PAD_Y + (i / 4) * (h - PAD_Y * 2)
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke()
      }

      // Close-line points (newest → oldest), used for the area fill and line.
      const pts = []
      for (let j = 0; j < candles.length; j += 1) {
        const x = xOf(j)
        if (x < -step || x > w + step) continue
        const k = candles[N - 1 - j]
        if (!k) continue
        pts.push([x, yOf(k.c)])
      }
      pts.sort((a, b) => a[0] - b[0])

      // Area fill under the line.
      if (pts.length > 1) {
        const grad = ctx.createLinearGradient(0, PAD_Y, 0, h)
        grad.addColorStop(0, 'rgba(56, 189, 248, 0.22)')
        grad.addColorStop(1, 'rgba(56, 189, 248, 0)')
        ctx.beginPath()
        ctx.moveTo(pts[0][0], pts[0][1])
        for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0], pts[i][1])
        ctx.lineTo(pts[pts.length - 1][0], h)
        ctx.lineTo(pts[0][0], h)
        ctx.closePath()
        ctx.fillStyle = grad
        ctx.fill()
      }

      // Candles.
      for (let j = 0; j < candles.length; j += 1) {
        const cx = xOf(j)
        if (cx < -step || cx > w + step) continue
        const k = candles[N - 1 - j]
        if (!k) continue
        const up = k.c >= k.o
        ctx.strokeStyle = up ? 'rgba(45, 212, 160, 0.9)' : 'rgba(248, 113, 133, 0.9)'
        ctx.fillStyle = up ? 'rgba(45, 212, 160, 0.95)' : 'rgba(248, 113, 133, 0.95)'
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(cx, yOf(k.h)); ctx.lineTo(cx, yOf(k.l)); ctx.stroke()
        const yo = yOf(k.o); const yc = yOf(k.c)
        ctx.fillRect(cx - CANDLE_W / 2, Math.min(yo, yc), CANDLE_W, Math.max(1.5, Math.abs(yc - yo)))
      }

      // Close line, glowing.
      if (pts.length > 1) {
        ctx.beginPath()
        ctx.moveTo(pts[0][0], pts[0][1])
        for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0], pts[i][1])
        ctx.strokeStyle = 'rgba(125, 211, 252, 0.95)'
        ctx.lineWidth = 1.75
        ctx.shadowColor = 'rgba(56, 189, 248, 0.6)'
        ctx.shadowBlur = 10
        ctx.stroke()
        ctx.shadowBlur = 0
      }

      // Current price: dashed line, pulsing marker, and a tag on the right.
      const yNow = yOf(price)
      const xNow = Math.min(w - RIGHT, xOf(0))
      ctx.strokeStyle = 'rgba(125, 211, 252, 0.28)'
      ctx.setLineDash([3, 4])
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(0, yNow); ctx.lineTo(xNow, yNow); ctx.stroke()
      ctx.setLineDash([])

      const pulse = reduceMotion ? 0 : (Math.sin((t || 0) / 350) + 1) / 2
      ctx.beginPath()
      ctx.arc(xNow, yNow, 5 + pulse * 4, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(56, 189, 248, ${0.18 - pulse * 0.12})`
      ctx.fill()
      ctx.beginPath()
      ctx.arc(xNow, yNow, 3, 0, Math.PI * 2)
      ctx.fillStyle = '#7dd3fc'
      ctx.fill()

      // Price tag pinned to the right edge.
      const label = fmt(price)
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif'
      const tw = ctx.measureText(label).width
      const tagW = tw + 14
      const tagH = 18
      const tagX = w - tagW - 4
      const tagY = Math.max(PAD_Y - tagH / 2, Math.min(h - PAD_Y - tagH / 2, yNow - tagH / 2))
      ctx.fillStyle = 'rgba(56, 189, 248, 0.16)'
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)'
      const r = 5
      ctx.beginPath()
      ctx.roundRect(tagX, tagY, tagW, tagH, r)
      ctx.fill(); ctx.stroke()
      ctx.fillStyle = '#bae6fd'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, tagX + 7, tagY + tagH / 2 + 0.5)

      if (reduceMotion) return

      offset += SPEED
      if (offset >= step) {
        offset -= step
        candles.push(makeCandle())
        candles.shift()
      }
      raf = requestAnimationFrame(draw)
    }

    draw(performance.now()) // paint the first frame synchronously, then loop

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <div className="relative h-full w-full overflow-hidden bg-ink-950">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {/* Scrims so the label and caption stay legible over the chart. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-16
                      bg-gradient-to-b from-ink-950 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24
                      bg-gradient-to-t from-ink-950 via-ink-950/85 to-transparent" />

      {/* Label, top-left. */}
      <div className="absolute left-4 top-4 flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 live-dot" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
          BTC · ETH Predict
        </span>
      </div>

      {/* Caption, bottom-left. */}
      <div className="absolute bottom-4 left-4 right-4">
        <p className="text-sm font-semibold text-slate-100">Call the next move.</p>
        <p className="mt-0.5 text-xs text-slate-400">
          Up/down predictions on BTC &amp; ETH — paper and live.
        </p>
      </div>
    </div>
  )
}
