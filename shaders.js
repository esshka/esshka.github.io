/*
  /Users/esshka/hireme/shaders.js
  GLSL for the black hole: the lensed scene (HDR), the bloom chain, and the
  final tone-mapped composite. Units: G = c = M = 1, angles in radians.
  RELEVANT FILES: webgl.js, bloom.js, blackhole/src/lensing.rs
*/

// Fullscreen triangle from gl_VertexID: no vertex buffer at all.
export const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FINISH = `
const float EXPOSURE = 1.1;

// Exponential tone map, then interleaved-gradient-noise dither so the dark
// sky does not band in 8-bit output.
vec3 finish(vec3 hdr, float fade) {
  vec3 col = vec3(1.0) - exp(-hdr * EXPOSURE);
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  return (col + (ign - 0.5) / 255.0) * fade;
}`;

const SCENE_FS = `
precision highp float;
uniform sampler2D uLut;     // 2u over (phi, alpha): where each ray is along its orbit
uniform sampler2D uDeflect; // extra orbit angle per alpha; < 0 means the ray falls in
uniform sampler2D uHeat;    // gas density over (theta, r), streamed from wasm each frame
uniform vec2 uCenter;
uniform float uFocal;
uniform float uRoll;
uniform vec3 uCamPos;
uniform vec3 uFwd;
uniform vec3 uRight;
uniform vec3 uUp;
uniform float uAlphaMax;
uniform float uAlphaCrit;
uniform float uPhiMax;
uniform float uRIn;
uniform float uROut;
uniform vec3 uWarm;
uniform vec3 uHot;
uniform float uNebula;
uniform float uFade;
out vec4 outColor;

const float PI = 3.14159265;
const float TAU = 6.28318531;

const float DISK_EXPOSURE = 1.8;
const float DISK_BASE_OPACITY = 0.35;  // thin gas still veils what is behind
const float DISK_GAS_OPACITY = 0.9;
const float DISK_MAX_OPACITY = 0.97;
const float GAS_FLOOR = 0.25;          // brightness where the heat map is empty
const float GAS_GAIN = 1.6;
const float INNER_EDGE_SOFTNESS = 0.6; // M
const float OUTER_FADE = 4.0;          // M
const float NT_PEAK_NORM = 2.05;       // scales the Novikov-Thorne profile's peak to 1
const vec2 TEMP_WARM_TO_HOT = vec2(0.25, 1.1);
const vec2 TEMP_TO_WHITE = vec2(1.0, 1.8);
// Bolometric beaming is g^4; g^3 keeps the receding side of the disk visible.
const float BEAMING_POWER = 3.0;
const float PHI_STEP = 0.01;           // finite difference for the photon direction

const float RING_WIDTH_PX = 2.5;
const float RING_GLOW = 0.5;
const float HALO_GLOW = 0.06;
const float HALO_FALLOFF = 25.0;

const float STAR_SIZE_PX = 0.9;
const float MAX_MAGNIFICATION = 6.0;
const float UNRESOLVED_GLOW = 0.015;   // average light of stars too dense to resolve

float lutU(float alpha, float phi) {
  float cols = float(textureSize(uLut, 0).x);
  float s = (phi / uPhiMax * (cols - 1.0) + 0.5) / cols;
  return texture(uLut, vec2(s, alpha / uAlphaMax)).r;
}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x),
        mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x),
        mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

// Noise that fades to its mean once its features shrink below a pixel.
float filteredNoise(vec3 dir, float freq, float footprint) {
  return mix(noise3(dir * freq), 0.5, smoothstep(0.3, 1.0, footprint * freq));
}

// Screen-pixel offset that moves the sky direction by delta: least-squares
// inverse of the lens Jacobian [jx jy] (sky change per pixel in x and y).
vec2 toScreen(vec3 delta, vec3 jx, vec3 jy) {
  float a = dot(jx, jx);
  float b = dot(jx, jy);
  float c = dot(jy, jy);
  vec2 rhs = vec2(dot(jx, delta), dot(jy, delta));
  return vec2(c * rhs.x - b * rhs.y, a * rhs.y - b * rhs.x) / max(a * c - b * b, 1e-30);
}

// One star per occupied 3D cell, projected onto the sky sphere. A lensed star
// is still a point, so it is measured in screen pixels through the Jacobian:
// lensing moves it and scales its flux (unlensed / lensed pixel area), but
// never smears it into an arc.
vec3 starLayer(vec3 dir, float scale, float density, vec3 jx, vec3 jy, float footprint, float pixel) {
  float resolved = 1.0 - smoothstep(0.35, 0.9, footprint * scale);
  vec3 cell = floor(dir * scale);
  vec3 h = hash33(cell);
  vec3 tint = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.85, 0.7), h.z);
  vec3 haze = tint * density * UNRESOLVED_GLOW * (1.0 - resolved);
  if (h.x > density || resolved <= 0.0) return haze;

  vec3 star = normalize(cell + hash33(cell + 17.0));
  vec2 s = toScreen(star - dir, jx, jy) / STAR_SIZE_PX;
  float magnification = min(pixel * pixel / max(length(cross(jx, jy)), 1e-30), MAX_MAGNIFICATION);
  return tint * exp(-dot(s, s)) * (0.4 + 1.6 * h.y * h.y) * magnification * resolved + haze;
}

vec3 sky(vec3 dir, vec3 jx, vec3 jy, float pixel) {
  float footprint = max(max(length(jx), length(jy)), 1e-5);
  vec3 col = starLayer(dir, 70.0, 0.12, jx, jy, footprint, pixel) * 1.3
           + starLayer(dir, 220.0, 0.1, jx, jy, footprint, pixel) * 0.7;
  if (uNebula > 0.5) {
    float band = exp(-abs(dot(dir, normalize(vec3(0.3, 1.0, -0.4)))) * 5.0);
    float n = filteredNoise(dir, 3.0, footprint) * 0.6
            + filteredNoise(dir, 7.0, footprint) * 0.3
            + filteredNoise(dir, 15.0, footprint) * 0.1;
    col += mix(vec3(0.05, 0.07, 0.16), vec3(0.16, 0.06, 0.18), n) * band * n * 0.9;
  }
  return col;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - uCenter) / uFocal;
  float cr = cos(uRoll);
  float sr = sin(uRoll);
  uv = mat2(cr, sr, -sr, cr) * uv;
  vec3 d = normalize(uFwd + uv.x * uRight + uv.y * uUp);

  // The ray's orbit plane holds the hole and the camera. In it, the photon sits
  // at r(phi) * (cos(phi) e1 + sin(phi) e2), starting from the camera at phi = 0.
  vec3 e1 = normalize(uCamPos);
  vec3 n = cross(e1, d);
  float sinA = length(n);
  float alpha = atan(sinA, dot(d, -e1));
  n = sinA > 1e-6 ? n / sinA : vec3(0.0, 0.0, 1.0);
  vec3 e2 = cross(n, e1);

  // Escape direction and its screen-space derivatives. Derivatives need
  // uniform control flow, so this runs for every pixel, captured or not.
  float deflect = texture(uDeflect, vec2(min(alpha, uAlphaMax) / uAlphaMax, 0.5)).r;
  float phiEsc = PI - alpha + deflect;
  vec3 dirOut = cos(phiEsc) * e1 + sin(phiEsc) * e2;
  vec3 jx = dFdx(dirOut);
  vec3 jy = dFdy(dirOut);

  vec3 col = vec3(0.0);
  float trans = 1.0;

  // The disk is the y = 0 plane; the orbit crosses it every PI of phi.
  vec3 node = cross(n, vec3(0.0, 1.0, 0.0));
  float phi0 = mod(atan(dot(node, e2), dot(node, e1)), PI);
  for (int k = 0; k < 4; k++) {
    float phi = phi0 + float(k) * PI;
    if (phi >= uPhiMax || trans < 0.02) break;
    float un = lutU(alpha, phi);
    if (un < 1e-4) break; // already escaped to infinity
    float r = 2.0 / un;
    if (r < uRIn || r > uROut) continue;

    vec3 er = cos(phi) * e1 + sin(phi) * e2;
    vec3 ephi = -sin(phi) * e1 + cos(phi) * e2;
    vec3 P = r * er;
    // Coordinate-basis direction, not the local static frame's: the metric's
    // radial stretch shifts it slightly, which the eye cannot see here.
    float dun = (lutU(alpha, phi + PHI_STEP) - lutU(alpha, phi - PHI_STEP)) / (2.0 * PHI_STEP);
    vec3 toCamera = -normalize(-2.0 * dun / (un * un) * er + r * ephi);

    // Doppler + gravitational shift of a circular orbit, seen by a static observer.
    float beta = inversesqrt(r - 2.0);
    vec3 vdir = normalize(vec3(-P.z, 0.0, P.x));
    float g = sqrt(1.0 - 3.0 / r) / (1.0 - beta * dot(vdir, toCamera));

    float gas = texture(uHeat, vec2(atan(P.z, P.x) / TAU, (r - uRIn) / (uROut - uRIn))).r;
    float x = uRIn / r;
    float temp = pow(x, 0.75) * pow(max(1.0 - sqrt(x), 0.0), 0.25) * NT_PEAK_NORM;
    float t = temp * g;

    vec3 base = mix(uWarm, uHot, smoothstep(TEMP_WARM_TO_HOT.x, TEMP_WARM_TO_HOT.y, t));
    base = mix(base, vec3(1.0), smoothstep(TEMP_TO_WHITE.x, TEMP_TO_WHITE.y, t));
    float intensity = pow(g, BEAMING_POWER) * temp * (GAS_FLOOR + GAS_GAIN * gas);
    float edge = smoothstep(uRIn, uRIn + INNER_EDGE_SOFTNESS, r)
               * (1.0 - smoothstep(uROut - OUTER_FADE, uROut, r));
    float a = clamp(DISK_BASE_OPACITY + gas * DISK_GAS_OPACITY, 0.0, DISK_MAX_OPACITY) * edge;

    col += trans * a * base * intensity * DISK_EXPOSURE;
    trans *= 1.0 - a;
  }

  float ring = alpha - uAlphaCrit;
  col += trans * uHot * (exp(-abs(ring) * uFocal / RING_WIDTH_PX) * RING_GLOW
                       + step(0.0, ring) * exp(-ring * HALO_FALLOFF) * HALO_GLOW);

  if (deflect > -0.5 && trans > 0.01) {
    col += trans * sky(dirOut, jx, jy, 1.0 / uFocal);
  }

#ifdef DIRECT_OUTPUT
  outColor = vec4(finish(col, uFade), 1.0);
#else
  outColor = vec4(col, 1.0);
#endif
}`;

// Without float render targets there is no bloom; the scene tone-maps itself.
export function sceneFS(directOutput) {
  return `#version 300 es\n${directOutput ? '#define DIRECT_OUTPUT\n' : ''}${SCENE_FS.replace('out vec4 outColor;', `out vec4 outColor;\n${FINISH}`)}`;
}

// Dual-filter bloom (Bjørge, SIGGRAPH 2015): cheap wide blur via a mip chain.
export const BLOOM_DOWN_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;
uniform vec2 uInvDst;
uniform float uKaris; // 1 on the first pass: luma-weighting stops single bright pixels flickering
out vec4 outColor;

vec3 tap(vec2 uv, inout float wsum) {
  vec3 c = texture(uSrc, uv).rgb;
  float w = mix(1.0, 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))), uKaris);
  wsum += w;
  return c * w;
}

void main() {
  vec2 uv = gl_FragCoord.xy * uInvDst;
  vec2 h = uSrcTexel;
  float wsum = 0.0;
  vec3 s = tap(uv, wsum) * 4.0;
  wsum *= 4.0;
  s += tap(uv - h, wsum);
  s += tap(uv + h, wsum);
  s += tap(uv + vec2(h.x, -h.y), wsum);
  s += tap(uv - vec2(h.x, -h.y), wsum);
  outColor = vec4(s / wsum, 1.0);
}`;

export const BLOOM_UP_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;
uniform vec2 uInvDst;
out vec4 outColor;

void main() {
  vec2 uv = gl_FragCoord.xy * uInvDst;
  vec2 h = uSrcTexel;
  vec3 s = texture(uSrc, uv + vec2(-2.0 * h.x, 0.0)).rgb
         + texture(uSrc, uv + vec2(2.0 * h.x, 0.0)).rgb
         + texture(uSrc, uv + vec2(0.0, -2.0 * h.y)).rgb
         + texture(uSrc, uv + vec2(0.0, 2.0 * h.y)).rgb
         + (texture(uSrc, uv + vec2(-h.x, h.y)).rgb
          + texture(uSrc, uv + vec2(h.x, h.y)).rgb
          + texture(uSrc, uv + vec2(h.x, -h.y)).rgb
          + texture(uSrc, uv + vec2(-h.x, -h.y)).rgb) * 2.0;
  outColor = vec4(s / 12.0, 1.0);
}`;

export const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uInvDst;
uniform float uBloomNorm; // 1 / level count: each upsample pass adds a full copy
uniform float uFade;
out vec4 outColor;

// A lerp, not an add: bloom redistributes energy instead of inventing it.
const float BLOOM_MIX = 0.2;
${FINISH}

void main() {
  vec2 uv = gl_FragCoord.xy * uInvDst;
  vec3 scene = texture(uScene, uv).rgb;
  vec3 bloom = texture(uBloom, uv).rgb * uBloomNorm;
  outColor = vec4(finish(mix(scene, bloom, BLOOM_MIX), uFade), 1.0);
}`;
