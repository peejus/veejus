import type { BeatEngine, ExternalSample } from '@core/beat/beatEngine'
import { MidiClockFollower } from '@core/beat/midiClock'
import type { ClockSource, ExternalStatus } from '@shared/beat'
import type { LinkSample, OutputCommand } from '@shared/protocol'

/** Link samples older than this mean the main process stopped sending (Link off or stalled). */
const LINK_STALE_MS = 500

/**
 * Feeds the beat engine from an external clock: MIDI beat clock (read here with Web MIDI,
 * timestamped on this window's clock) or Ableton Link (sampled in the main process).
 */
export class ExternalClock {
  private source: ClockSource = 'internal'
  readonly midi = new MidiClockFollower()
  private midiAccess: MIDIAccess | null = null
  private midiError: string | null = null
  private midiInputs = ''
  private link: { sample: ExternalSample; status: ExternalStatus; atMs: number } | null = null
  private linkError: string | null = null

  constructor(
    private readonly engine: BeatEngine,
    private readonly command: (cmd: OutputCommand) => void,
  ) {}

  /** The engine's clock source changed. */
  setSource(source: ClockSource, nowMs: number): void {
    if (source === this.source) return
    const was = this.source
    this.source = source
    if (was === 'link') this.command({ type: 'link', enabled: false, bpm: this.engine.bpm })
    if (source === 'link') {
      this.link = null
      this.linkError = null
      this.command({ type: 'link', enabled: true, bpm: this.engine.bpm })
    }
    if (source === 'midi') {
      this.midi.reset()
      void this.openMidi()
    }
    void nowMs
  }

  /** Propose a tempo to Link (tempo commands while following Link). */
  proposeTempo(bpm: number): void {
    if (this.source === 'link') this.command({ type: 'linkTempo', bpm })
  }

  private async openMidi(): Promise<void> {
    if (this.midiAccess) return
    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: false })
      const attach = () => {
        const names: string[] = []
        for (const input of this.midiAccess!.inputs.values()) {
          names.push(input.name ?? 'MIDI input')
          input.onmidimessage = (e) => {
            if (this.source === 'midi' && e.data) this.midi.onMessage(e.data, e.timeStamp)
          }
        }
        this.midiInputs = names.join(', ')
      }
      attach()
      this.midiAccess.onstatechange = attach
    } catch (err) {
      this.midiError = err instanceof Error ? err.message : String(err)
    }
  }

  onLink(s: LinkSample): void {
    if (!s.available) {
      this.linkError = s.error
      this.link = null
      return
    }
    // Epoch time -> this window's performance.now(); both are high-resolution wall clocks.
    const t = s.epochMs - performance.timeOrigin
    const periodMs = 60000 / s.tempo
    const n = Math.floor(s.phase)
    const peers =
      s.peers === 0 ? 'no other apps yet' : `${s.peers} other app${s.peers === 1 ? '' : 's'}`
    this.link = {
      sample: { periodMs, beatAtMs: t - (s.phase - n) * periodMs, phaseKnown: true, beatNumber: n },
      status: { ok: true, text: `Link: ${s.tempo.toFixed(1)} BPM, ${peers}` },
      atMs: performance.now(),
    }
  }

  /** Hand the engine the latest timing. Call every frame, before engine.update(). */
  update(nowMs: number): void {
    if (this.source === 'midi') {
      const sample = this.midi.sample(nowMs)
      // Ticks arriving say it all; otherwise explain why nothing is.
      const status: ExternalStatus = sample
        ? this.midi.status(nowMs)
        : this.midiError
          ? { ok: false, text: `MIDI unavailable: ${this.midiError}` }
          : this.midiAccess && this.midiInputs === ''
            ? { ok: false, text: 'MIDI clock: no MIDI inputs found' }
            : this.midi.status(nowMs)
      this.engine.setExternal(sample, status)
    } else if (this.source === 'link') {
      if (this.linkError) {
        this.engine.setExternal(null, { ok: false, text: this.linkError })
      } else if (!this.link || nowMs - this.link.atMs > LINK_STALE_MS) {
        this.engine.setExternal(null, { ok: false, text: 'Link: starting…' })
      } else {
        this.engine.setExternal(this.link.sample, this.link.status)
      }
    }
  }
}
