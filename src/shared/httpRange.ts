export interface ByteRange {
  /** Inclusive. */
  start: number
  /** Inclusive. */
  end: number
}

/**
 * Parse a single-range HTTP `Range` header against a resource of `size` bytes.
 * Returns null when there is no usable range (serve the whole file), or 'unsatisfiable'
 * for a syntactically valid range that falls outside the file.
 */
export function parseRange(
  header: string | null | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, startStr = '', endStr = ''] = m
  if (startStr === '' && endStr === '') return null

  if (startStr === '') {
    // Suffix range: the last N bytes.
    const n = Number(endStr)
    if (n === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }

  const start = Number(startStr)
  if (start >= size) return 'unsatisfiable'
  const end = endStr === '' ? size - 1 : Math.min(Number(endStr), size - 1)
  if (end < start) return null
  return { start, end }
}
