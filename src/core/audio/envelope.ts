/**
 * One-pole attack/release envelope follower, stepped once per analysis hop.
 * Time constants are the time to cover ~63% of a step change.
 */
export class EnvelopeFollower {
  private value = 0
  private attackCoef = 1
  private releaseCoef = 1

  constructor(
    private readonly stepSeconds: number,
    attackMs: number,
    releaseMs: number,
  ) {
    this.setTimes(attackMs, releaseMs)
  }

  setTimes(attackMs: number, releaseMs: number): void {
    this.attackCoef = coefFor(attackMs, this.stepSeconds)
    this.releaseCoef = coefFor(releaseMs, this.stepSeconds)
  }

  step(input: number): number {
    const coef = input > this.value ? this.attackCoef : this.releaseCoef
    this.value += coef * (input - this.value)
    return this.value
  }

  get current(): number {
    return this.value
  }

  reset(): void {
    this.value = 0
  }
}

/** Fraction of the remaining distance covered per step for a time constant. */
function coefFor(ms: number, stepSeconds: number): number {
  if (ms <= 0) return 1
  return 1 - Math.exp(-stepSeconds / (ms / 1000))
}
