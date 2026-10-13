// `Raster` cells, three words each (glyph, foreground, background), packed as
// base64; and the glyphs more than one drawing draws with.

export const DEFAULT = 0x01000000
export const SPACE = 0x20
export const FULL = 0x2588

export const SPINNER = [0x280b, 0x2819, 0x2839, 0x2838, 0x283c, 0x2834, 0x2826, 0x2827, 0x2807, 0x280f]
/** How long the spinner shows each of its glyphs. */
export const SPIN = 70

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Bytes as standard padded base64, as `Raster` cells take them: the runtime's own encoder where it has one. */
export function base64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64
  return typeof native === 'function' ? native.call(bytes) : encodeBase64(bytes)
}

/** Standard padded base64, by hand: for a runtime without `toBase64`. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!
    out += b === undefined ? '=' : ALPHABET[(n >> 6) & 63]!
    out += c === undefined ? '=' : ALPHABET[n & 63]!
  }
  return out
}

export function blank(cells: number): Uint32Array {
  const words = new Uint32Array(cells * 3)
  for (let i = 0; i < words.length; i += 3) {
    words[i] = SPACE
    words[i + 1] = DEFAULT
    words[i + 2] = DEFAULT
  }
  return words
}

/**
 * Where a drawing draws: `words`, cells in rows `columns` wide, the drawing
 * put at column `left` and cut off at column `right`, the columns from there
 * on another's or past the edge.
 */
export type Canvas = { words: Uint32Array; columns: number; left: number; right: number }

/** A blank canvas of its own, `columns` by `rows`. */
export const canvas = (columns: number, rows: number): Canvas => ({ words: blank(columns * rows), columns, left: 0, right: columns })

/**
 * Whether Raster draws a code point in one cell: printable ASCII, as the names
 * are kept to; the rest of Latin-1 but its soft hyphen (a `×`, a `·`); and the
 * box drawing, blocks and braille the bars are made of. Claude Code refuses a
 * whole drawing over any other (a control, combining or wide character).
 */
const isNarrow = (code: number): boolean =>
  (code >= 0x20 && code <= 0x7e) ||
  (code >= 0xa1 && code <= 0xff && code !== 0xad) ||
  (code >= 0x2500 && code <= 0x259f) ||
  (code >= 0x2800 && code <= 0x28ff)

const UNKNOWN = 0x3f

/**
 * Writes text into one row of cells, as far as column `end` (the row's end, by
 * default): each character Raster draws in one cell as itself, any other as a
 * `?`, as the names are sanitized; what falls outside the row is left out.
 */
export function write(words: Uint32Array, columns: number, row: number, start: number, text: string, color: number, end = columns) {
  if (row < 0 || (row + 1) * columns * 3 > words.length) return
  const last = Math.min(end, columns, start + text.length)
  for (let c = Math.max(0, start); c < last; c++) {
    const code = text.charCodeAt(c - start)
    const i = (row * columns + c) * 3
    words[i] = isNarrow(code) ? code : UNKNOWN
    words[i + 1] = color
    words[i + 2] = DEFAULT
  }
}
