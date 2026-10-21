import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { LinkSample } from '@shared/protocol'

/** The parts of the native binding we use (see scripts/build-link.mjs). */
interface LinkInstance {
  enable(enabled: boolean): void
  getTempo(): number
  setTempo(bpm: number): void
  /** Position within a bar of `quantum` beats; peers agree on it. */
  getPhase(quantum: number): number
  getNumPeers(): number
}
interface LinkAddon {
  AbletonLink: new (bpm: number) => LinkInstance
}

/** How often Link timing is sent to the output. */
const SAMPLE_MS = 20
const QUANTUM = 4

/**
 * Ableton Link session, in the main process (the native module can't load in a sandboxed
 * renderer). While enabled it samples tempo and bar phase every 20 ms and timestamps each sample
 * in epoch milliseconds, which the output converts to its own clock.
 */
export class LinkManager {
  private link: LinkInstance | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private loadError: string | null = null

  constructor(
    private readonly modulePath: string,
    private readonly send: (sample: LinkSample) => void,
  ) {}

  private load(bpm: number): LinkInstance | null {
    if (this.link) return this.link
    if (this.loadError) return null
    if (!existsSync(this.modulePath)) {
      this.loadError = 'Ableton Link isn’t installed (run npm run build:link)'
      return null
    }
    try {
      // A Node-API addon: one build works in Node and Electron.
      const addon = createRequire(__filename)(this.modulePath) as LinkAddon
      this.link = new addon.AbletonLink(bpm)
      return this.link
    } catch (err) {
      this.loadError = `Ableton Link failed to load: ${err instanceof Error ? err.message : err}`
      return null
    }
  }

  setEnabled(enabled: boolean, bpm = 120): void {
    if (!enabled) {
      this.link?.enable(false)
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      return
    }
    const link = this.load(bpm)
    if (!link) {
      this.send({ available: false, error: this.loadError ?? 'unavailable' })
      return
    }
    link.enable(true)
    if (!this.timer) this.timer = setInterval(() => this.sample(), SAMPLE_MS)
    this.sample()
  }

  setTempo(bpm: number): void {
    this.link?.setTempo(bpm)
  }

  private sample(): void {
    const link = this.link
    if (!link) return
    const phase = link.getPhase(QUANTUM)
    const epochMs = performance.timeOrigin + performance.now()
    this.send({
      available: true,
      tempo: link.getTempo(),
      phase,
      epochMs,
      peers: link.getNumPeers(),
    })
  }

  dispose(): void {
    this.setEnabled(false)
  }
}

/** Where the built module lives: native/ at the project root (next to out/). */
export function linkModulePath(mainDir: string): string {
  return join(mainDir, '..', '..', 'native', 'abletonlink.node')
}
