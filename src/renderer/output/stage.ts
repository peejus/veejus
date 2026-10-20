import type { Transform } from '@core/placement'
import type { BlendMode, KeySettings } from '@shared/layers'
import type { Rgb } from '@shared/protocol'
import { compileProgram, createClipTexture, uploadTexture, type TextureSource } from './gl'

/**
 * The output compositor (WebGL2).
 *
 * Each frame: clear an offscreen accumulation texture to the background color, composite the
 * layers into it bottom to top, then draw it to the screen through the master pass
 * (brightness / blackout). Before each layer the accumulation is copied, so the layer shader
 * can read what is underneath: every blend mode (including difference) and keying is exact,
 * not limited to fixed-function blending.
 */

const LAYER_VS = `#version 300 es
in vec2 aCorner;              // unit quad (0,0) top-left .. (1,1) bottom-right
uniform vec2 uCenter;         // px, y down
uniform vec2 uSize;           // px
uniform float uRotation;      // radians, clockwise on screen
uniform vec2 uTarget;         // px
out vec2 vUv;
void main() {
  vec2 local = (aCorner - 0.5) * uSize;
  float c = cos(uRotation), s = sin(uRotation);
  vec2 px = uCenter + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 clip = px / uTarget * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUv = aCorner;              // texture row 0 is the top of the source image
}`

const LAYER_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;       // premultiplied clip frame
uniform sampler2D uDst;       // copy of the composite so far
uniform vec2 uTarget;
uniform float uOpacity;
uniform int uBlend;           // 0 normal, 1 add, 2 screen, 3 multiply, 4 difference
uniform int uKeyMode;         // 0 none, 1 chroma, 2 luma
uniform vec3 uKeyColor;
uniform float uSimilarity, uSmoothness, uSpill, uThreshold, uSoftness;
uniform bool uInvert;
out vec4 outColor;

vec2 chroma(vec3 c) {
  return vec2(-0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b, 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b);
}

void main() {
  vec4 t = texture(uTex, vUv);
  vec3 c = t.a > 0.0 ? t.rgb / t.a : vec3(0.0);
  float a = t.a;
  if (uKeyMode == 1) {
    float d = distance(chroma(c), chroma(uKeyColor)) / 0.7;
    a *= smoothstep(uSimilarity, uSimilarity + uSmoothness + 1e-4, d);
    // Spill: pull the key color's tint out of what remains near the key.
    float near = 1.0 - smoothstep(uSimilarity, uSimilarity + uSmoothness + 0.3, d);
    float luma = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(c, vec3(luma), clamp(uSpill * near, 0.0, 1.0));
  } else if (uKeyMode == 2) {
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    float k = smoothstep(uThreshold, uThreshold + uSoftness + 1e-4, l);
    a *= uInvert ? 1.0 - k : k;
  }
  a *= uOpacity;
  vec3 d = texture(uDst, gl_FragCoord.xy / uTarget).rgb;
  vec3 r;
  if (uBlend == 1) r = d + c * a;
  else if (uBlend == 2) r = mix(d, 1.0 - (1.0 - c) * (1.0 - d), a);
  else if (uBlend == 3) r = mix(d, c * d, a);
  else if (uBlend == 4) r = mix(d, abs(c - d), a);
  else r = mix(d, c, a);
  outColor = vec4(clamp(r, 0.0, 1.0), 1.0);
}`

const MASTER_VS = `#version 300 es
in vec2 aCorner;
out vec2 vUv;
void main() {
  vUv = vec2(aCorner.x, 1.0 - aCorner.y);   // texture origin is bottom-left
  gl_Position = vec4(aCorner * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
}`

const MASTER_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform float uBrightness;
out vec4 outColor;
void main() {
  outColor = vec4(texture(uSrc, vUv).rgb * uBrightness, 1.0);
}`

const BLEND_INDEX: Record<BlendMode, number> = {
  normal: 0,
  add: 1,
  screen: 2,
  multiply: 3,
  difference: 4,
}

/** A GPU texture plus the source size it currently holds. */
export interface StageTexture {
  readonly tex: WebGLTexture
  width: number
  height: number
}

export interface LayerDraw {
  opacity: number
  blend: BlendMode
  key: KeySettings | null
}

interface Target {
  fb: WebGLFramebuffer
  tex: WebGLTexture
  width: number
  height: number
}

type Uniforms = Record<string, WebGLUniformLocation | null>

export class Stage {
  private gl: WebGL2RenderingContext | null = null
  private layerProgram: WebGLProgram | null = null
  private masterProgram: WebGLProgram | null = null
  private layerU: Uniforms = {}
  private masterU: Uniforms = {}
  private vao: WebGLVertexArrayObject | null = null
  /** Composite in progress, and the copy layers read from. */
  private accum: Target | null = null
  private dst: Target | null = null
  private preview: Target | null = null
  private previewPbo: WebGLBuffer | null = null
  private previewPboBytes = 0
  private pendingPreview: { fence: WebGLSync; width: number; height: number } | null = null
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
    this.layerProgram = compileProgram(gl, LAYER_VS, LAYER_FS)
    this.masterProgram = compileProgram(gl, MASTER_VS, MASTER_FS)
    const locate = (p: WebGLProgram, names: string[]) =>
      Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)]))
    this.layerU = locate(this.layerProgram, [
      'uCenter',
      'uSize',
      'uRotation',
      'uTarget',
      'uTex',
      'uDst',
      'uOpacity',
      'uBlend',
      'uKeyMode',
      'uKeyColor',
      'uSimilarity',
      'uSmoothness',
      'uSpill',
      'uThreshold',
      'uSoftness',
      'uInvert',
    ])
    this.masterU = locate(this.masterProgram, ['uSrc', 'uBrightness'])

    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
    // Both programs bind aCorner to location 0.
    for (const p of [this.layerProgram, this.masterProgram]) {
      const loc = gl.getAttribLocation(p, 'aCorner')
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    }
    gl.bindVertexArray(null)
    this.accum = this.dst = this.preview = null
    this.previewPbo = null
    this.pendingPreview = null
    this.generation++
  }

  private makeTarget(width: number, height: number): Target {
    const gl = this.gl!
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fb = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { fb, tex, width, height }
  }

  private freeTarget(t: Target | null): void {
    if (!t || !this.gl) return
    this.gl.deleteFramebuffer(t.fb)
    this.gl.deleteTexture(t.tex)
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

  /** Make sure the accumulation targets match the canvas size. */
  private ensureTargets(): boolean {
    if (!this.gl || this.lost) return false
    const { width, height } = this.canvas
    if (!this.accum || this.accum.width !== width || this.accum.height !== height) {
      this.freeTarget(this.accum)
      this.freeTarget(this.dst)
      this.accum = this.makeTarget(width, height)
      this.dst = this.makeTarget(width, height)
    }
    return true
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

  /** Start a frame: the composite becomes the background color. */
  beginFrame(background: Rgb): void {
    if (!this.ensureTargets()) return
    const gl = this.gl!
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum!.fb)
    gl.viewport(0, 0, this.accum!.width, this.accum!.height)
    gl.disable(gl.BLEND)
    gl.clearColor(background[0], background[1], background[2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  /** Composite one clip onto the frame. */
  drawLayer(texture: StageTexture, t: Transform, draw: LayerDraw): void {
    const gl = this.gl
    if (!gl || this.lost || !this.accum || !this.dst || t.w <= 0 || t.h <= 0 || draw.opacity <= 0)
      return
    const { width, height } = this.accum

    // Snapshot the composite so far for the shader to read.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.accum.fb)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.dst.fb)
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum.fb)
    gl.viewport(0, 0, width, height)

    const u = this.layerU
    gl.useProgram(this.layerProgram)
    gl.bindVertexArray(this.vao)
    gl.disable(gl.BLEND)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture.tex)
    gl.uniform1i(u.uTex!, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.dst.tex)
    gl.uniform1i(u.uDst!, 1)
    gl.uniform2f(u.uCenter!, t.cx, t.cy)
    gl.uniform2f(u.uSize!, t.w, t.h)
    gl.uniform1f(u.uRotation!, t.rotation)
    gl.uniform2f(u.uTarget!, width, height)
    gl.uniform1f(u.uOpacity!, Math.min(1, Math.max(0, draw.opacity)))
    gl.uniform1i(u.uBlend!, BLEND_INDEX[draw.blend])
    const k = draw.key
    gl.uniform1i(u.uKeyMode!, !k || k.mode === 'none' ? 0 : k.mode === 'chroma' ? 1 : 2)
    if (k) {
      gl.uniform3f(u.uKeyColor!, k.color[0], k.color[1], k.color[2])
      gl.uniform1f(u.uSimilarity!, k.similarity)
      gl.uniform1f(u.uSmoothness!, k.smoothness)
      gl.uniform1f(u.uSpill!, k.spill)
      gl.uniform1f(u.uThreshold!, k.threshold)
      gl.uniform1f(u.uSoftness!, k.softness)
      gl.uniform1i(u.uInvert!, k.invert ? 1 : 0)
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
    gl.activeTexture(gl.TEXTURE0)
  }

  private master(
    target: WebGLFramebuffer | null,
    width: number,
    height: number,
    brightness: number,
  ): void {
    const gl = this.gl!
    gl.bindFramebuffer(gl.FRAMEBUFFER, target)
    gl.viewport(0, 0, width, height)
    gl.disable(gl.BLEND)
    gl.useProgram(this.masterProgram)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.accum!.tex)
    gl.uniform1i(this.masterU.uSrc!, 0)
    gl.uniform1f(this.masterU.uBrightness!, brightness)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
  }

  /** Finish the frame: draw the composite to the screen at `brightness` (0 = black). */
  endFrame(brightness: number): void {
    if (!this.gl || this.lost || !this.accum) return
    this.master(null, this.canvas.width, this.canvas.height, brightness)
  }

  /**
   * Start an asynchronous readback of a downscaled copy of the frame just finished. The pixels
   * arrive from `takePreview()` on a later frame, once the GPU has finished, so the render
   * loop never waits on the GPU. Returns false if a readback is still in flight.
   */
  requestPreview(width: number, height: number, brightness: number): boolean {
    const gl = this.gl
    if (!gl || this.lost || !this.accum || this.pendingPreview) return false
    if (!this.preview || this.preview.width !== width || this.preview.height !== height) {
      this.freeTarget(this.preview)
      this.preview = this.makeTarget(width, height)
    }
    this.master(this.preview.fb, width, height, brightness)
    const bytes = width * height * 4
    if (!this.previewPbo || this.previewPboBytes !== bytes) {
      if (this.previewPbo) gl.deleteBuffer(this.previewPbo)
      this.previewPbo = gl.createBuffer()
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.previewPbo)
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ)
      this.previewPboBytes = bytes
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.previewPbo)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    gl.flush()
    if (!fence) return false
    this.pendingPreview = { fence, width, height }
    return true
  }

  /** The finished preview readback, if the GPU is done with it (RGBA, bottom-up rows). */
  takePreview(): { width: number; height: number; pixels: Uint8Array } | null {
    const gl = this.gl
    const p = this.pendingPreview
    if (!gl || !p) return null
    const status = gl.clientWaitSync(p.fence, 0, 0)
    if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) return null
    gl.deleteSync(p.fence)
    this.pendingPreview = null
    const pixels = new Uint8Array(p.width * p.height * 4)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.previewPbo)
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    return { width: p.width, height: p.height, pixels }
  }

  /** Read one pixel of the frame just shown (top-left origin). Only valid in the same task. */
  readPixel(x: number, y: number): [number, number, number, number] | null {
    const gl = this.gl
    if (!gl || this.lost) return null
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
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
