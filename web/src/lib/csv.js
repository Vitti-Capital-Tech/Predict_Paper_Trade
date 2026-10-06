/**
 * CSV export.
 *
 * Deliberately hand-rolled rather than pulled from a package: the whole job is
 * quoting, and the rules are four lines long.
 */

/**
 * One field, escaped.
 *
 * A field is quoted when it contains a comma, a quote or a newline, and an
 * embedded quote is doubled - RFC 4180. The leading-separator guard is for
 * Excel: a value starting with =, +, - or @ is read as a formula, so a symbol
 * like "-BTC" would execute rather than display. Prefixing a tab stops that
 * without changing what the cell reads as.
 */
function field(v) {
  if (v === null || v === undefined) return ''
  let s = String(v)
  if (/^[=+\-@]/.test(s)) s = `\t${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Rows to CSV text.
 *
 * `columns` is [[header, accessor], ...]; the order is the column order.
 */
export function toCsv(rows, columns) {
  const out = [columns.map(([h]) => field(h)).join(',')]
  for (const r of rows) {
    out.push(columns.map(([, get]) => field(get(r))).join(','))
  }
  // CRLF, because Excel still wants it.
  return out.join('\r\n')
}

/** Hand the browser a file. */
export function downloadCsv(filename, text) {
  // The BOM is what makes Excel read it as UTF-8 rather than the local
  // codepage; without it a £ or a dash in an account name comes out mangled.
  const blob = new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking immediately can cancel the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** `predict-trades-BTC-Part-US-20261006.csv` */
export function csvName(scope) {
  const d = new Date()
  const stamp = [d.getFullYear(), d.getMonth() + 1, d.getDate()]
    .map((n) => String(n).padStart(2, '0')).join('')
  const safe = String(scope).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `predict-trades-${safe}-${stamp}.csv`
}
