import type { ExternalStatus } from '@shared/beat'
import type { ExternalSample } from './beatEngine'

/**
 * Follows MIDI beat clock (24 ticks per quarter note).
 *
 * Tempo comes from a least-squares line through the recent tick times, so per-tick jitter
 * (USB, the OS) averages out. Position is known after a Start (the first tick after it is
 * beat 0, a downbeat), a Continue, or a Song Position Pointer; without one, only the tempo is
 * followed and the beat grid keeps its own phase.
 */

export const TICKS_PER_BEAT = 24
/** Ticks used for the tempo fit: four beats (jitter averages out, tempo changes still follow). */
const FIT_TICKS = 96
/** No ticks for this long means the clock has stopped arriving. */
const TIMEOUT_MS = 500
/** Tempos outside this range are treated as garbage. */
const BPM_RANGE = [20, 400] as const

const START = 0xfa
const CONTINUE = 0xfb
const STOP = 0xfc
const TICK = 0xf8
const SONG_POSITION = 0xf2

export class MidiClockFollower {
  /** Recent tick times, ms. */
  private times: number[] = []
  /** Ticks since the song position was known (null while unknown). */
  private position: number | null = null
  /** Position to apply at the next tick (set by Start / Continue / Song Position). */
  private pendingPosition: number | null = null
  private running = false
  private lastTickMs = -Infinity

  /** Feed one MIDI message (status byte plus data), received at `tMs`. */
  onMessage(bytes: ArrayLike<number>, tMs: number): void {
    const status = bytes[0]
    switch (status) {
      case TICK:
        this.tick(tMs)
        break
      case START:
        this.running = true
        this.pendingPosition = 0
        break
      case CONTINUE:
        this.running = true
        if (this.position !== null) this.pendingPosition = this.position
        break
      case STOP:
        this.running = false
        break
      case SONG_POSITION: {
        // Position in sixteenth notes (6 ticks each), 14 bits, LSB first.
        const sixteenths = ((bytes[2] ?? 0) << 7) | (bytes[1] ?? 0)
        this.pendingPosition = sixteenths * 6
        break
      }
    }
  }

  private tick(tMs: number): void {
    if (tMs - this.lastTickMs > TIMEOUT_MS) this.times = [] // a fresh stream
    this.lastTickMs = tMs
    this.times.push(tMs)
    if (this.times.length > FIT_TICKS) this.times.shift()
    if (this.pendingPosition !== null) {
      this.position = this.pendingPosition
      this.pendingPosition = null
    } else if (this.position !== null && this.running) {
      this.position++
    }
  }

  /** Line fit through recent ticks: [ms per tick, fitted time of the latest tick]. */
  private fit(): [number, number] | null {
    const n = this.times.length
    if (n < 6) return null
    let sx = 0
    let sy = 0
    let sxx = 0
    let sxy = 0
    for (let i = 0; i < n; i++) {
      const y = this.times[i]!
      sx += i
      sy += y
      sxx += i * i
      sxy += i * y
    }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx)
    const intercept = (sy - slope * sx) / n
    return [slope, intercept + slope * (n - 1)]
  }

  /** The current timing for the beat engine, or null when there is none. */
  sample(nowMs: number): ExternalSample | null {
    if (nowMs - this.lastTickMs > TIMEOUT_MS) return null
    const f = this.fit()
    if (!f) return null
    const [msPerTick, lastTickMs] = f
    const periodMs = msPerTick * TICKS_PER_BEAT
    const bpm = 60000 / periodMs
    if (!(bpm >= BPM_RANGE[0] && bpm <= BPM_RANGE[1])) return null
    if (this.position === null || !this.running) {
      return { periodMs, beatAtMs: lastTickMs, phaseKnown: false, beatNumber: null }
    }
    // The latest tick is `position` ticks into the song; step back to the beat it belongs to.
    const intoBeat = this.position % TICKS_PER_BEAT
    return {
      periodMs,
      beatAtMs: lastTickMs - intoBeat * msPerTick,
      phaseKnown: true,
      beatNumber: Math.floor(this.position / TICKS_PER_BEAT),
    }
  }

  status(nowMs: number): ExternalStatus {
    const s = this.sample(nowMs)
    if (!s) {
      return {
        ok: false,
        text:
          this.times.length > 0 ? 'MIDI clock: stopped arriving' : 'MIDI clock: waiting for ticks',
      }
    }
    const bpm = (60000 / s.periodMs).toFixed(1)
    return {
      ok: true,
      text: s.phaseKnown
        ? `MIDI clock: ${bpm} BPM, playing`
        : `MIDI clock: ${bpm} BPM (press play on the source to line up bars)`,
    }
  }

  reset(): void {
    this.times = []
    this.position = null
    this.pendingPosition = null
    this.running = false
    this.lastTickMs = -Infinity
  }
}
