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
  pulse: 10,
  fold: 11,
  bounce: 12,
  pixelSpin: 13,
  wave: 14,
  slice: 15,
  twirl: 16,
  mystify: 17,
}

/** uBeat wraps here; every beat count the effects offer divides it. */
export const BEAT_WRAP = 768

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

// Mystify: two four-cornered shapes. Corner start points and directions (uv units); the test
// suite mirrors these numbers.
const vec2 MY_P0[8] = vec2[8](
  vec2(0.15, 0.2), vec2(0.8, 0.1), vec2(0.9, 0.75), vec2(0.2, 0.9),
  vec2(0.4, 0.3), vec2(0.7, 0.35), vec2(0.6, 0.8), vec2(0.3, 0.65));
const vec2 MY_V[8] = vec2[8](
  vec2(0.9, 0.55), vec2(-0.6, 0.8), vec2(-0.75, -0.5), vec2(0.55, -0.9),
  vec2(-0.85, 0.6), vec2(0.7, 0.75), vec2(0.6, -0.8), vec2(-0.5, -0.7));
const float MY_TRAIL_GAP = 0.25;   // beats between trail copies

// Bounce between the edges: a triangle wave folded into 0.03..0.97.
vec2 bounceIn(vec2 a) { return 0.03 + 0.94 * (1.0 - abs(mod(a, 2.0) - 1.0)); }

vec3 hsv(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(p - a - ab * t);
}

// Position within a cycle of n beats, 0..1 (n > 0).
float cyc(float n) { return fract(uBeat / n); }

// Brighten premultiplied color without going past its alpha.
vec4 brighten(vec4 c, float k) { return vec4(min(c.rgb * k, vec3(c.a)), c.a); }

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
  } else if (uType == 10) {               // pulse: swell on the beat, then ease back
    float env = pow(1.0 - cyc(uP.y), uP.w);
    vec4 s = sampleInside(0.5 + (uv - 0.5) / (1.0 + amt * env));
    outColor = brighten(s, 1.0 + uP.z * env);
  } else if (uType == 11) {               // fold: one half hinges over onto the other
    // Shut (as far as amount allows) on the beat, open again halfway through the cycle.
    float theta = PI * amt * (0.5 + 0.5 * cos(2.0 * PI * cyc(uP.y)));
    float ct = cos(theta);
    bool up = uP.z > 0.5;
    float n = max(1.0, floor(uP.w + 0.5));
    // t runs along the fold (left to right, or top to bottom); each panel folds its second half.
    float t = up ? 1.0 - uv.y : uv.x;
    float tile = floor(t * n);
    float u = fract(t * n);
    vec4 base = vec4(0.0), flap = vec4(0.0);
    float shade = 1.0;
    float src = -1.0;
    if (u < 0.5) {
      base = texture(uSrc, uv);
      // Folded past upright, the back of the flap lies over this half.
      if (ct < 0.0) {
        float w = (0.5 - u) / max(-ct, 1e-4);
        if (w <= 0.5) { src = 0.5 + w; shade = 0.55 + 0.25 * -ct; }
      }
    } else if (ct > 0.0) {
      float w = (u - 0.5) / max(ct, 1e-4);
      if (w <= 0.5) { src = 0.5 + w; shade = 1.0 - 0.45 * sin(theta); }
    }
    if (src >= 0.0) {
      float ts = (tile + src) / n;
      vec2 suv = up ? vec2(uv.x, 1.0 - ts) : vec2(ts, uv.y);
      flap = texture(uSrc, suv);
      flap.rgb *= shade;
    }
    outColor = flap + base * (1.0 - flap.a);
  } else if (uType == 12) {               // bounce: lands on the beat, squashes, flies up
    float f = cyc(uP.y);
    float h = amt * 4.0 * f * (1.0 - f);
    float k = max(0.0, 1.0 - f * 6.0);
    float sq = uP.z * k * k;
    vec2 scale = vec2(1.0 + 0.6 * sq, 1.0 - sq);
    // Anchored at the bottom edge (GL y is up).
    vec2 s = vec2(0.5 + (uv.x - 0.5) / scale.x, (uv.y - h) / scale.y);
    outColor = sampleInside(s);
  } else if (uType == 13) {               // pixel spin: a wave of spinning tiles, back and forth
    float size = max(2.0, uP.y);
    float w = max(0.01, uP.w);
    float ph = cyc(2.0 * uP.z);
    float front = 1.0 - abs(2.0 * ph - 1.0);           // 0 to 1 and back, one sweep per cycle
    float pos = -w + front * (1.0 + 2.0 * w);           // starts and ends off the picture
    vec2 px = uv * uRes;
    vec2 center = (floor(px / size) + 0.5) * size;
    float k = smoothstep(0.0, 1.0, clamp(1.0 - abs(center.x / uRes.x - pos) / w, 0.0, 1.0));
    if (k <= 0.0 || amt <= 0.0) {
      outColor = c;
    } else {
      float a = 2.0 * PI * amt * k;
      float sc = 1.0 - 0.3 * k;
      vec2 l = px - center;
      vec2 r = mat2(cos(a), -sin(a), sin(a), cos(a)) * l / sc;
      outColor = max(abs(r.x), abs(r.y)) > size * 0.5
        ? vec4(0.0)
        : texture(uSrc, (center + r) / uRes);
    }
  } else if (uType == 14) {               // wave: a ripple rolls out from the middle on the beat
    float f = cyc(uP.y);
    float env = pow(1.0 - f, uP.w);
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
    float r = length(p);
    // The ring pattern travels outward through each cycle.
    float d = amt * env * sin(2.0 * PI * (r * uP.z - f * 2.0));
    vec2 dir = r > 1e-5 ? p / r : vec2(0.0);
    outColor = sampleInside(uv + dir * d / vec2(aspect, 1.0));
  } else if (uType == 15) {               // slice: strips slide apart on the beat
    float f = cyc(uP.y);
    float env = pow(1.0 - f, uP.w);
    float n = max(2.0, floor(uP.z + 0.5));
    float strip = floor(uv.y * n);
    // Neighbouring strips go opposite ways, and every cycle swaps them.
    float side = mod(strip, 2.0) < 0.5 ? 1.0 : -1.0;
    float flip = mod(floor(uBeat / uP.y), 2.0) < 0.5 ? 1.0 : -1.0;
    outColor = sampleInside(vec2(uv.x - amt * env * side * flip, uv.y));
  } else if (uType == 16) {               // twirl: twist the middle on the beat, then unwind
    float f = cyc(uP.y);
    float env = pow(1.0 - f, uP.w);
    float dirn = mod(floor(uBeat / uP.y), 2.0) < 0.5 ? 1.0 : -1.0;
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
    float r = length(p);
    float k = max(0.0, 1.0 - r / max(uP.z, 0.01));
    float a = 2.0 * PI * amt * env * k * k * dirn;
    vec2 q = mat2(cos(a), sin(a), -sin(a), cos(a)) * p;
    outColor = sampleInside(q / vec2(aspect, 1.0) + 0.5);
  } else if (uType == 17) {               // Mystify lines
    float b = uBeat;
    float fb = fract(b);
    // Beat punch: most of each beat's travel happens right after the beat.
    float eased = 1.0 - pow(1.0 - fb, 3.0);
    float tNow = floor(b) + mix(fb, eased, uP.w);
    float trails = max(1.0, floor(uP.y + 0.5));
    vec2 px = uv * uRes;
    float halfW = max(1.5, uRes.y / 400.0);
    float flash = 1.0 + 0.5 * pow(1.0 - fb, 4.0);
    vec3 add = vec3(0.0);
    float cover = 0.0;
    for (int k = 0; k < 8; k++) {
      if (float(k) >= trails) break;
      float t = tNow - float(k) * MY_TRAIL_GAP;
      float fade = 1.0 - float(k) / trails;
      for (int s = 0; s < 2; s++) {
        vec2 v[4];
        for (int i = 0; i < 4; i++) {
          int j = s * 4 + i;
          v[i] = bounceIn(MY_P0[j] + MY_V[j] * uP.z * t) * uRes;
        }
        float d = 1e9;
        for (int i = 0; i < 4; i++) d = min(d, segDist(px, v[i], v[(i + 1) % 4]));
        float line = smoothstep(halfW, halfW * 0.3, d) * fade;
        vec3 col = hsv(fract(0.02 * b + 0.5 * float(s))) * flash;
        add = max(add, col * line);
        cover = max(cover, line);
      }
    }
    add = min(add * amt, vec3(1.0));
    // Screen the lines over the picture (premultiplied).
    outColor = vec4(c.rgb + add - c.rgb * add, max(c.a, cover * amt));
  } else {                                // feedback / trails: lighten over the decayed past
    // The small bias makes trails fade out fully instead of sticking at an 8-bit residue
    // (round(v * 0.98) == v for small v).
    vec4 prev = max(texture(uPrev, 0.5 + (uv - 0.5) * (1.0 - uP.y)) * amt - 1.0 / 255.0, 0.0);
    // Lighten (per-channel max) works for transparent layers and the opaque master alike.
    outColor = max(c, prev);
  }
}`
