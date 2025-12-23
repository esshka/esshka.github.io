/*
  /Users/esshka/hireme/webgl.js
  WebGL procedural canyon with Descent-style fixed spaceship
  Mouse parallax effect with dynamic lighting
  RELEVANT FILES: index.html, styles.css
*/

const canvas = document.getElementById('canyon');
const gl = canvas.getContext('webgl');

if (!gl) {
  console.error('WebGL not supported');
}

// Mouse position (normalized -1 to 1)
let mouseX = 0, mouseY = 0;
let targetMouseX = 0, targetMouseY = 0;

document.addEventListener('mousemove', (e) => {
  targetMouseX = (e.clientX / window.innerWidth) * 2 - 1;
  targetMouseY = (e.clientY / window.innerHeight) * 2 - 1;
});

// Resize canvas
function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  gl.viewport(0, 0, canvas.width, canvas.height);
}
window.addEventListener('resize', resize);
resize();

// Compile shader with error checking
function compileShader(src, type) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('Shader error:', gl.getShaderInfoLog(s));
  }
  return s;
}

// Create program with error checking
function createProgram(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compileShader(vs, gl.VERTEX_SHADER));
  gl.attachShader(p, compileShader(fs, gl.FRAGMENT_SHADER));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('Program error:', gl.getProgramInfoLog(p));
  }
  return p;
}

// ========== CANYON SHADERS ==========
const canyonVS = `
precision mediump float;
attribute vec3 aPos;
uniform float uTime;
uniform vec2 uMouse;
varying vec3 vPos;
varying float vFog;
varying float vLight;

void main() {
  vec3 pos = aPos;
  
  // Scroll terrain forward
  pos.z = pos.z - uTime * 3.0;
  pos.z = mod(pos.z + 30.0, 60.0) - 30.0;
  
  // Camera with parallax offset from mouse
  vec3 camPos = pos;
  camPos.x -= uMouse.x * 0.8; // Parallax horizontal
  camPos.y -= uMouse.y * 0.3; // Parallax vertical (subtle)
  camPos.z -= 5.0;
  camPos.y -= 0.5;
  
  // Simple perspective
  float depth = -camPos.z;
  float scale = 1.5 / max(depth, 0.1);
  
  gl_Position = vec4(camPos.x * scale, camPos.y * scale * 1.5, depth * 0.02, 1.0);
  
  vPos = aPos;
  vFog = clamp(depth / 25.0, 0.0, 1.0);
  
  // Dynamic light based on mouse position
  vLight = 1.0 + uMouse.x * 0.3;
}
`;

const canyonFS = `
precision mediump float;
varying vec3 vPos;
varying float vFog;
varying float vLight;
uniform vec2 uMouse;

// Procedural noise for texture
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
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

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

void main() {
  // Procedural texture coordinates
  vec2 uv = vPos.xz * 0.5 + vPos.y * 0.3;
  
  // Multi-octave noise for rocky texture
  float tex = fbm(uv * 3.0) * 0.4 + fbm(uv * 8.0) * 0.2;
  
  // Canyon wall color - blue/cyan tones
  vec3 col = vec3(0.05, 0.15, 0.25);
  
  // Add texture variation
  col += vec3(0.02, 0.04, 0.06) * tex;
  
  // Height-based lighting
  col += vec3(0.0, 0.1, 0.15) * (vPos.y * 0.3);
  
  // Mouse-based color shift (warm/cool)
  col.r += uMouse.x * 0.05;
  col.b -= uMouse.x * 0.03;
  col.g += uMouse.y * 0.02;
  
  // Apply dynamic light
  col *= vLight;
  
  // Add subtle edge highlights based on texture
  col += vec3(0.0, 0.05, 0.08) * (tex * tex);
  
  // Distance fog to dark
  col = mix(col, vec3(0.02, 0.02, 0.04), vFog);
  
  gl_FragColor = vec4(col, 1.0);
}`;

// ========== SHIP SHADERS ==========
// ========== SHIP SHADERS ==========
const shipVS = `
precision mediump float;
attribute vec3 aPos;
attribute vec3 aNorm;
uniform vec3 uPos;      // Ship position
uniform vec3 uRot;      // Ship rotation (pitch, yaw, roll)
uniform float uTime;
varying vec3 vNorm;
varying vec3 vWorldPos;

// Rotation matrices
mat3 rotateX(float theta) {
    float c = cos(theta);
    float s = sin(theta);
    return mat3(
        1, 0, 0,
        0, c, -s,
        0, s, c
    );
}

mat3 rotateY(float theta) {
    float c = cos(theta);
    float s = sin(theta);
    return mat3(
        c, 0, s,
        0, 1, 0,
        -s, 0, c
    );
}

mat3 rotateZ(float theta) {
    float c = cos(theta);
    float s = sin(theta);
    return mat3(
        c, -s, 0,
        s, c, 0,
        0, 0, 1
    );
}

void main() {
  vec3 pos = aPos;
  vec3 norm = aNorm;
  
  // Apply individual rotations
  pos = rotateX(uRot.x) * pos;
  pos = rotateY(uRot.y) * pos;
  pos = rotateZ(uRot.z) * pos;
  
  norm = rotateX(uRot.x) * norm;
  norm = rotateY(uRot.y) * norm;
  norm = rotateZ(uRot.z) * norm;

  // Move to world position
  pos += uPos;
  
  // Project to screen (fake perspective)
  float depth = -pos.z + 5.0; // Camera offset
  float scale = 1.5 / max(depth, 0.1);
  
  gl_Position = vec4(pos.x * scale, pos.y * scale * 1.5, pos.z * 0.02, 1.0);
  
  vNorm = normalize(norm);
  vWorldPos = pos;
}
`;

const shipFS = `
precision mediump float;
varying vec3 vNorm;
varying vec3 vWorldPos;
uniform float uTime;

void main() {
  vec3 viewDir = normalize(vec3(0.0, 0.0, 5.0) - vWorldPos);
  vec3 normal = normalize(vNorm);
  vec3 lightDir = normalize(vec3(1.0, 1.0, 1.0)); // Directional light from top-right
  
  // Metallic Base Color (Silver/Gunmetal)
  vec3 baseColor = vec3(0.2, 0.25, 0.3);
  
  // Lighting calculations
  float ambient = 0.2;
  float diff = max(dot(normal, lightDir), 0.0);
  
  // Specular (Blinn-Phong) - Sharp for metal
  vec3 halfwayDir = normalize(lightDir + viewDir);
  float spec = pow(max(dot(normal, halfwayDir), 0.0), 32.0);
  
  // Fresnel Effect (Rim Light) - enhancing volume
  float fresnel = pow(1.0 - max(dot(viewDir, normal), 0.0), 3.0);
  
  // Environment reflection (fake procedural)
  vec3 refDir = reflect(-viewDir, normal);
  float ref = sin(refDir.x * 10.0 + uTime) * sin(refDir.y * 10.0) * 0.5 + 0.5;
  
  // Combine
  vec3 col = baseColor * (ambient + diff);
  col += vec3(0.6, 0.8, 1.0) * spec * 2.0; // Cyan-ish specular
  col += vec3(0.0, 0.8, 1.0) * fresnel * 0.8; // Cyan rim light
  col += vec3(0.1) * ref; // Subtle reflection
  
  // Engine glow (if normal is pointing back)
  if (normal.z > 0.8) {
     col += vec3(0.0, 0.5, 1.0) * 2.0; 
  }
  
  gl_FragColor = vec4(col, 1.0);
}
`;

// ========== GEOMETRY ==========

// Create canyon walls
function createCanyon() {
  const verts = [];
  const segments = 40;
  const length = 60;
  const width = 3;

  for (let i = 0; i < segments; i++) {
    const z0 = (i / segments) * length - length / 2;
    const z1 = ((i + 1) / segments) * length - length / 2;

    const h0 = 1.5 + Math.sin(z0 * 0.3) * 0.5 + Math.sin(z0 * 0.7) * 0.3;
    const h1 = 1.5 + Math.sin(z1 * 0.3) * 0.5 + Math.sin(z1 * 0.7) * 0.3;

    // Left wall
    verts.push(-width, 0, z0, -width, h0, z0, -width, h1, z1);
    verts.push(-width, 0, z0, -width, h1, z1, -width, 0, z1);

    // Right wall
    verts.push(width, 0, z0, width, h1, z1, width, h0, z0);
    verts.push(width, 0, z0, width, 0, z1, width, h1, z1);

    // Floor
    verts.push(-width, 0, z0, -width, 0, z1, width, 0, z0);
    verts.push(width, 0, z0, -width, 0, z1, width, 0, z1);
  }

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  return { buf, count: verts.length / 3 };
}

// Descent-style wedge ship (Volumetric 3D)
function createShip() {
  const verts = [];

  // Helper to add a 3D box
  function addBox(x, y, z, w, h, d) {
    // Front face
    verts.push(x - w, y - h, z + d, 0, 0, 1);
    verts.push(x + w, y - h, z + d, 0, 0, 1);
    verts.push(x + w, y + h, z + d, 0, 0, 1);
    verts.push(x - w, y - h, z + d, 0, 0, 1);
    verts.push(x + w, y + h, z + d, 0, 0, 1);
    verts.push(x - w, y + h, z + d, 0, 0, 1);

    // Back face
    verts.push(x - w, y - h, z - d, 0, 0, -1);
    verts.push(x - w, y + h, z - d, 0, 0, -1);
    verts.push(x + w, y + h, z - d, 0, 0, -1);
    verts.push(x - w, y - h, z - d, 0, 0, -1);
    verts.push(x + w, y + h, z - d, 0, 0, -1);
    verts.push(x + w, y - h, z - d, 0, 0, -1);

    // Top face
    verts.push(x - w, y + h, z - d, 0, 1, 0);
    verts.push(x - w, y + h, z + d, 0, 1, 0);
    verts.push(x + w, y + h, z + d, 0, 1, 0);
    verts.push(x - w, y + h, z - d, 0, 1, 0);
    verts.push(x + w, y + h, z + d, 0, 1, 0);
    verts.push(x + w, y + h, z - d, 0, 1, 0);

    // Bottom face
    verts.push(x - w, y - h, z - d, 0, -1, 0);
    verts.push(x + w, y - h, z - d, 0, -1, 0);
    verts.push(x + w, y - h, z + d, 0, -1, 0);
    verts.push(x - w, y - h, z - d, 0, -1, 0);
    verts.push(x + w, y - h, z + d, 0, -1, 0);
    verts.push(x - w, y - h, z + d, 0, -1, 0);

    // Right face
    verts.push(x + w, y - h, z - d, 1, 0, 0);
    verts.push(x + w, y + h, z - d, 1, 0, 0);
    verts.push(x + w, y + h, z + d, 1, 0, 0);
    verts.push(x + w, y - h, z - d, 1, 0, 0);
    verts.push(x + w, y + h, z + d, 1, 0, 0);
    verts.push(x + w, y - h, z + d, 1, 0, 0);

    // Left face
    verts.push(x - w, y - h, z - d, -1, 0, 0);
    verts.push(x - w, y - h, z + d, -1, 0, 0);
    verts.push(x - w, y + h, z + d, -1, 0, 0);
    verts.push(x - w, y - h, z - d, -1, 0, 0);
    verts.push(x - w, y + h, z + d, -1, 0, 0);
    verts.push(x - w, y + h, z - d, -1, 0, 0);
  }

  // Build Ship
  const s = 0.08;

  // Main Fuselage (Long central body)
  addBox(0, 0, 0, s * 1.5, s * 1.2, s * 4.0);

  // Cockpit (Raised front)
  addBox(0, s, s * 1.5, s * 1.0, s * 0.6, s * 1.5);

  // Wings (projecting out)
  addBox(s * 2.5, 0, -s, s * 1.5, s * 0.2, s * 2.0); // Right
  addBox(-s * 2.5, 0, -s, s * 1.5, s * 0.2, s * 2.0); // Left

  // Engines (On wing tips)
  addBox(s * 4.0, 0, -s * 0.5, s * 0.6, s * 0.6, s * 3.0); // Right
  addBox(-s * 4.0, 0, -s * 0.5, s * 0.6, s * 0.6, s * 3.0); // Left

  // Vertical Fins (Rear of engines)
  addBox(s * 4.0, s * 0.9, -s * 2.5, s * 0.1, s * 0.8, s * 0.8); // Right
  addBox(-s * 4.0, s * 0.9, -s * 2.5, s * 0.1, s * 0.8, s * 0.8); // Left

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

  // Convert 6 floats per vertex (3 pos + 3 norm) -> stride of 24 bytes
  return { buf, count: verts.length / 6 };
}

// ========== INIT ==========
const canyonProg = createProgram(canyonVS, canyonFS);
const shipProg = createProgram(shipVS, shipFS);
const canyon = createCanyon();
const ship = createShip();

gl.enable(gl.DEPTH_TEST);
gl.clearColor(0.02, 0.02, 0.04, 1);

// ========== PHYSICS STATE ==========
let shipPos = { x: 0, y: 0, z: -5 };
let shipVel = { x: 0, y: 0, z: 0 };
let shipRot = { x: 0, y: 0, z: 0 };
let targetRot = { x: 0, y: 0, z: 0 }; // For smooth rotation

// Physics constants
const DRAG = 0.92;
const ACCEL = 0.015;
const ROT_SPEED = 0.1;
const MAX_TILT = 0.8;

// ========== RENDER LOOP ==========
let time = 0;
let animationId = null;
let isPaused = false;

function render() {
  if (isPaused) {
    animationId = null;
    return;
  }

  time += 0.016;

  // --- Physics Update ---

  // Calculate target position based on mouse
  // We want the ship to "chase" the mouse cursor in 3D space
  // Map mouse (-1 to 1) to world coordinates roughly
  const targetX = targetMouseX * 5.0; // Horizontal range
  const targetY = targetMouseY * 3.0 + 0.5; // Vertical range (offset up slightly)

  // 1. Acceleration towards target (spring-like force)
  const diffX = targetX - shipPos.x;
  const diffY = targetY - shipPos.y;

  shipVel.x += diffX * ACCEL;
  shipVel.y += diffY * ACCEL;

  // 2. Apply Drag (Inertia)
  shipVel.x *= DRAG;
  shipVel.y *= DRAG;

  // 3. Update Position
  shipPos.x += shipVel.x;
  shipPos.y += shipVel.y;

  // 4. Calculate desired rotation based on movement (banking)
  // Pitch (X-rotation): Nose up/down based on vertical velocity
  // Roll (Z-rotation): Bank left/right based on horizontal velocity
  // Yaw (Y-rotation): Turn slightly into the turn

  targetRot.x = -shipVel.y * 1.5; // Pitch
  targetRot.z = -shipVel.x * 1.5; // Roll (Bank)
  targetRot.y = -shipVel.x * 0.5; // Yaw

  // Add "idle turbulence" - gentle drifting when stationary
  const noiseX = Math.sin(time * 0.5) * 0.05 + Math.sin(time * 1.3) * 0.02;
  const noiseY = Math.cos(time * 0.7) * 0.05;
  const noiseZ = Math.sin(time * 0.9) * 0.02;

  targetRot.x += noiseX;
  targetRot.y += noiseY;
  targetRot.z += noiseZ;

  // Smoothly interpolate rotation
  shipRot.x += (targetRot.x - shipRot.x) * ROT_SPEED;
  shipRot.y += (targetRot.y - shipRot.y) * ROT_SPEED;
  shipRot.z += (targetRot.z - shipRot.z) * ROT_SPEED;


  // --- Render ---
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // Draw canyon
  gl.useProgram(canyonProg);
  gl.bindBuffer(gl.ARRAY_BUFFER, canyon.buf);

  const canyonPos = gl.getAttribLocation(canyonProg, 'aPos');
  gl.enableVertexAttribArray(canyonPos);
  gl.vertexAttribPointer(canyonPos, 3, gl.FLOAT, false, 0, 0);
  gl.uniform1f(gl.getUniformLocation(canyonProg, 'uTime'), time);
  gl.uniform2f(gl.getUniformLocation(canyonProg, 'uMouse'), mouseX, mouseY); // Keep subtle background parallax

  gl.drawArrays(gl.TRIANGLES, 0, canyon.count);

  // Draw ship
  gl.useProgram(shipProg);
  gl.bindBuffer(gl.ARRAY_BUFFER, ship.buf);

  // Stride is 24 bytes (3 floats pos, 3 floats norm)
  const FSIZE = 4;
  const stride = 6 * FSIZE;

  const shipPosLoc = gl.getAttribLocation(shipProg, 'aPos');
  const shipNormLoc = gl.getAttribLocation(shipProg, 'aNorm');

  gl.enableVertexAttribArray(shipPosLoc);
  gl.vertexAttribPointer(shipPosLoc, 3, gl.FLOAT, false, stride, 0);

  gl.enableVertexAttribArray(shipNormLoc);
  gl.vertexAttribPointer(shipNormLoc, 3, gl.FLOAT, false, stride, 3 * FSIZE);

  // Uniforms
  gl.uniform3f(gl.getUniformLocation(shipProg, 'uPos'), shipPos.x, shipPos.y, shipPos.z);
  gl.uniform3f(gl.getUniformLocation(shipProg, 'uRot'), shipRot.x, shipRot.y, shipRot.z);
  gl.uniform1f(gl.getUniformLocation(shipProg, 'uTime'), time);

  gl.drawArrays(gl.TRIANGLES, 0, ship.count);

  animationId = requestAnimationFrame(render);
}

// Global functions to pause/resume animation
window.pauseWebGL = function () {
  isPaused = true;
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
};

window.resumeWebGL = function () {
  if (isPaused) {
    isPaused = false;
    render();
  }
};

render();
