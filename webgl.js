/*
  /Users/esshka/hireme/webgl.js
  Neon trench-run WebGL scene with adaptive quality tiers
  RELEVANT FILES: index.html, styles.css
*/

(() => {
  const canvas = document.getElementById('canyon');
  const noop = () => {};

  if (!canvas) {
    window.pauseWebGL = noop;
    window.resumeWebGL = noop;
    return;
  }

  const QUALITY_ORDER = ['low', 'medium', 'high'];
  // resScale: fraction of device pixels actually rendered. This scene is fragment-bound
  // (fullscreen procedural noise), so shrinking the backing store is the cheapest lever.
  // triplanar: three noise projections vs one — roughly a 3x fragment cost difference.
  const QUALITY_PROFILES = {
    high: {
      segments: 72,
      stars: 220,
      fbmOctaves: 4,
      laneGlow: true,
      heatDistortion: true,
      lanePulseSpeed: 1.0,
      resScale: 1.0,
      triplanar: true,
    },
    medium: {
      segments: 52,
      stars: 120,
      fbmOctaves: 3,
      laneGlow: true,
      heatDistortion: false,
      lanePulseSpeed: 0.9,
      resScale: 0.85,
      triplanar: false,
    },
    low: {
      segments: 32,
      stars: 60,
      fbmOctaves: 2,
      laneGlow: false,
      heatDistortion: false,
      lanePulseSpeed: 0.8,
      resScale: 0.7,
      triplanar: false,
    },
  };

  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const MOTION_SCALE = REDUCED_MOTION ? 0.6 : 1.0;

  let gl = null;
  let animationId = null;
  let isPaused = false;
  let contextLost = false;
  let hasFallback = false;

  let mouseX = 0;
  let mouseY = 0;
  let targetMouseX = 0;
  let targetMouseY = 0;

  let qualityKey = pickInitialQuality();
  let quality = QUALITY_PROFILES[qualityKey];

  let frameMsEma = 16.67;
  let slowFrameStreak = 0;
  let fastFrameStreak = 0;
  let perfElapsedMs = 0;

  let prevTimeMs = performance.now();
  let time = 0;

  let shipPos = { x: 0, y: 0.52, z: -5.5 };
  let shipVel = { x: 0, y: 0 };
  let shipRot = { x: 0, y: 0, z: 0 };
  let targetRot = { x: 0, y: 0, z: 0 };
  let camOffset = { x: 0, y: 0.42 };
  let camVel = { x: 0, y: 0 };
  let camTilt = { x: 0, y: 0 };

  const TRENCH_FLOOR_Y = 0.0;
  const FLOOR_BREATHE_AMPLITUDE = 0.06;
  const SHIP_HALF_HEIGHT = 0.16;
  const SHIP_CLEARANCE = 0.22;
  const SHIP_MIN_Y_BASE = TRENCH_FLOOR_Y + FLOOR_BREATHE_AMPLITUDE + SHIP_HALF_HEIGHT + SHIP_CLEARANCE;
  const SHIP_MAX_Y = 2.95;
  const CAMERA_MIN_Y = TRENCH_FLOOR_Y + 0.42;
  const CAMERA_MAX_Y = 0.95;

  let starfieldModule = null;
  let canyonModule = null;
  let shipModule = null;
  const drawState = {
    time: 0,
    dt: 0,
    camOffset: null,
    camTilt: null,
    motionScale: MOTION_SCALE,
    profile: null,
    qualityKey: 'high',
    shipPos: null,
    shipRot: null,
    lanePulse: 0,
    shipThrust: 0,
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const withDeadzone = (value, zone) => {
    const abs = Math.abs(value);
    if (abs < zone) return 0;
    return Math.sign(value) * ((abs - zone) / (1 - zone));
  };
  const shapeInput = (value, power) => Math.sign(value) * Math.pow(Math.abs(value), power);

  function pickInitialQuality() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    const maxDim = Math.max(width, height);
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints || 0) > 0;

    if (maxDim < 900 || dpr > 2 || coarsePointer) {
      return 'low';
    }

    if (!coarsePointer && dpr >= 1.5) {
      return 'medium';
    }

    return 'high';
  }

  function getNextLowerTier(currentTier) {
    const index = QUALITY_ORDER.indexOf(currentTier);
    if (index <= 0) return currentTier;
    return QUALITY_ORDER[index - 1];
  }

  function getNextUpperTier(currentTier) {
    const index = QUALITY_ORDER.indexOf(currentTier);
    if (index < 0 || index >= QUALITY_ORDER.length - 1) return currentTier;
    return QUALITY_ORDER[index + 1];
  }

  function applyQualityMeta(tier) {
    document.body.dataset.webglQuality = tier;
  }

  function setFallback() {
    if (hasFallback) return;
    hasFallback = true;
    document.body.classList.add('webgl-fallback');
    window.pauseWebGL = noop;
    window.resumeWebGL = noop;
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
  }

  function acquireContext() {
    // MSAA is a fullscreen resolve every frame; only the top tier pays for it.
    const opts = { antialias: qualityKey === 'high', alpha: false, stencil: false };
    return canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
  }

  let resizePending = false;

  function resize() {
    if (!gl || contextLost) return;

    const cssWidth = window.innerWidth;
    const cssHeight = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * quality.resScale;

    canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
    canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  // Reallocating the backing store is expensive; coalesce resize bursts into one per frame.
  function requestResize() {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => {
      resizePending = false;
      resize();
    });
  }

  function compileShader(src, type) {
    const shader = gl.createShader(type);
    if (!shader) return null;

    gl.shaderSource(shader, src);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }

    return shader;
  }

  function createProgram(vsSource, fsSource) {
    const vs = compileShader(vsSource, gl.VERTEX_SHADER);
    const fs = compileShader(fsSource, gl.FRAGMENT_SHADER);
    if (!vs || !fs) return null;

    const program = gl.createProgram();
    if (!program) return null;

    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }

    return program;
  }

  function createRandom(seedStart = 1) {
    let seed = seedStart >>> 0;
    return () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  function StarfieldModule() {
    const vs = `
precision mediump float;
attribute vec3 aPos;
attribute float aLayer;
uniform float uTime;
uniform vec2 uCamOffset;
uniform vec2 uCamTilt;
uniform float uReduce;
uniform float uTwinkle;
varying float vLayer;
varying float vTwinkle;

void main() {
  vec3 pos = aPos;
  float speed = mix(0.25, 1.0, aLayer);
  pos.z = pos.z - uTime * (1.0 + speed * 1.8);
  pos.z = mod(pos.z + 90.0, 180.0) - 90.0;

  pos.x -= uCamOffset.x * (0.42 + speed * 0.28);
  pos.y -= uCamOffset.y * (0.28 + speed * 0.16) * uReduce;
  pos.x += pos.y * uCamTilt.x * 0.015;

  vec3 cam = pos;
  cam.z -= 10.0;
  float depth = -cam.z;
  float scale = 1.65 / max(depth, 0.1);

  gl_Position = vec4(cam.x * scale, cam.y * scale * 1.38, depth * 0.01, 1.0);
  gl_PointSize = mix(1.1, 2.8, aLayer) * scale * 55.0;

  vLayer = aLayer;
  vTwinkle = uTwinkle > 0.5 ? (sin(uTime * (2.4 + aLayer * 4.0) + aPos.x * 7.0 + aPos.y * 5.0) * 0.5 + 0.5) : 0.6;
}
`;

    const fs = `
precision mediump float;
varying float vLayer;
varying float vTwinkle;

void main() {
  vec2 p = gl_PointCoord - vec2(0.5);
  float radius = dot(p, p);
  if (radius > 0.25) discard;

  float halo = smoothstep(0.25, 0.0, radius);
  vec3 nearCol = vec3(0.95, 0.84, 0.65);
  vec3 farCol = vec3(0.55, 0.78, 1.0);
  vec3 col = mix(farCol, nearCol, vLayer);
  float alpha = halo * (0.35 + 0.65 * vTwinkle);
  gl_FragColor = vec4(col * (0.6 + 0.8 * vTwinkle), alpha);
}
`;

    let program = null;
    let buffer = null;
    let count = 0;

    const attribs = { pos: -1, layer: -1 };
    const uniforms = {
      time: null,
      camOffset: null,
      camTilt: null,
      reduce: null,
      twinkle: null,
    };

    function buildGeometry(starCount) {
      const rand = createRandom(1337 + starCount);
      const verts = [];
      const layers = 3;

      for (let i = 0; i < starCount; i += 1) {
        const layerIdx = i % layers;
        const layer = layerIdx / (layers - 1);
        const spread = 40 - layer * 10;
        const x = (rand() * 2 - 1) * spread;
        const y = (rand() * 2 - 1) * (20 - layer * 6);
        const z = rand() * 180 - 90;

        verts.push(x, y, z, layer);
      }

      const data = new Float32Array(verts);
      if (!buffer) {
        buffer = gl.createBuffer();
      }
      if (!buffer) return false;

      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      count = data.length / 4;
      return true;
    }

    function init(profile) {
      program = createProgram(vs, fs);
      if (!program) return false;

      attribs.pos = gl.getAttribLocation(program, 'aPos');
      attribs.layer = gl.getAttribLocation(program, 'aLayer');

      uniforms.time = gl.getUniformLocation(program, 'uTime');
      uniforms.camOffset = gl.getUniformLocation(program, 'uCamOffset');
      uniforms.camTilt = gl.getUniformLocation(program, 'uCamTilt');
      uniforms.reduce = gl.getUniformLocation(program, 'uReduce');
      uniforms.twinkle = gl.getUniformLocation(program, 'uTwinkle');

      return buildGeometry(profile.stars);
    }

    function rebuild(profile) {
      return buildGeometry(profile.stars);
    }

    function update() {
      return;
    }

    function draw(state) {
      if (!program || !buffer || count === 0) return;

      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

      const stride = 4 * 4;
      gl.enableVertexAttribArray(attribs.pos);
      gl.vertexAttribPointer(attribs.pos, 3, gl.FLOAT, false, stride, 0);

      gl.enableVertexAttribArray(attribs.layer);
      gl.vertexAttribPointer(attribs.layer, 1, gl.FLOAT, false, stride, 3 * 4);

      gl.uniform1f(uniforms.time, state.time);
      gl.uniform2f(uniforms.camOffset, state.camOffset.x, state.camOffset.y);
      gl.uniform2f(uniforms.camTilt, state.camTilt.x, state.camTilt.y);
      gl.uniform1f(uniforms.reduce, state.motionScale);
      gl.uniform1f(uniforms.twinkle, state.qualityKey === 'low' ? 0.0 : 1.0);

      // Stars are sky: no depth test, no depth writes. Also fixes the old depth-scale
      // mismatch (stars z*0.01 vs canyon z*0.022) that let far stars occlude near walls.
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
    }

    return { init, rebuild, update, draw };
  }

  function CanyonModule() {
    const vs = `
precision mediump float;
attribute vec3 aPos;
attribute float aEmissive;
uniform float uTime;
uniform vec2 uCamOffset;
uniform vec2 uCamTilt;
uniform float uMotionScale;
varying vec3 vPos;
varying float vDepth;
varying float vEmissive;
varying float vTravel;

void main() {
  vec3 pos = aPos;
  pos.z = pos.z - uTime * 3.4;
  pos.z = mod(pos.z + 42.0, 84.0) - 42.0;

  float breathe = sin(uTime * 1.2 + aPos.z * 0.2) * 0.05;
  pos.y += breathe * uMotionScale;

  vec3 cam = pos;
  cam.x -= uCamOffset.x;
  cam.y -= uCamOffset.y * uMotionScale;
  cam.x += (pos.y - 0.8) * uCamTilt.x * 0.028;
  cam.y += pos.x * uCamTilt.y * 0.01;
  cam.y -= sin(uTime * 0.4 + uCamOffset.x * 0.2) * 0.018 * uMotionScale;
  cam.z -= 6.0;

  float depth = -cam.z;
  float scale = 1.5 / max(depth, 0.12);

  gl_Position = vec4(cam.x * scale, cam.y * scale * 1.5, depth * 0.022, 1.0);

  vPos = pos;
  vDepth = clamp(depth / 36.0, 0.0, 1.0);
  vEmissive = aEmissive;
  vTravel = pos.z;
}
`;

    const fs = `
precision mediump float;
varying vec3 vPos;
varying float vDepth;
varying float vEmissive;
varying float vTravel;
uniform float uTime;
uniform float uLaneGlow;
uniform float uHeat;
uniform float uPulseSpeed;
uniform float uOctaves;
uniform float uTriplanar;

// sin-free hash: noise() calls this 4x, up to 4 octaves x 3 projections per pixel.
// At ~48 hashes/pixel the transcendental was the dominant fragment cost.
float hash(vec2 p) {
  vec2 q = fract(p * vec2(233.34, 851.73));
  q += dot(q, q + 23.45);
  return fract(q.x * q.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);

  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));

  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float layeredNoise(vec2 p, float octaves) {
  float n = 0.0;
  float a = 0.55;
  vec2 q = p;

  n += a * noise(q);
  if (octaves > 1.5) {
    q *= 2.03;
    a *= 0.5;
    n += a * noise(q);
  }
  if (octaves > 2.5) {
    q *= 2.07;
    a *= 0.5;
    n += a * noise(q);
  }
  if (octaves > 3.5) {
    q *= 2.11;
    a *= 0.5;
    n += a * noise(q);
  }

  return n;
}

void main() {
  vec2 uvX = vPos.yz * vec2(0.8, 0.35);
  vec2 uvY = vPos.xz * vec2(0.45, 0.38);
  vec2 uvZ = vPos.xy * vec2(0.55, 0.9);

  float heatWarp = uHeat > 0.5 ? sin(vPos.z * 0.22 + uTime * 3.1) * 0.035 : 0.0;
  uvY.x += heatWarp;

  // Uniform branch — no divergence within a draw. Below 'high' a single projection
  // carries the texture; the two extra fetches aren't worth 3x the fragment cost.
  float tex = layeredNoise(uvY, uOctaves);
  if (uTriplanar > 0.5) {
    tex = tex * 0.45 + layeredNoise(uvX, uOctaves) * 0.35 + layeredNoise(uvZ, uOctaves) * 0.20;
  }

  vec3 baseCol = vec3(0.035, 0.075, 0.18);
  baseCol += vec3(0.025, 0.04, 0.08) * tex;
  baseCol += vec3(0.0, 0.06, 0.08) * smoothstep(0.0, 1.6, vPos.y);

  float haze = exp(-abs(vPos.y) * 1.9) * (1.0 - vDepth) * 0.45;
  baseCol += vec3(0.03, 0.045, 0.07) * haze;

  float lanePulse = 0.5 + 0.5 * sin(uTime * 3.2 * uPulseSpeed - vTravel * 0.45);
  float checkpoint = smoothstep(0.85, 1.0, sin(uTime * 1.96 - vTravel * 0.16));

  vec3 emissive = mix(vec3(1.0, 0.52, 0.18), vec3(0.0, 0.84, 0.68), lanePulse);
  emissive *= (0.3 + lanePulse * 0.7 + checkpoint * 0.9);

  float laneFactor = vEmissive * (uLaneGlow > 0.5 ? 1.0 : 0.28);
  vec3 col = baseCol + emissive * laneFactor;

  float fog = smoothstep(0.25, 1.0, vDepth);
  col = mix(col, vec3(0.01, 0.018, 0.04), fog);

  // Grade in-shader. A CSS filter on the canvas costs a fullscreen composite pass
  // every frame; saturate + lift here is ~6 ALU ops instead.
  col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 1.24) * 1.14;

  gl_FragColor = vec4(col, 1.0);
}
`;

    let program = null;
    let buffer = null;
    let count = 0;

    const attribs = { pos: -1, emissive: -1 };
    const uniforms = {
      time: null,
      camOffset: null,
      camTilt: null,
      motionScale: null,
      laneGlow: null,
      heat: null,
      pulseSpeed: null,
      octaves: null,
      triplanar: null,
    };

    function centerOffset(z) {
      return Math.sin(z * 0.11) * 0.85 + Math.sin(z * 0.037 + 1.2) * 0.55;
    }

    function wallHeight(z, side) {
      return 1.75 + Math.sin(z * 0.17 + side * 0.6) * 0.35 + Math.cos(z * 0.061 - side * 0.3) * 0.24;
    }

    function pushVertex(store, x, y, z, emissive) {
      store.push(x, y, z, emissive);
    }

    function pushTriangle(store, a, b, c, emissive) {
      pushVertex(store, a[0], a[1], a[2], emissive);
      pushVertex(store, b[0], b[1], b[2], emissive);
      pushVertex(store, c[0], c[1], c[2], emissive);
    }

    function buildGeometry(profile) {
      const verts = [];
      const segments = profile.segments;
      const length = 84;
      const trenchWidth = 3.35;
      const laneInsetInner = 0.18;
      const laneInsetOuter = 0.38;

      for (let i = 0; i < segments; i += 1) {
        const t0 = i / segments;
        const t1 = (i + 1) / segments;

        const z0 = t0 * length - length / 2;
        const z1 = t1 * length - length / 2;

        const c0 = centerOffset(z0);
        const c1 = centerOffset(z1);

        const leftX0 = c0 - trenchWidth;
        const leftX1 = c1 - trenchWidth;
        const rightX0 = c0 + trenchWidth;
        const rightX1 = c1 + trenchWidth;

        const hL0 = wallHeight(z0, -1);
        const hL1 = wallHeight(z1, -1);
        const hR0 = wallHeight(z0, 1);
        const hR1 = wallHeight(z1, 1);

        // Left wall
        pushTriangle(verts, [leftX0, 0, z0], [leftX0, hL0, z0], [leftX1, hL1, z1], 0);
        pushTriangle(verts, [leftX0, 0, z0], [leftX1, hL1, z1], [leftX1, 0, z1], 0);

        // Right wall
        pushTriangle(verts, [rightX0, 0, z0], [rightX1, hR1, z1], [rightX0, hR0, z0], 0);
        pushTriangle(verts, [rightX0, 0, z0], [rightX1, 0, z1], [rightX1, hR1, z1], 0);

        // Floor
        pushTriangle(verts, [leftX0, 0, z0], [leftX1, 0, z1], [rightX0, 0, z0], 0);
        pushTriangle(verts, [rightX0, 0, z0], [leftX1, 0, z1], [rightX1, 0, z1], 0);

        // Left lane strip
        const ll0a = leftX0 + laneInsetInner;
        const ll0b = leftX0 + laneInsetOuter;
        const ll1a = leftX1 + laneInsetInner;
        const ll1b = leftX1 + laneInsetOuter;
        pushTriangle(verts, [ll0a, 0.02, z0], [ll1a, 0.02, z1], [ll0b, 0.02, z0], 1);
        pushTriangle(verts, [ll0b, 0.02, z0], [ll1a, 0.02, z1], [ll1b, 0.02, z1], 1);

        // Right lane strip
        const rl0a = rightX0 - laneInsetInner;
        const rl0b = rightX0 - laneInsetOuter;
        const rl1a = rightX1 - laneInsetInner;
        const rl1b = rightX1 - laneInsetOuter;
        pushTriangle(verts, [rl0b, 0.02, z0], [rl1a, 0.02, z1], [rl0a, 0.02, z0], 1);
        pushTriangle(verts, [rl0b, 0.02, z0], [rl1b, 0.02, z1], [rl1a, 0.02, z1], 1);
      }

      const data = new Float32Array(verts);
      if (!buffer) buffer = gl.createBuffer();
      if (!buffer) return false;

      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      count = data.length / 4;
      return true;
    }

    function init(profile) {
      program = createProgram(vs, fs);
      if (!program) return false;

      attribs.pos = gl.getAttribLocation(program, 'aPos');
      attribs.emissive = gl.getAttribLocation(program, 'aEmissive');

      uniforms.time = gl.getUniformLocation(program, 'uTime');
      uniforms.camOffset = gl.getUniformLocation(program, 'uCamOffset');
      uniforms.camTilt = gl.getUniformLocation(program, 'uCamTilt');
      uniforms.motionScale = gl.getUniformLocation(program, 'uMotionScale');
      uniforms.laneGlow = gl.getUniformLocation(program, 'uLaneGlow');
      uniforms.heat = gl.getUniformLocation(program, 'uHeat');
      uniforms.pulseSpeed = gl.getUniformLocation(program, 'uPulseSpeed');
      uniforms.octaves = gl.getUniformLocation(program, 'uOctaves');
      uniforms.triplanar = gl.getUniformLocation(program, 'uTriplanar');

      return buildGeometry(profile);
    }

    function rebuild(profile) {
      return buildGeometry(profile);
    }

    function update() {
      return;
    }

    function draw(state) {
      if (!program || !buffer || count === 0) return;

      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

      const stride = 4 * 4;
      gl.enableVertexAttribArray(attribs.pos);
      gl.vertexAttribPointer(attribs.pos, 3, gl.FLOAT, false, stride, 0);

      gl.enableVertexAttribArray(attribs.emissive);
      gl.vertexAttribPointer(attribs.emissive, 1, gl.FLOAT, false, stride, 3 * 4);

      gl.uniform1f(uniforms.time, state.time);
      gl.uniform2f(uniforms.camOffset, state.camOffset.x, state.camOffset.y);
      gl.uniform2f(uniforms.camTilt, state.camTilt.x, state.camTilt.y);
      gl.uniform1f(uniforms.motionScale, state.motionScale);
      gl.uniform1f(uniforms.laneGlow, state.profile.laneGlow ? 1.0 : 0.0);
      gl.uniform1f(uniforms.heat, state.profile.heatDistortion ? 1.0 : 0.0);
      gl.uniform1f(uniforms.pulseSpeed, state.profile.lanePulseSpeed * state.motionScale);
      gl.uniform1f(uniforms.octaves, state.profile.fbmOctaves);
      gl.uniform1f(uniforms.triplanar, state.profile.triplanar ? 1.0 : 0.0);

      gl.drawArrays(gl.TRIANGLES, 0, count);
    }

    return { init, rebuild, update, draw };
  }

  function ShipModule() {
const vs = `
precision mediump float;
attribute vec3 aPos;
attribute vec3 aNorm;
attribute float aEmit;
uniform vec3 uPos;
uniform vec3 uRot;
uniform vec2 uCamOffset;
uniform vec2 uCamTilt;
uniform float uTime;
uniform float uMotionScale;
varying vec3 vNorm;
varying vec3 vWorldPos;
varying float vEmit;

mat3 rotX(float t) {
  float c = cos(t);
  float s = sin(t);
  return mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c);
}

mat3 rotY(float t) {
  float c = cos(t);
  float s = sin(t);
  return mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c);
}

mat3 rotZ(float t) {
  float c = cos(t);
  float s = sin(t);
  return mat3(c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0);
}

void main() {
  vec3 p = aPos;
  vec3 n = aNorm;

  mat3 r = rotZ(uRot.z) * rotY(uRot.y) * rotX(uRot.x);
  p = r * p + uPos;
  n = normalize(r * n);

  vec3 cam = p;
  cam.x -= uCamOffset.x;
  cam.y -= uCamOffset.y * uMotionScale;
  cam.x += (p.y - 0.4) * uCamTilt.x * 0.028;
  cam.y += p.x * uCamTilt.y * 0.01;
  cam.y -= sin(uTime * 0.4 + uCamOffset.x * 0.2) * 0.018 * uMotionScale;
  cam.z -= 6.0;

  float depth = -cam.z;
  float scale = 1.5 / max(depth, 0.1);
  gl_Position = vec4(cam.x * scale, cam.y * scale * 1.5, depth * 0.022, 1.0);

  vNorm = n;
  vWorldPos = p;
  vEmit = aEmit;
}
`;

    const fs = `
precision mediump float;
varying vec3 vNorm;
varying vec3 vWorldPos;
varying float vEmit;
uniform float uTime;
uniform float uPulse;
uniform float uThrust;

void main() {
  vec3 viewDir = normalize(vec3(0.0, 0.0, 5.8) - vWorldPos);
  vec3 normal = normalize(vNorm);
  vec3 lightDir = normalize(vec3(0.7, 0.9, 0.55));

  float diff = max(dot(normal, lightDir), 0.0);
  float ambient = 0.18;

  vec3 halfDir = normalize(lightDir + viewDir);
  float spec = pow(max(dot(normal, halfDir), 0.0), 46.0);
  float fresnel = pow(1.0 - max(dot(viewDir, normal), 0.0), 3.2);

  float stripe = smoothstep(0.55, 0.9, abs(sin(vWorldPos.z * 20.0 + vWorldPos.x * 14.0)));
  float pulse = 0.55 + 0.45 * sin(uTime * 3.2);

  vec3 hull = vec3(0.22, 0.26, 0.33);
  vec3 col = hull * (ambient + diff * 0.95);
  col += vec3(0.9, 0.96, 1.0) * spec * 0.95;
  col += vec3(0.34, 0.72, 1.0) * fresnel * 0.75;

  vec3 lineCol = mix(vec3(1.0, 0.52, 0.2), vec3(0.0, 0.82, 0.68), pulse);
  col += lineCol * stripe * 0.22 * uPulse;

  float thruster = vEmit * (0.35 + uThrust * 1.25);
  col += mix(vec3(1.0, 0.58, 0.2), vec3(0.0, 0.84, 1.0), 0.45) * thruster;

  gl_FragColor = vec4(col, 1.0);
}
`;

    let program = null;
    let buffer = null;
    let count = 0;

    const attribs = { pos: -1, norm: -1, emit: -1 };
    const uniforms = {
      pos: null,
      rot: null,
      camOffset: null,
      camTilt: null,
      time: null,
      motionScale: null,
      pulse: null,
      thrust: null,
    };

    function pushVertex(out, pos, norm, emit) {
      out.push(pos[0], pos[1], pos[2], norm[0], norm[1], norm[2], emit);
    }

    function pushTri(out, p0, p1, p2, norm, emit) {
      pushVertex(out, p0, norm, emit);
      pushVertex(out, p1, norm, emit);
      pushVertex(out, p2, norm, emit);
    }

    function addBox(out, x, y, z, w, h, d, emit = 0) {
      const p = {
        lbf: [x - w, y - h, z + d],
        rbf: [x + w, y - h, z + d],
        rtf: [x + w, y + h, z + d],
        ltf: [x - w, y + h, z + d],
        lbb: [x - w, y - h, z - d],
        rbb: [x + w, y - h, z - d],
        rtb: [x + w, y + h, z - d],
        ltb: [x - w, y + h, z - d],
      };

      pushTri(out, p.lbf, p.rbf, p.rtf, [0, 0, 1], emit);
      pushTri(out, p.lbf, p.rtf, p.ltf, [0, 0, 1], emit);

      pushTri(out, p.lbb, p.ltb, p.rtb, [0, 0, -1], emit);
      pushTri(out, p.lbb, p.rtb, p.rbb, [0, 0, -1], emit);

      pushTri(out, p.ltf, p.rtf, p.rtb, [0, 1, 0], emit);
      pushTri(out, p.ltf, p.rtb, p.ltb, [0, 1, 0], emit);

      pushTri(out, p.lbb, p.rbb, p.rbf, [0, -1, 0], emit);
      pushTri(out, p.lbb, p.rbf, p.lbf, [0, -1, 0], emit);

      pushTri(out, p.rbf, p.rbb, p.rtb, [1, 0, 0], emit);
      pushTri(out, p.rbf, p.rtb, p.rtf, [1, 0, 0], emit);

      pushTri(out, p.lbb, p.lbf, p.ltf, [-1, 0, 0], emit);
      pushTri(out, p.lbb, p.ltf, p.ltb, [-1, 0, 0], emit);
    }

    function addNose(out, zFront, zBack, width, height, emit = 0) {
      const tip = [0, 0, zFront];
      const lt = [-width, height, zBack];
      const rt = [width, height, zBack];
      const lb = [-width, -height, zBack];
      const rb = [width, -height, zBack];

      pushTri(out, tip, lt, rt, [0, 0.6, 1], emit);
      pushTri(out, tip, rb, lb, [0, -0.6, 1], emit);
      pushTri(out, tip, lb, lt, [-1, 0, 1], emit);
      pushTri(out, tip, rt, rb, [1, 0, 1], emit);
    }

    function buildGeometry() {
      const verts = [];
      const s = 0.1;

      // Main body
      addBox(verts, 0, 0, -0.02, s * 1.35, s * 0.95, s * 3.9, 0);
      addBox(verts, 0, s * 0.55, s * 1.1, s * 0.85, s * 0.5, s * 1.45, 0);
      addNose(verts, s * 5.7, s * 2.8, s * 0.85, s * 0.56, 0);

      // Side nacelles
      addBox(verts, s * 2.95, -s * 0.03, -s * 0.85, s * 1.15, s * 0.25, s * 2.55, 0);
      addBox(verts, -s * 2.95, -s * 0.03, -s * 0.85, s * 1.15, s * 0.25, s * 2.55, 0);

      // Rear thruster cluster
      addBox(verts, s * 3.95, 0, -s * 2.75, s * 0.52, s * 0.5, s * 1.35, 0);
      addBox(verts, -s * 3.95, 0, -s * 2.75, s * 0.52, s * 0.5, s * 1.35, 0);
      addBox(verts, 0, -s * 0.05, -s * 3.05, s * 0.7, s * 0.45, s * 1.1, 0);

      // Emissive thruster nozzles (rear faces)
      addBox(verts, s * 3.95, 0, -s * 4.0, s * 0.35, s * 0.35, s * 0.22, 1);
      addBox(verts, -s * 3.95, 0, -s * 4.0, s * 0.35, s * 0.35, s * 0.22, 1);
      addBox(verts, 0, -s * 0.05, -s * 4.05, s * 0.45, s * 0.3, s * 0.2, 1);

      // Compact vertical fins
      addBox(verts, s * 3.95, s * 0.88, -s * 2.0, s * 0.11, s * 0.7, s * 0.62, 0);
      addBox(verts, -s * 3.95, s * 0.88, -s * 2.0, s * 0.11, s * 0.7, s * 0.62, 0);

      const data = new Float32Array(verts);
      if (!buffer) buffer = gl.createBuffer();
      if (!buffer) return false;

      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      count = data.length / 7;
      return true;
    }

    function init() {
      program = createProgram(vs, fs);
      if (!program) return false;

      attribs.pos = gl.getAttribLocation(program, 'aPos');
      attribs.norm = gl.getAttribLocation(program, 'aNorm');
      attribs.emit = gl.getAttribLocation(program, 'aEmit');

      uniforms.pos = gl.getUniformLocation(program, 'uPos');
      uniforms.rot = gl.getUniformLocation(program, 'uRot');
      uniforms.camOffset = gl.getUniformLocation(program, 'uCamOffset');
      uniforms.camTilt = gl.getUniformLocation(program, 'uCamTilt');
      uniforms.time = gl.getUniformLocation(program, 'uTime');
      uniforms.motionScale = gl.getUniformLocation(program, 'uMotionScale');
      uniforms.pulse = gl.getUniformLocation(program, 'uPulse');
      uniforms.thrust = gl.getUniformLocation(program, 'uThrust');

      return buildGeometry();
    }

    function rebuild() {
      return true;
    }

    function update() {
      return;
    }

    function draw(state) {
      if (!program || !buffer || count === 0) return;

      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

      const stride = 7 * 4;
      gl.enableVertexAttribArray(attribs.pos);
      gl.vertexAttribPointer(attribs.pos, 3, gl.FLOAT, false, stride, 0);

      gl.enableVertexAttribArray(attribs.norm);
      gl.vertexAttribPointer(attribs.norm, 3, gl.FLOAT, false, stride, 3 * 4);

      gl.enableVertexAttribArray(attribs.emit);
      gl.vertexAttribPointer(attribs.emit, 1, gl.FLOAT, false, stride, 6 * 4);

      gl.uniform3f(uniforms.pos, state.shipPos.x, state.shipPos.y, state.shipPos.z);
      gl.uniform3f(uniforms.rot, state.shipRot.x, state.shipRot.y, state.shipRot.z);
      gl.uniform2f(uniforms.camOffset, state.camOffset.x, state.camOffset.y);
      gl.uniform2f(uniforms.camTilt, state.camTilt.x, state.camTilt.y);
      gl.uniform1f(uniforms.time, state.time);
      gl.uniform1f(uniforms.motionScale, state.motionScale);
      gl.uniform1f(uniforms.pulse, 0.7 + 0.3 * state.lanePulse);
      gl.uniform1f(uniforms.thrust, state.shipThrust);

      gl.drawArrays(gl.TRIANGLES, 0, count);
    }

    return { init, rebuild, update, draw };
  }

  function initializeScene() {
    gl = acquireContext();
    if (!gl) {
      console.error('WebGL not supported');
      setFallback();
      return false;
    }

    resize();
    applyQualityMeta(qualityKey);

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.008, 0.012, 0.03, 1.0);

    starfieldModule = StarfieldModule();
    canyonModule = CanyonModule();
    shipModule = ShipModule();

    const starReady = starfieldModule.init(quality);
    const canyonReady = canyonModule.init(quality);

    if (!canyonReady) {
      console.error('WebGL initialization failed: canyon pipeline unavailable');
      setFallback();
      return false;
    }

    if (!starReady) {
      console.warn('Starfield disabled; continuing with canyon + ship');
      starfieldModule = null;
    }

    const shipReady = shipModule.init(quality);
    if (!shipReady) {
      console.warn('Ship shader disabled; canyon background remains active');
      shipModule = null;
    }

    return true;
  }

  function tryApplyQuality(nextTier) {
    if (nextTier === qualityKey) return;

    const prevTier = qualityKey;
    const prevProfile = quality;

    qualityKey = nextTier;
    quality = QUALITY_PROFILES[nextTier];

    let ok = true;
    try {
      if (starfieldModule) {
        ok = starfieldModule.rebuild(quality) && ok;
      }
      if (canyonModule) {
        ok = canyonModule.rebuild(quality) && ok;
      }
      if (shipModule) {
        ok = shipModule.rebuild(quality) && ok;
      }
    } catch (error) {
      console.error('Quality switch failed:', error);
      ok = false;
    }

    if (!ok) {
      qualityKey = prevTier;
      quality = prevProfile;
      try {
        if (starfieldModule) starfieldModule.rebuild(quality);
        if (canyonModule) canyonModule.rebuild(quality);
        if (shipModule) shipModule.rebuild(quality);
      } catch (_rollbackError) {
        console.error('Quality rollback failed');
      }
      return;
    }

    applyQualityMeta(qualityKey);
    resize();
  }

  function updatePerformance(frameMs) {
    frameMsEma = frameMsEma * 0.92 + frameMs * 0.08;
    perfElapsedMs += frameMs;

    if (frameMsEma > 24) {
      slowFrameStreak += 1;
      fastFrameStreak = 0;
    } else if (frameMsEma < 16) {
      fastFrameStreak += 1;
      slowFrameStreak = 0;
    } else {
      slowFrameStreak = 0;
      fastFrameStreak = 0;
    }

    if (perfElapsedMs < 1500) return;
    perfElapsedMs = 0;

    if (slowFrameStreak >= 90) {
      const lower = getNextLowerTier(qualityKey);
      tryApplyQuality(lower);
      slowFrameStreak = 0;
      fastFrameStreak = 0;
      return;
    }

    if (fastFrameStreak >= 180) {
      const upper = getNextUpperTier(qualityKey);
      tryApplyQuality(upper);
      slowFrameStreak = 0;
      fastFrameStreak = 0;
    }
  }

  function updateState(dt) {
    const dtNorm = clamp(dt * 60, 0.5, 2.2);

    const mouseLerp = clamp(0.055 * dtNorm, 0.02, 0.14);
    mouseX += (targetMouseX - mouseX) * mouseLerp;
    mouseY += (targetMouseY - mouseY) * mouseLerp;

    const aimX = withDeadzone(mouseX, 0.14);
    const aimY = withDeadzone(mouseY, 0.16);
    const aimCurveX = shapeInput(aimX, 1.45);
    const aimCurveY = shapeInput(aimY, 1.4);

    const railX = Math.sin(time * 0.24) * 0.2 + Math.sin(time * 0.08 + 1.2) * 0.12;
    const railY = 0.14 + Math.cos(time * 0.2 + 0.8) * 0.04;

    const desiredCamX = railX + aimCurveX * 0.55 + shipVel.x * 0.38;
    const desiredCamY = clamp(railY + aimCurveY * 0.34 + shipVel.y * 0.25, CAMERA_MIN_Y, CAMERA_MAX_Y);

    const camSpring = 0.026 * dtNorm * MOTION_SCALE;
    const camDamp = Math.pow(0.9, dtNorm);

    camVel.x += (desiredCamX - camOffset.x) * camSpring;
    camVel.y += (desiredCamY - camOffset.y) * camSpring;
    camVel.x *= camDamp;
    camVel.y *= camDamp;

    camOffset.x += camVel.x;
    camOffset.y += camVel.y;
    camOffset.x = clamp(camOffset.x, -1.5, 1.5);
    camOffset.y = clamp(camOffset.y, CAMERA_MIN_Y, CAMERA_MAX_Y);
    if (camOffset.y <= CAMERA_MIN_Y && camVel.y < 0) {
      camVel.y = 0;
    }

    const camTiltTargetX = clamp(camVel.x * 0.24 + aimCurveX * 0.06, -0.22, 0.22);
    const camTiltTargetY = clamp(camVel.y * 0.3 + Math.sin(time * 0.5) * 0.02 * MOTION_SCALE, -0.14, 0.14);
    const camTiltLerp = clamp(0.07 * dtNorm, 0.04, 0.14);
    camTilt.x += (camTiltTargetX - camTilt.x) * camTiltLerp;
    camTilt.y += (camTiltTargetY - camTilt.y) * camTiltLerp;

    const targetX = aimCurveX * 2.5 + railX * 0.2;
    const dynamicFloorSafety = Math.abs(shipRot.x) * 0.08 + Math.abs(shipRot.z) * 0.1 + Math.abs(shipVel.y) * 0.02;
    const minShipY = SHIP_MIN_Y_BASE + dynamicFloorSafety;
    const targetY = clamp(aimCurveY * 1.25 + 1.0 + railY * 0.15, minShipY, SHIP_MAX_Y);

    const accel = 0.0095 * dtNorm * MOTION_SCALE;
    const drag = Math.pow(0.92, dtNorm);

    const dx = targetX - shipPos.x;
    const dy = targetY - shipPos.y;

    shipVel.x += dx * accel;
    shipVel.y += dy * accel;

    shipVel.x *= drag;
    shipVel.y *= drag;

    shipPos.x += shipVel.x;
    shipPos.y += shipVel.y;

    if (shipPos.y < minShipY) {
      shipPos.y = minShipY;
      if (shipVel.y < 0) shipVel.y = 0;
    } else if (shipPos.y > SHIP_MAX_Y) {
      shipPos.y = SHIP_MAX_Y;
      if (shipVel.y > 0) shipVel.y *= 0.25;
    }

    const maxRoll = 0.65;
    const maxPitch = 0.6;

    const bob = Math.sin(time * 0.7) * 0.018 * MOTION_SCALE;
    const drift = Math.sin(time * 0.3 + camOffset.x * 0.2) * 0.025 * MOTION_SCALE;

    targetRot.x = clamp(-shipVel.y * 0.9 + bob, -maxPitch, maxPitch);
    targetRot.z = clamp(-shipVel.x * 0.95 + camTilt.x * 0.1, -maxRoll, maxRoll);
    targetRot.y = clamp(-shipVel.x * 0.22 + drift, -0.24, 0.24);

    const rotLerp = clamp(0.085 * dtNorm, 0.04, 0.18);
    shipRot.x += (targetRot.x - shipRot.x) * rotLerp;
    shipRot.y += (targetRot.y - shipRot.y) * rotLerp;
    shipRot.z += (targetRot.z - shipRot.z) * rotLerp;

    if (starfieldModule) {
      starfieldModule.update();
    }
    canyonModule.update();
    if (shipModule) {
      shipModule.update();
    }
  }

  function render(nowMs) {
    if (isPaused || hasFallback || contextLost || !gl) {
      animationId = null;
      return;
    }

    const dtMs = clamp(nowMs - prevTimeMs, 6, 33);
    prevTimeMs = nowMs;

    const dt = dtMs / 1000;
    time += dt;

    updatePerformance(dtMs);
    updateState(dt);

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const lanePulse = 0.5 + 0.5 * Math.sin(time * 3.2 * quality.lanePulseSpeed * MOTION_SCALE);
    const shipThrust = clamp(Math.hypot(shipVel.x, shipVel.y) * 4.8, 0.1, 1.4);

    drawState.time = time;
    drawState.dt = dt;
    drawState.camOffset = camOffset;
    drawState.camTilt = camTilt;
    drawState.profile = quality;
    drawState.qualityKey = qualityKey;
    drawState.shipPos = shipPos;
    drawState.shipRot = shipRot;
    drawState.lanePulse = lanePulse;
    drawState.shipThrust = shipThrust;

    if (starfieldModule) {
      starfieldModule.draw(drawState);
    }
    canyonModule.draw(drawState);
    if (shipModule) {
      shipModule.draw(drawState);
    }

    animationId = requestAnimationFrame(render);
  }

  function setupEvents() {
    document.addEventListener('mousemove', (event) => {
      targetMouseX = (event.clientX / window.innerWidth) * 2 - 1;
      targetMouseY = (event.clientY / window.innerHeight) * 2 - 1;
    });

    document.addEventListener('touchmove', (event) => {
      if (!event.touches.length) return;
      const touch = event.touches[0];
      targetMouseX = (touch.clientX / window.innerWidth) * 2 - 1;
      targetMouseY = (touch.clientY / window.innerHeight) * 2 - 1;
    }, { passive: true });

    window.addEventListener('resize', requestResize);

    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      contextLost = true;
      if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }
    }, false);

    canvas.addEventListener('webglcontextrestored', () => {
      contextLost = false;
      hasFallback = false;
      document.body.classList.remove('webgl-fallback');

      if (!initializeScene()) {
        setFallback();
        return;
      }

      prevTimeMs = performance.now();
      if (!isPaused) {
        animationId = requestAnimationFrame(render);
      }
    }, false);
  }

  const pauseFlags = { modal: false, hidden: false };

  function syncPaused() {
    const shouldPause = pauseFlags.modal || pauseFlags.hidden;
    if (shouldPause === isPaused) return;
    isPaused = shouldPause;

    if (isPaused) {
      if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }
      return;
    }

    if (hasFallback || contextLost || !gl) return;
    prevTimeMs = performance.now();
    animationId = requestAnimationFrame(render);
  }

  window.pauseWebGL = function pauseWebGL() {
    pauseFlags.modal = true;
    syncPaused();
  };

  window.resumeWebGL = function resumeWebGL() {
    pauseFlags.modal = false;
    syncPaused();
  };

  document.addEventListener('visibilitychange', () => {
    pauseFlags.hidden = document.hidden;
    syncPaused();
  });

  setupEvents();

  if (!initializeScene()) {
    return;
  }

  prevTimeMs = performance.now();
  animationId = requestAnimationFrame(render);
})();
