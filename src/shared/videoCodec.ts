/**
 * Finding a video's codec from its MP4/MOV header, to explain why a file won't play. Chromium
 * only says "unsupported" (or, for HEVC with an audio track, loads the sound and shows no
 * picture), so the codec name is what tells a performer what to do about it.
 */

/** Reads `length` bytes at `offset` (fewer at the end of the file). */
export type ReadBytes = (offset: number, length: number) => Promise<Uint8Array>

/** Never read a header bigger than this (real ones are well under a few MB). */
const MAX_MOOV_BYTES = 64 * 1024 * 1024
/** Give up after this many top-level boxes (a broken or non-MP4 file). */
const MAX_TOP_BOXES = 64

const CONTAINERS = new Set(['trak', 'mdia', 'minf', 'stbl'])

function fourcc(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!)
}

function u32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0
}

function u64(b: Uint8Array, at: number): number {
  return u32(b, at) * 2 ** 32 + u32(b, at + 4)
}

interface Box {
  type: string
  /** Where the box's contents start, and end (exclusive). */
  start: number
  end: number
}

/** The boxes directly inside b[from, to). */
function children(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = []
  let at = from
  while (at + 8 <= to) {
    let size = u32(b, at)
    const type = fourcc(b, at + 4)
    let header = 8
    if (size === 1) {
      if (at + 16 > to) break
      size = u64(b, at + 8)
      header = 16
    } else if (size === 0) size = to - at
    if (size < header || at + size > to) break
    out.push({ type, start: at + header, end: at + size })
    at += size
  }
  return out
}

/** Sample-entry type of the first video track in a moov box's contents, e.g. "hvc1". */
export function videoCodecInMoov(moov: Uint8Array): string | null {
  for (const trak of children(moov, 0, moov.length)) {
    if (trak.type !== 'trak') continue
    let handler: string | null = null
    let entry: string | null = null
    const walk = (from: number, to: number) => {
      for (const box of children(moov, from, to)) {
        // The first hdlr is the media handler (QuickTime adds a data handler inside minf).
        if (box.type === 'hdlr' && box.start + 12 <= box.end)
          handler ??= fourcc(moov, box.start + 8)
        // stsd: version/flags (4), entry count (4), then the first entry's size and type.
        else if (box.type === 'stsd' && box.start + 16 <= box.end)
          entry = fourcc(moov, box.start + 12)
        else if (CONTAINERS.has(box.type)) walk(box.start, box.end)
      }
    }
    walk(trak.start, trak.end)
    if (handler === 'vide' && entry) return entry
  }
  return null
}

/** The video codec of an MP4/MOV file, or null if it isn't one (or has no video track). */
export async function readVideoCodec(read: ReadBytes, size: number): Promise<string | null> {
  let at = 0
  for (let i = 0; i < MAX_TOP_BOXES && at + 8 <= size; i++) {
    const head = await read(at, 16)
    if (head.length < 8) return null
    let boxSize = u32(head, 0)
    let header = 8
    if (boxSize === 1) {
      if (head.length < 16) return null
      boxSize = u64(head, 8)
      header = 16
    } else if (boxSize === 0) boxSize = size - at
    if (boxSize < header) return null
    if (fourcc(head, 4) === 'moov') {
      const length = Math.min(boxSize - header, size - at - header)
      if (length > MAX_MOOV_BYTES) return null
      return videoCodecInMoov(await read(at + header, length))
    }
    at += boxSize
  }
  return null
}

const HEVC = new Set(['hvc1', 'hev1', 'dvh1', 'dvhe'])
const PRORES = new Set(['apch', 'apcn', 'apcs', 'apco', 'ap4h', 'ap4x'])

/** A plain explanation for a video codec Veejus can't play, or null if the codec isn't why. */
export function videoCodecProblem(codec: string | null): string | null {
  if (codec === null) return null
  if (HEVC.has(codec))
    return (
      'HEVC (H.265) video needs hardware decoding: turn it on in Setup → Diagnostics, ' +
      'or convert the file to H.264'
    )
  if (PRORES.has(codec)) return 'ProRes video can’t be played: convert the file to H.264'
  return null
}

/**
 * Why the video at `url` (a media URL that answers Range requests) can't play, if its codec
 * explains it; null otherwise, or if the header can't be read.
 */
export async function codecProblemAt(url: string, size: number): Promise<string | null> {
  const read: ReadBytes = async (offset, length) => {
    const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } })
    if (res.status !== 206) throw new Error(`Range request failed (${res.status})`)
    return new Uint8Array(await res.arrayBuffer())
  }
  try {
    return videoCodecProblem(await readVideoCodec(read, size))
  } catch {
    return null
  }
}
