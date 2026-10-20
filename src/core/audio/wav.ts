/** Minimal WAV (RIFF PCM / IEEE float) reader and writer. */

export interface DecodedAudio {
  sampleRate: number
  /** One Float32Array per channel, samples in -1..1. */
  channels: Float32Array[]
}

export function decodeWav(bytes: Uint8Array): DecodedAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4))
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file')

  let format = 0
  let channelCount = 0
  let sampleRate = 0
  let bits = 0
  let dataOffset = -1
  let dataLength = 0
  for (let o = 12; o + 8 <= bytes.length;) {
    const id = tag(o)
    const size = view.getUint32(o + 4, true)
    const body = o + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channelCount = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true) // extensible
    } else if (id === 'data') {
      dataOffset = body
      dataLength = Math.min(size, bytes.length - body)
    }
    o = body + size + (size & 1)
  }
  if (dataOffset < 0 || channelCount === 0) throw new Error('WAV file has no audio data')
  const isFloat = format === 3
  if (!(format === 1 || isFloat)) throw new Error(`Unsupported WAV format ${format}`)
  if (!(isFloat ? bits === 32 || bits === 64 : [8, 16, 24, 32].includes(bits))) {
    throw new Error(`Unsupported WAV bit depth ${bits}`)
  }

  const bytesPer = bits / 8
  const frames = Math.floor(dataLength / (bytesPer * channelCount))
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames))
  let o = dataOffset
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++, o += bytesPer) {
      let v: number
      if (isFloat) v = bits === 32 ? view.getFloat32(o, true) : view.getFloat64(o, true)
      else if (bits === 8) v = (view.getUint8(o) - 128) / 128
      else if (bits === 16) v = view.getInt16(o, true) / 32768
      else if (bits === 24) {
        const x = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16)
        v = x / 8388608
      } else v = view.getInt32(o, true) / 2147483648
      channels[c]![i] = v
    }
  }
  return { sampleRate, channels }
}

export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  bits: 16 | 24 | 32 = 16,
): Uint8Array {
  const channelCount = channels.length
  const frames = channels[0]?.length ?? 0
  const bytesPer = bits / 8
  const dataLength = frames * channelCount * bytesPer
  const bytes = new Uint8Array(44 + dataLength)
  const view = new DataView(bytes.buffer)
  const writeTag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) bytes[o + i] = s.charCodeAt(i)
  }
  writeTag(0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeTag(8, 'WAVE')
  writeTag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, bits === 32 ? 3 : 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channelCount * bytesPer, true)
  view.setUint16(32, channelCount * bytesPer, true)
  view.setUint16(34, bits, true)
  writeTag(36, 'data')
  view.setUint32(40, dataLength, true)
  let o = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++, o += bytesPer) {
      const v = Math.max(-1, Math.min(1, channels[c]![i]!))
      if (bits === 32) view.setFloat32(o, v, true)
      else if (bits === 16) view.setInt16(o, Math.round(v * 32767), true)
      else {
        const x = Math.round(v * 8388607)
        view.setUint8(o, x & 0xff)
        view.setUint8(o + 1, (x >> 8) & 0xff)
        view.setInt8(o + 2, x >> 16)
      }
    }
  }
  return bytes
}

/** Average all channels into one. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!
  const n = channels[0]?.length ?? 0
  const out = new Float32Array(n)
  for (const ch of channels) for (let i = 0; i < n; i++) out[i]! += ch[i]! / channels.length
  return out
}
