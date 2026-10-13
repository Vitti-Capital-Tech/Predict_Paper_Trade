import { useEffect, useRef } from 'react'

/**
 * A small, self-contained "what this is" visual for the sign-in screen: a live
 * candlestick tape with a glowing close line, scrolling right-to-left like a
 * market feed. It evokes the product (BTC/ETH up-down trading) without shipping
 * a video — it is a canvas drawing a seeded random walk, so it is tiny and
 * loops forever. Pauses itself when the tab is hidden (rAF does this for free)
 * and when the user prefers reduced motion.
 */
export default function SignInVisual() {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const CANDLE_W = 9
    const GAP = 7
    const step = CANDLE_W + GAP
    const PAD = 22
    // A fixed price domain, so candles never jump vertically as the tape moves.
    const LO = 30
    const HI = 170

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

    let price = 100
    const makeCandle = () => {
      const o = price
      const drift = (Math.random() - 0.5) * 10 + (100 - price) * 0.03 // gentle mean-revert
      let c = o + drift
      c = Math.max(LO + 6, Math.min(HI - 6, c))
      const hi = Math.max(o, c) + Math.random() * 5
      const lo = Math.min(o, c) - Math.random() * 5
      price = c
      return { o, h: hi, l: lo, c }
    }

    const BUFFER = 90
    const candles = Array.from({ length: BUFFER }, makeCandle)

    const yOf = (p) => {
      const clamped = Math.max(LO, Math.min(HI, p))
      return PAD + ((HI - clamped) / (HI - LO)) * (h - PAD * 2)
    }

    let offset = 0
    const SPEED = 0.35
    let raf = 0
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches

    const draw = () => {
      ctx.clearRect(0, 0, w, h)

      // Faint horizontal grid.
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)'
      ctx.lineWidth = 1
      for (let i = 1; i < 4; i += 1) {
        const gy = PAD + (i / 4) * (h - PAD * 2)
        ctx.beginPath()
        ctx.moveTo(0, gy)
        ctx.lineTo(w, gy)
        ctx.stroke()
      }

      const xOf = (i) => i * step - offset

      // Candles.
      for (let i = 0; i < candles.length; i += 1) {
        const left = xOf(i)
        if (left < -step || left > w) continue
        const k = candles[i]
        const cx = left + CANDLE_W / 2
        const up = k.c >= k.o
        const stroke = up ? 'rgba(52, 211, 153, 0.85)' : 'rgba(251, 113, 133, 0.85)'
        ctx.strokeStyle = stroke
        ctx.fillStyle = up ? 'rgba(52, 211, 153, 0.9)' : 'rgba(251, 113, 133, 0.9)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(cx, yOf(k.h))
        ctx.lineTo(cx, yOf(k.l))
        ctx.stroke()
        const yo = yOf(k.o)
        const yc = yOf(k.c)
        const top = Math.min(yo, yc)
        const bh = Math.max(2, Math.abs(yc - yo))
        ctx.fillRect(cx - CANDLE_W / 2, top, CANDLE_W, bh)
      }

      // Glowing close line over the top.
      ctx.beginPath()
      let started = false
      for (let i = 0; i < candles.length; i += 1) {
        const px = xOf(i) + CANDLE_W / 2
        if (px < -step || px > w + step) continue
        const py = yOf(candles[i].c)
        if (!started) { ctx.moveTo(px, py); started = true }
        else ctx.lineTo(px, py)
      }
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.95)'
      ctx.lineWidth = 1.75
      ctx.shadowColor = 'rgba(56, 189, 248, 0.7)'
      ctx.shadowBlur = 10
      ctx.stroke()
      ctx.shadowBlur = 0

      if (reduceMotion) return // drawn once, no loop

      offset += SPEED
      if (offset >= step) {
        offset -= step
        candles.push(makeCandle())
        candles.shift()
      }
      raf = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <div className="relative h-full w-full overflow-hidden bg-ink-950">
      {/* The live tape. */}
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {/* Sky glow from the bottom, so the chart sits in light rather than on a
          flat panel. */}
      <div className="pointer-events-none absolute inset-0
                      bg-gradient-to-t from-sky-500/10 via-transparent to-transparent" />

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
