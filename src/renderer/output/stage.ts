import type { Rect } from '@core/fit'
import type { Rgb } from '@shared/protocol'
import { compileProgram, createClipTexture, uploadTexture, type TextureSource } from './gl'

const QUAD_VS = `#version 300 es
in vec2 aCorner;           // unit quad, (0,0) top-left .. (1,1) bottom-right
uniform vec4 uRect;        // x, y, w, h in target pixels, origin top-left
uniform vec2 uTarget;      // target size in pixels
out vec2 vUv;
void main() {
  vec2 px = uRect.xy + aCorner * uRect.zw;
  vec2 clip = px / uTarget * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUv = aCorner;           // texture row 0 is the top of the source image
}`

const QUAD_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uOpacity;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vUv) * uOpacity;   // premultiplied alpha
}`

/** A GPU texture plus the source size it currently holds. */
export interface StageTexture {
  readonly tex: WebGLTexture
  width: number
  height: number
}

/**
 * Owns the WebGL2 context for the output canvas: clears to the background color and
 * draws premultiplied-alpha textured quads for clip layers.
 */
export class Stage {
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null = null
  private uniforms: Record<'rect' | 'target' | 'tex' | 'opacity', WebGLUniformLocation | null> = {
    rect: null,
    target: null,
    tex: null,
    opacity: null,
  }
  private lost = false
  /** Bumped whenever the context is (re)created, so textures know to rebuild. */
  generation = 0

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
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    })
    this.gl = gl
    if (!gl) {
      console.error('WebGL2 is not available')
      return
    }
    this.program = compileProgram(gl, QUAD_VS, QUAD_FS)
    this.uniforms = {
      rect: gl.getUniformLocation(this.program, 'uRect'),
      target: gl.getUniformLocation(this.program, 'uTarget'),
      tex: gl.getUniformLocation(this.program, 'uTex'),
      opacity: gl.getUniformLocation(this.program, 'uOpacity'),
    }
    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(this.program, 'aCorner')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    this.generation++
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

  get ready(): boolean {
    return !!this.gl && !this.lost
  }

  get size(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height }
  }

  createTexture(): StageTexture | null {
    if (!this.gl || this.lost) return null
    return { tex: createClipTexture(this.gl), width: 0, height: 0 }
  }

  upload(target: StageTexture, source: TextureSource, width: number, height: number): void {
    if (!this.gl || this.lost) return
    uploadTexture(this.gl, target.tex, source)
    target.width = width
    target.height = height
  }

  deleteTexture(target: StageTexture): void {
    this.gl?.deleteTexture(target.tex)
  }

  beginFrame(background: Rgb): void {
    const gl = this.gl
    if (!gl || this.lost) return
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(background[0], background[1], background[2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  drawTexture(target: StageTexture, rect: Rect, opacity = 1): void {
    const gl = this.gl
    if (!gl || this.lost || !this.program || rect.w <= 0 || rect.h <= 0) return
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, target.tex)
    gl.uniform1i(this.uniforms.tex, 0)
    gl.uniform4f(this.uniforms.rect, rect.x, rect.y, rect.w, rect.h)
    gl.uniform2f(this.uniforms.target, this.canvas.width, this.canvas.height)
    gl.uniform1f(this.uniforms.opacity, opacity)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
  }

  /** Read one pixel of the frame just drawn (top-left origin). Only valid in the same task. */
  readPixel(x: number, y: number): [number, number, number, number] | null {
    const gl = this.gl
    if (!gl || this.lost) return null
    const out = new Uint8Array(4)
    gl.readPixels(
      Math.floor(x),
      this.canvas.height - 1 - Math.floor(y),
      1,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      out,
    )
    return [out[0]!, out[1]!, out[2]!, out[3]!]
  }
}
