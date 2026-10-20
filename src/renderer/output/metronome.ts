import { BEATS_PER_BAR } from '@shared/beat'

/** Four lights in the debug overlay showing the beat clock; the downbeat lights pink. */
export class Metronome {
  private readonly lights: HTMLDivElement[] = []
  private timer = 0

  constructor(private readonly root: HTMLDivElement) {
    for (let i = 0; i < BEATS_PER_BAR; i++) {
      const light = document.createElement('div')
      light.className = i === 0 ? 'light downbeat' : 'light'
      root.appendChild(light)
      this.lights.push(light)
    }
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible
  }

  /** Light the given beat (1-based) briefly. */
  beat(beatInBar: number): void {
    for (const [i, light] of this.lights.entries())
      light.classList.toggle('on', i === beatInBar - 1)
    clearTimeout(this.timer)
    this.timer = window.setTimeout(() => this.lights.forEach((l) => l.classList.remove('on')), 120)
  }
}
