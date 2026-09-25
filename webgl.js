/*
  /Users/esshka/hireme/webgl.js
  Lensed black hole background: quality tiers, camera, page API, frame loop.
  Physics lives in blackhole.wasm (Rust source kept outside git). Rebuild:
    cd blackhole && cargo build --release --target wasm32-unknown-unknown \
      && cp target/wasm32-unknown-unknown/release/blackhole.wasm ..
  RELEVANT FILES: shaders.js, bloom.js, gl-util.js, lens-worker.js, ui.js, styles.css
*/

import { createBloom } from './bloom.js';
import { createProgram, makeTexture, uniformLocations } from './gl-util.js';
import { FULLSCREEN_VS, sceneFS } from './shaders.js';

const QUALITY_ORDER = ['low', 'medium', 'high'];
// The shader is fragment-bound, so backing-store scale is the main lever;
// particles are the wasm-side cost.
const QUALITY_PROFILES = {
  high: { resScale: 1.0, particles: 60000, nebula: 1, bloomLevels: 6 },
  medium: { resScale: 0.75, particles: 36000, nebula: 1, bloomLevels: 5 },
  low: { resScale: 0.55, particles: 18000, nebula: 0, bloomLevels: 4 },
};
const PARTICLE_SEED = 1337;

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOTION_SCALE = REDUCED_MOTION ? 0.4 : 1.0;

const FOV_HALF = (19 * Math.PI) / 180;
const INCLINATION = (84 * Math.PI) / 180; // from the disk's pole: nearly edge-on
const MOUSE_TILT = 0.07;
const MOUSE_ORBIT = 0.25;
const BASE_ROLL = -0.12;
const FADE_IN_SECONDS = 1.6;
// Screen position of the hole as a fraction of width/height (GL y is up).
const CENTER_LANDSCAPE = [0.66, 0.52]; // right of the text column
const CENTER_PORTRAIT = [0.5, 0.3]; // behind the lower half of the hero

const TEX_UNIT = { lut: 0, deflect: 1, heat: 2 };

const ACCENT_DEFAULT_WARM = [1.0, 0.42, 0.1];
const ACCENT_DEFAULT_HOT = [1.0, 0.86, 0.62];

const SCENE_UNIFORMS = [
  'uLut', 'uDeflect', 'uHeat', 'uCenter', 'uFocal', 'uRoll', 'uCamPos', 'uFwd', 'uRight', 'uUp',
  'uAlphaMax', 'uAlphaCrit', 'uPhiMax', 'uRIn', 'uROut', 'uWarm', 'uHot', 'uNebula', 'uFade',
];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const normalize = (v) => {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function pickInitialQuality() {
  const maxDim = Math.max(window.innerWidth, window.innerHeight);
  const dpr = window.devicePixelRatio || 1;
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints || 0) > 0;

  if (maxDim < 900 || dpr > 2 || coarsePointer) return 'low';
  if (dpr >= 1.5) return 'medium';
  return 'high';
}

function buildLensInWorker(module) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('lens-worker.js');
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage(module);
  });
}

// The disk runs here every frame; the lens table is built by the worker in parallel.
async function loadPhysics() {
  const response = await fetch('blackhole.wasm');
  if (!response.ok) throw new Error(`blackhole.wasm: HTTP ${response.status}`);
  const module = await WebAssembly.compile(await response.arrayBuffer());
  const lensReady = buildLensInWorker(module);

  const { exports: x } = await WebAssembly.instantiate(module);
  x.bh_disk_init(QUALITY_PROFILES.high.particles, PARTICLE_SEED);
  const heatW = x.bh_heat_w();
  const heatH = x.bh_heat_h();
  const { lut, deflection } = await lensReady;

  return {
    step: x.bh_disk_step,
    lut,
    deflection,
    heat: new Uint8Array(x.memory.buffer, x.bh_heat_ptr(), heatW * heatH),
    cols: x.bh_lut_cols(),
    rows: x.bh_lut_rows(),
    heatW,
    heatH,
    camDist: x.bh_cam_dist(),
    alphaMax: x.bh_alpha_max(),
    alphaCrit: x.bh_alpha_crit(),
    phiMax: x.bh_phi_max(),
    rIn: x.bh_r_in(),
    rOut: x.bh_r_out(),
  };
}

function createScene(gl, p, directOutput) {
  const program = createProgram(gl, FULLSCREEN_VS, sceneFS(directOutput));
  if (!program) return null;

  gl.useProgram(program);
  const u = uniformLocations(gl, program, SCENE_UNIFORMS);

  // R16F is filterable in core WebGL2; R32F would need an extension. The
  // deflection is stored relative to a straight line so half precision holds.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  makeTexture(gl, {
    unit: TEX_UNIT.lut, internalFormat: gl.R16F, width: p.cols, height: p.rows,
    format: gl.RED, type: gl.FLOAT, data: p.lut,
  });
  makeTexture(gl, {
    unit: TEX_UNIT.deflect, internalFormat: gl.R16F, width: p.rows, height: 1,
    format: gl.RED, type: gl.FLOAT, data: p.deflection,
  });
  const heatTex = makeTexture(gl, {
    unit: TEX_UNIT.heat, internalFormat: gl.R8, width: p.heatW, height: p.heatH,
    format: gl.RED, type: gl.UNSIGNED_BYTE, data: p.heat, wrapS: gl.REPEAT,
  });

  gl.uniform1i(u.uLut, TEX_UNIT.lut);
  gl.uniform1i(u.uDeflect, TEX_UNIT.deflect);
  gl.uniform1i(u.uHeat, TEX_UNIT.heat);
  gl.uniform1f(u.uAlphaMax, p.alphaMax);
  gl.uniform1f(u.uAlphaCrit, p.alphaCrit);
  gl.uniform1f(u.uPhiMax, p.phiMax);
  gl.uniform1f(u.uRIn, p.rIn);
  gl.uniform1f(u.uROut, p.rOut);

  function draw(view) {
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0 + TEX_UNIT.heat);
    gl.bindTexture(gl.TEXTURE_2D, heatTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, p.heatW, p.heatH, gl.RED, gl.UNSIGNED_BYTE, p.heat);
    gl.uniform2fv(u.uCenter, view.center);
    gl.uniform1f(u.uFocal, view.focal);
    gl.uniform1f(u.uRoll, view.roll);
    gl.uniform3fv(u.uCamPos, view.camPos);
    gl.uniform3fv(u.uFwd, view.fwd);
    gl.uniform3fv(u.uRight, view.right);
    gl.uniform3fv(u.uUp, view.up);
    gl.uniform3fv(u.uWarm, view.warm);
    gl.uniform3fv(u.uHot, view.hot);
    gl.uniform1f(u.uNebula, view.nebula);
    gl.uniform1f(u.uFade, view.fade);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return { draw };
}

function main() {
  const canvas = document.getElementById('scene');
  const noop = () => {};

  if (!canvas) {
    window.pauseWebGL = noop;
    window.resumeWebGL = noop;
    return;
  }

  const accent = { warm: ACCENT_DEFAULT_WARM.slice(), hot: ACCENT_DEFAULT_HOT.slice() };
  const accentTarget = { warm: ACCENT_DEFAULT_WARM.slice(), hot: ACCENT_DEFAULT_HOT.slice() };

  let gl = null;
  let scene = null;
  let bloom = null;
  let physics = null;
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

  function resize() {
    if (!gl || contextLost) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * quality.resScale;
    canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
  }

  let resizePending = false;

  // Reallocating the backing store is expensive; coalesce resize bursts into one per frame.
  function requestResize() {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => {
      resizePending = false;
      resize();
    });
  }

  function initializeScene() {
    gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false });
    if (!gl) {
      console.error('WebGL2 not supported');
      setFallback();
      return false;
    }
    resize();
    applyQualityMeta(qualityKey);
    bloom = createBloom(gl);
    scene = createScene(gl, physics, !bloom);
    if (!scene) {
      console.error('WebGL initialization failed: black hole pipeline unavailable');
      setFallback();
      return false;
    }
    return true;
  }

  function tryApplyQuality(nextTier) {
    if (nextTier === qualityKey) return;
    qualityKey = nextTier;
    quality = QUALITY_PROFILES[nextTier];
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

    const index = QUALITY_ORDER.indexOf(qualityKey);
    if (slowFrameStreak >= 90) {
      tryApplyQuality(QUALITY_ORDER[Math.max(index - 1, 0)]);
    } else if (fastFrameStreak >= 180) {
      tryApplyQuality(QUALITY_ORDER[Math.min(index + 1, QUALITY_ORDER.length - 1)]);
    } else {
      return;
    }
    slowFrameStreak = 0;
    fastFrameStreak = 0;
  }

  function viewState(dt) {
    const lerp = clamp(dt * 3.3, 0.02, 0.14);
    mouseX += (targetMouseX - mouseX) * lerp;
    mouseY += (targetMouseY - mouseY) * lerp;
    for (let i = 0; i < 3; i += 1) {
      accent.warm[i] += (accentTarget.warm[i] - accent.warm[i]) * lerp;
      accent.hot[i] += (accentTarget.hot[i] - accent.hot[i]) * lerp;
    }

    const inc = INCLINATION + (mouseY * MOUSE_TILT + Math.sin(time * 0.05) * 0.02) * MOTION_SCALE;
    const az = mouseX * MOUSE_ORBIT * MOTION_SCALE;
    const camPos = [
      physics.camDist * Math.sin(inc) * Math.cos(az),
      physics.camDist * Math.cos(inc),
      physics.camDist * Math.sin(inc) * Math.sin(az),
    ];
    const fwd = normalize(camPos.map((c) => -c));
    const right = normalize(cross(fwd, [0, 1, 0]));

    const w = canvas.width;
    const h = canvas.height;
    const center = w > h ? CENTER_LANDSCAPE : CENTER_PORTRAIT;
    return {
      center: [w * center[0], h * center[1]],
      focal: (0.5 * Math.min(h, w * 1.1)) / Math.tan(FOV_HALF),
      roll: BASE_ROLL + mouseX * 0.03 * MOTION_SCALE,
      camPos,
      fwd,
      right,
      up: cross(right, fwd),
      warm: accent.warm,
      hot: accent.hot,
      nebula: quality.nebula,
      fade: clamp(time / FADE_IN_SECONDS, 0, 1),
    };
  }

  function render(nowMs) {
    if (isPaused || hasFallback || contextLost || !scene) {
      animationId = null;
      return;
    }

    const dtMs = clamp(nowMs - prevTimeMs, 6, 33);
    prevTimeMs = nowMs;
    const dt = dtMs / 1000;
    time += dt;

    updatePerformance(dtMs);
    // Scaled dt is a clean slow motion: trails lengthen in time as the gas slows.
    physics.step(dt * MOTION_SCALE, quality.particles);
    const view = viewState(dt);

    if (bloom) {
      bloom.resize(canvas.width, canvas.height, quality.bloomLevels);
      bloom.beginScene();
      scene.draw(view);
      bloom.present(view.fade);
    } else {
      gl.viewport(0, 0, canvas.width, canvas.height);
      scene.draw(view);
    }

    animationId = requestAnimationFrame(render);
  }

  function start() {
    prevTimeMs = performance.now();
    if (!isPaused) animationId = requestAnimationFrame(render);
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
      scene = null;
      bloom = null;
      if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }
    }, false);

    // The wasm state and the lens table survive a lost context; only GPU resources are rebuilt.
    canvas.addEventListener('webglcontextrestored', () => {
      contextLost = false;
      hasFallback = false;
      document.body.classList.remove('webgl-fallback');
      if (initializeScene()) start();
    }, false);
  }

  // Page-facing API. setSceneAccent(null) returns the disk to its default palette.
  window.setSceneAccent = function setSceneAccent(warm, hot) {
    const ok = Array.isArray(warm) && Array.isArray(hot) && warm.length === 3 && hot.length === 3;
    accentTarget.warm = ok ? warm.slice() : ACCENT_DEFAULT_WARM.slice();
    accentTarget.hot = ok ? hot.slice() : ACCENT_DEFAULT_HOT.slice();
  };

  window.webglStats = function webglStats() {
    return {
      fallback: hasFallback,
      tier: hasFallback ? null : qualityKey,
      fps: !scene || hasFallback || isPaused || contextLost ? 0 : Math.round(1000 / frameMsEma),
      width: canvas.width,
      height: canvas.height,
    };
  };

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

    if (hasFallback || contextLost || !scene) return;
    start();
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

  loadPhysics()
    .then((loaded) => {
      physics = loaded;
      if (initializeScene()) start();
    })
    .catch((error) => {
      console.error('Black hole physics failed to load:', error);
      setFallback();
    });
}

main();
