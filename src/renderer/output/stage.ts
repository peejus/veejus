import type { Rgb } from '@shared/protocol'

/**
 * Owns the WebGL2 context for the output canvas. Phase 0 only clears to a color;
 * later phases add layers and shaders here.
 */
export class Stage {
  private gl: WebGL2RenderingContext | null = null
  private lost = false

  constructor(private readonly canvas: HTMLCanvasElement) {
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.lost = true
    })
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false
      this.init()
    })
    this.init()
    new ResizeObserver(() => this.resize()).observe(canvas)
    this.resize()
  }

  private init(): void {
    this.gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    })
    if (!this.gl) console.error('WebGL2 is not available')
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr))
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
  }

  get size(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height }
  }

  draw(background: Rgb): void {
    const gl = this.gl
    if (!gl || this.lost) return
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(background[0], background[1], background[2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }
}
