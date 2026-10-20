import type { EffectType } from '@shared/fx'

/**
 * One full-screen pass per effect. Input and output are premultiplied RGBA textures the size
 * of the output, in GL orientation (vUv origin bottom-left). Layer chains run on a transparent
 * image of just that layer; the master chain runs on the opaque composite.
 */

export const EFFECT_INDEX: Record<EffectType, number> = {
  strobe: 0,
  rgbSplit: 1,
  kaleidoscope: 2,
  mirror: 3,
  pixelate: 4,
  zoomBump: 5,
  shake: 6,
  invert: 7,
  hueRotate: 8,
  feedback: 9,
}

export const EFFECT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform sampler2D uPrev;      // feedback history
uniform vec2 uRes;            // px
uniform int uType;
uniform vec4 uP;              // parameters in EFFECT_DEFS order
uniform float uBeat;          // beat position (wrapped)
out vec4 outColor;

const float PI = 3.14159265;

float hash(float n) { return fract(sin(n * 12.9898 + 78.233) * 43758.5453); }

vec4 sampleInside(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture(uSrc, uv);
}

vec3 hueRotate(vec3 c, float deg) {
  // Rotate the chroma plane in YIQ.
  const mat3 toYiq = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  const mat3 toRgb = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 yiq = toYiq * c;
  float a = radians(deg), s = sin(a), co = cos(a);
  yiq.yz = vec2(yiq.y * co - yiq.z * s, yiq.y * s + yiq.z * co);
  return clamp(toRgb * yiq, 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;
  float aspect = uRes.x / uRes.y;
  vec4 c = texture(uSrc, uv);
  float amt = uP.x;

  if (uType == 0) {                       // strobe / flash
    float on = uP.y > 0.0 ? 1.0 - step(uP.z, fract(uBeat * uP.y)) : 1.0;
    vec3 to = uP.w > 0.5 ? vec3(0.0) : vec3(c.a);
    outColor = vec4(mix(c.rgb, to, amt * on), c.a);
  } else if (uType == 1) {                // RGB split
    float a = radians(uP.y);
    vec2 off = vec2(cos(a) / aspect, sin(a)) * amt;
    vec4 r = texture(uSrc, uv + off), b = texture(uSrc, uv - off);
    outColor = vec4(r.r, c.g, b.b, max(c.a, max(r.a, b.a)));
  } else if (uType == 2) {                // kaleidoscope
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
    float rot = radians(uP.z);
    float seg = 2.0 * PI / max(2.0, floor(uP.y + 0.5));
    float ang = mod(atan(p.y, p.x) - rot, seg);
    ang = min(ang, seg - ang) + rot;
    vec2 k = vec2(cos(ang), sin(ang)) * length(p);
    vec4 kc = sampleInside(k / vec2(aspect, 1.0) + 0.5);
    outColor = mix(c, kc, amt);
  } else if (uType == 3) {                // mirror
    int mode = int(uP.y + 0.5);
    vec2 m = uv;
    if (mode != 1 && m.x > 0.5) m.x = 1.0 - m.x;        // left half reflected onto the right
    if (mode != 0 && m.y < 0.5) m.y = 1.0 - m.y;        // top half reflected onto the bottom
    outColor = mix(c, texture(uSrc, m), amt);
  } else if (uType == 4) {                // pixelate
    vec2 block = vec2(max(1.0, amt)) / uRes;
    outColor = texture(uSrc, (floor(uv / block) + 0.5) * block);
  } else if (uType == 5) {                // zoom bump
    outColor = sampleInside(0.5 + (uv - 0.5) / (1.0 + amt));
  } else if (uType == 6) {                // shake: a new random offset every 1/speed beats
    float s = floor(uBeat * uP.y);
    vec2 off = (vec2(hash(s), hash(s + 7.13)) - 0.5) * 2.0 * amt * vec2(1.0 / aspect, 1.0);
    // Zoom in a little so the moved edges stay covered.
    outColor = sampleInside(0.5 + (uv - 0.5) / (1.0 + 2.5 * amt) + off);
  } else if (uType == 7) {                // invert (premultiplied: a - rgb)
    outColor = vec4(mix(c.rgb, vec3(c.a) - c.rgb, amt), c.a);
  } else if (uType == 8) {                // hue rotate
    vec3 straight = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
    outColor = vec4(hueRotate(straight, amt) * c.a, c.a);
  } else {                                // feedback / trails: lighten over the decayed past
    // The small bias makes trails fade out fully instead of sticking at an 8-bit residue
    // (round(v * 0.98) == v for small v).
    vec4 prev = max(texture(uPrev, 0.5 + (uv - 0.5) * (1.0 - uP.y)) * amt - 1.0 / 255.0, 0.0);
    // Lighten (per-channel max) works for transparent layers and the opaque master alike.
    outColor = max(c, prev);
  }
}`
