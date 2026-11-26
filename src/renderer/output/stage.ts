import type { Transform } from '@core/placement'
import type { BlendMode, KeySettings } from '@shared/layers'
import type { Rgb } from '@shared/protocol'
import { effectIsActive, type ResolvedEffect } from '@core/modulation/modulation'
import { EFFECT_DEFS } from '@shared/fx'
import { BEAT_WRAP, EFFECT_FS, EFFECT_INDEX } from './effectShader'
import {
  DEFAULT_OUTPUT_OPTIONS,
  pictureLayout,
  type OutputOptions,
  type PictureLayout,
} from '@shared/output'
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
uniform bool uFlipV;          // source is a GL render target (row 0 at the bottom)
out vec2 vUv;
void main() {
  vec2 local = (aCorner - 0.5) * uSize;
  float c = cos(uRotation), s = sin(uRotation);
  vec2 px = uCenter + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 clip = px / uTarget * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUv = uFlipV ? vec2(aCorner.x, 1.0 - aCorner.y) : aCorner; // clip row 0 is the top
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
uniform bool uIsolated;       // draw onto transparent, premultiplied (for effect chains)
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
  if (uIsolated) {
    outColor = vec4(c * a, a);
    return;
  }
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
uniform vec2 uRes;
uniform float uScale;         // master transform: zoom, rotation (radians), offset (fraction)
uniform float uRot;
uniform vec2 uOffset;
out vec4 outColor;
void main() {
  vec2 p = (vUv - 0.5 - uOffset) * vec2(uRes.x / uRes.y, 1.0);
  float c = cos(uRot), s = sin(uRot);
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c) / uScale;
  vec2 uv = p / vec2(uRes.x / uRes.y, 1.0) + 0.5;
  bool inside = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
  outColor = vec4(inside ? texture(uSrc, uv).rgb * uBrightness : vec3(0.0), 1.0);
}`

/** Whole-frame transform from the master chain's scale / rotation / move parameters. */
export interface MasterTransform {
  scale: number
  rotationDeg: number
  x: number
  y: number
}

const IDENTITY: MasterTransform = { scale: 0, rotationDeg: 0, x: 0, y: 0 }

/** An effect chain to run: resolved effects (in order) at a beat position. */
export interface FxPass {
  /** Unique per chain; feedback history is kept per scope + effect id. */
  scope: string
  effects: ResolvedEffect[]
  beat: number
}

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
  /** Effects for this layer; omitted or empty draws the clip directly. */
  fx?: FxPass | null
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
  private effectProgram: WebGLProgram | null = null
  private layerU: Uniforms = {}
  private masterU: Uniforms = {}
  private effectU: Uniforms = {}
  /** Shared ping-pong targets for effect chains, and feedback history per scope + effect. */
  private fxA: Target | null = null
  private fxB: Target | null = null
  private history = new Map<string, { cur: Target; next: Target; usedAt: number }>()
  private frameNo = 0
  /** The image the master pass shows (the composite, or the master chain's output). */
  private final: Target | null = null
  private masterTransform: MasterTransform = IDENTITY
  /** Effect passes drawn in the last frame (diagnostics). */
  passesLastFrame = 0
  private passes = 0
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
    this.effectProgram = compileProgram(gl, MASTER_VS, EFFECT_FS)
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
      'uFlipV',
      'uIsolated',
    ])
    this.masterU = locate(this.masterProgram, [
      'uSrc',
      'uBrightness',
      'uRes',
      'uScale',
      'uRot',
      'uOffset',
    ])
    this.effectU = locate(this.effectProgram, ['uSrc', 'uPrev', 'uRes', 'uType', 'uP', 'uBeat'])

    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
    // Both programs bind aCorner to location 0.
    for (const p of [this.layerProgram, this.masterProgram, this.effectProgram]) {
      const loc = gl.getAttribLocation(p, 'aCorner')
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    }
    gl.bindVertexArray(null)
    this.accum = this.dst = this.preview = this.fxA = this.fxB = this.final = null
    this.history.clear()
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

  /** Output options (letterbox, resolution) and the watchdog's render scale (0..1]. */
  private options: OutputOptions = DEFAULT_OUTPUT_OPTIONS
  private renderScale = 1
  private layout: PictureLayout = {
    viewport: { x: 0, y: 0, width: 1, height: 1 },
    render: { width: 1, height: 1 },
  }

  setOptions(options: OutputOptions): void {
    this.options = { ...options }
  }

  /** Render at a fraction of the normal size (graceful degradation). */
  setRenderScale(scale: number): void {
    this.renderScale = Math.min(1, Math.max(0.25, scale))
  }

  /** Make sure the accumulation targets match the picture's render size. */
  private ensureTargets(): boolean {
    if (!this.gl || this.lost) return false
    const l = pictureLayout(this.canvas.width, this.canvas.height, this.options)
    l.render.width = Math.max(1, Math.round(l.render.width * this.renderScale))
    l.render.height = Math.max(1, Math.round(l.render.height * this.renderScale))
    this.layout = l
    const { width, height } = l.render
    if (!this.accum || this.accum.width !== width || this.accum.height !== height) {
      for (const t of [this.accum, this.dst, this.fxA, this.fxB]) this.freeTarget(t)
      for (const h of this.history.values()) {
        this.freeTarget(h.cur)
        this.freeTarget(h.next)
      }
      this.history.clear()
      this.accum = this.makeTarget(width, height)
      this.dst = this.makeTarget(width, height)
      this.fxA = this.fxB = null
    }
    return true
  }

  get ready(): boolean {
    return !!this.gl && !this.lost
  }

  /** The picture's render size (the window size, unless letterboxed or capped). */
  get size(): { width: number; height: number } {
    return this.accum
      ? { width: this.accum.width, height: this.accum.height }
      : { width: this.canvas.width, height: this.canvas.height }
  }

  /** The output window's canvas size in device pixels. */
  get windowSize(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height }
  }

  /** Where the picture sits in the window (letterbox), device pixels, y down. */
  get viewport(): PictureLayout['viewport'] {
    return { ...this.layout.viewport }
  }

  /** Rough GPU memory held by render targets, bytes (diagnostics and the budget). */
  get targetBytes(): number {
    const t = [this.accum, this.dst, this.fxA, this.fxB, this.preview].filter(Boolean) as Target[]
    let n = t.reduce((a, x) => a + x.width * x.height * 4, 0)
    for (const h of this.history.values()) n += h.cur.width * h.cur.height * 4 * 2
    return n
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
    this.frameNo++
    this.passes = 0
    this.final = this.accum
    this.masterTransform = IDENTITY
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum!.fb)
    gl.viewport(0, 0, this.accum!.width, this.accum!.height)
    gl.disable(gl.BLEND)
    gl.clearColor(background[0], background[1], background[2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  /** Composite one clip onto the frame, through its effect chain if it has one. */
  drawLayer(texture: StageTexture, t: Transform, draw: LayerDraw): void {
    const gl = this.gl
    if (!gl || this.lost || !this.accum || !this.dst || t.w <= 0 || t.h <= 0 || draw.opacity <= 0)
      return
    const active = draw.fx ? draw.fx.effects.filter(effectIsActive) : []
    if (active.length === 0) {
      this.composite(texture.tex, t, draw.opacity, draw.blend, draw.key, false)
      return
    }
    // Draw the keyed clip alone onto a transparent full-size image, run the chain over it,
    // then composite the result like any layer.
    const { width, height } = this.accum
    const fxA = this.fxTargets()[0]
    gl.bindFramebuffer(gl.FRAMEBUFFER, fxA.fb)
    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.quad(texture.tex, t, 1, 'normal', draw.key, false, true)
    const out = this.runChain(fxA, active, draw.fx!.scope, draw.fx!.beat)
    const full: Transform = { cx: width / 2, cy: height / 2, w: width, h: height, rotation: 0 }
    this.composite(out.tex, full, draw.opacity, draw.blend, null, true)
  }

  private fxTargets(): [Target, Target] {
    const { width, height } = this.accum!
    this.fxA ??= this.makeTarget(width, height)
    this.fxB ??= this.makeTarget(width, height)
    return [this.fxA, this.fxB]
  }

  /** Run effects over `src`, ping-ponging between the shared targets. Returns the result. */
  private runChain(src: Target, effects: ResolvedEffect[], scope: string, beat: number): Target {
    const [fxA, fxB] = this.fxTargets()
    let cur = src
    for (const fx of effects) {
      if (fx.type === 'feedback') {
        const key = `${scope}/${fx.id}`
        // Over the GPU memory budget: new trails are skipped (existing ones keep running).
        if (!this.history.has(key) && this.history.size >= Stage.MAX_HISTORY) continue
        const h = this.historyFor(key)
        this.effectPass(cur, h.cur, h.next, fx, beat)
        const written = h.next
        h.next = h.cur
        h.cur = written
        cur = written
      } else {
        const out = cur === fxA ? fxB : fxA
        this.effectPass(cur, null, out, fx, beat)
        cur = out
      }
    }
    return cur
  }

  /** Feedback history pairs allowed at once (GPU memory budget: 2 full-size targets each). */
  static readonly MAX_HISTORY = 6

  private historyFor(key: string): { cur: Target; next: Target; usedAt: number } {
    let h = this.history.get(key)
    if (!h) {
      const { width, height } = this.accum!
      h = { cur: this.makeTarget(width, height), next: this.makeTarget(width, height), usedAt: 0 }
      // Start from transparent black.
      const gl = this.gl!
      for (const t of [h.cur, h.next]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
      }
      this.history.set(key, h)
    }
    h.usedAt = this.frameNo
    return h
  }

  private effectPass(
    src: Target,
    prev: Target | null,
    out: Target,
    fx: ResolvedEffect,
    beat: number,
  ): void {
    const gl = this.gl!
    const u = this.effectU
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb)
    gl.viewport(0, 0, out.width, out.height)
    gl.disable(gl.BLEND)
    gl.useProgram(this.effectProgram)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, src.tex)
    gl.uniform1i(u.uSrc!, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, (prev ?? src).tex)
    gl.uniform1i(u.uPrev!, 1)
    gl.uniform2f(u.uRes!, out.width, out.height)
    gl.uniform1i(u.uType!, EFFECT_INDEX[fx.type])
    const v = EFFECT_DEFS[fx.type].params.map((s) => fx.params[s.name] ?? s.default)
    gl.uniform4f(u.uP!, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0)
    // Wrapped to keep float precision; 256 beats is a whole number of every strobe/shake cycle.
    // Wrapped at 768 beats (2^8 x 3), so beat counts like 3 or 6 also stay seamless.
    gl.uniform1f(u.uBeat!, ((beat % BEAT_WRAP) + BEAT_WRAP) % BEAT_WRAP)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
    gl.activeTexture(gl.TEXTURE0)
    this.passes++
  }

  /** Blend a texture onto the composite (snapshotting it first so the shader can read it). */
  private composite(
    tex: WebGLTexture,
    t: Transform,
    opacity: number,
    blend: BlendMode,
    key: KeySettings | null,
    flipV: boolean,
  ): void {
    const gl = this.gl!
    const { width, height } = this.accum!
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.accum!.fb)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.dst!.fb)
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum!.fb)
    gl.viewport(0, 0, width, height)
    this.quad(tex, t, opacity, blend, key, flipV, false)
  }

  /** Draw a transformed quad with the layer shader into the bound framebuffer. */
  private quad(
    tex: WebGLTexture,
    t: Transform,
    opacity: number,
    blend: BlendMode,
    k: KeySettings | null,
    flipV: boolean,
    isolated: boolean,
  ): void {
    const gl = this.gl!
    const { width, height } = this.accum!
    const u = this.layerU
    gl.useProgram(this.layerProgram)
    gl.bindVertexArray(this.vao)
    gl.disable(gl.BLEND)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(u.uTex!, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.dst!.tex)
    gl.uniform1i(u.uDst!, 1)
    gl.uniform2f(u.uCenter!, t.cx, t.cy)
    gl.uniform2f(u.uSize!, t.w, t.h)
    gl.uniform1f(u.uRotation!, t.rotation)
    gl.uniform2f(u.uTarget!, width, height)
    gl.uniform1f(u.uOpacity!, Math.min(1, Math.max(0, opacity)))
    gl.uniform1i(u.uBlend!, BLEND_INDEX[blend])
    gl.uniform1i(u.uFlipV!, flipV ? 1 : 0)
    gl.uniform1i(u.uIsolated!, isolated ? 1 : 0)
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
    x = 0,
    y = 0,
  ): void {
    const gl = this.gl!
    const src = this.final ?? this.accum!
    const m = this.masterTransform
    gl.bindFramebuffer(gl.FRAMEBUFFER, target)
    gl.viewport(x, y, width, height)
    gl.disable(gl.BLEND)
    gl.useProgram(this.masterProgram)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, src.tex)
    const u = this.masterU
    gl.uniform1i(u.uSrc!, 0)
    gl.uniform1f(u.uBrightness!, brightness)
    gl.uniform2f(u.uRes!, src.width, src.height)
    gl.uniform1f(u.uScale!, Math.max(0.05, 1 + m.scale))
    gl.uniform1f(u.uRot!, (m.rotationDeg * Math.PI) / 180)
    // Screen y points down; GL texture y points up.
    gl.uniform2f(u.uOffset!, m.x, -m.y)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
  }

  /**
   * Finish the frame: run the master effect chain, then draw to the screen at `brightness`
   * (0 = black) with the master transform.
   */
  endFrame(
    brightness: number,
    fx: FxPass | null = null,
    transform: MasterTransform = IDENTITY,
  ): void {
    if (!this.gl || this.lost || !this.accum) return
    const active = fx ? fx.effects.filter(effectIsActive) : []
    // Letterboxing: everything outside the picture is black.
    const v = this.layout.viewport
    const letterboxed =
      v.x > 0 || v.y > 0 || v.width < this.canvas.width || v.height < this.canvas.height
    this.final =
      active.length > 0 ? this.runChain(this.accum, active, fx!.scope, fx!.beat) : this.accum
    this.masterTransform = transform
    if (letterboxed) {
      const gl = this.gl
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, this.canvas.width, this.canvas.height)
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    this.master(null, v.width, v.height, brightness, v.x, this.canvas.height - v.y - v.height)
    this.passesLastFrame = this.passes
    // Drop feedback history that no chain used recently.
    for (const [key, h] of this.history) {
      if (this.frameNo - h.usedAt > 2) {
        this.freeTarget(h.cur)
        this.freeTarget(h.next)
        this.history.delete(key)
      }
    }
  }

  /** Feedback history buffers currently allocated (diagnostics). */
  get historyCount(): number {
    return this.history.size
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

  /** Read the shown picture at fractional position (fx, fy) inside the letterbox. */
  readPicturePixel(fx: number, fy: number): [number, number, number, number] | null {
    const v = this.layout.viewport
    return this.readPixel(v.x + fx * (v.width - 1), v.y + fy * (v.height - 1))
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
