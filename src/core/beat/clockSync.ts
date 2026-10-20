/**
 * Maps analysis time (seconds of audio processed) to performance.now() milliseconds.
 *
 * Each observation pairs an analysis time with the moment its message arrived. Message
 * delivery only ever adds delay, so the smallest offset seen is the best estimate; it creeps
 * up slowly to follow clock drift, and re-locks if delivery jumps (audio was paused).
 */

const CREEP = 0.01
const JUMP_MS = 50
const JUMP_CONFIRMATIONS = 5

export class ClockSync {
  private offsetMs: number | null = null
  private largeCount = 0

  get ready(): boolean {
    return this.offsetMs !== null
  }

  observe(analysisS: number, perfMs: number): void {
    const measured = perfMs - analysisS * 1000
    if (this.offsetMs === null || measured < this.offsetMs) {
      this.offsetMs = measured
      this.largeCount = 0
      return
    }
    if (measured - this.offsetMs > JUMP_MS) {
      if (++this.largeCount >= JUMP_CONFIRMATIONS) {
        this.offsetMs = measured
        this.largeCount = 0
      }
      return
    }
    this.largeCount = 0
    this.offsetMs += (measured - this.offsetMs) * CREEP
  }

  toPerf(analysisS: number): number {
    return analysisS * 1000 + (this.offsetMs ?? 0)
  }

  toAnalysis(perfMs: number): number {
    return (perfMs - (this.offsetMs ?? 0)) / 1000
  }

  reset(): void {
    this.offsetMs = null
    this.largeCount = 0
  }
}
