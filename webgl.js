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

void main() {
  // Canyon wall color - blue/cyan tones
  vec3 col = vec3(0.05, 0.15, 0.25);
  
  // Height-based lighting
  col += vec3(0.0, 0.1, 0.15) * (vPos.y * 0.3);
  
  // Mouse-based color shift (warm/cool)
  col.r += uMouse.x * 0.05;
  col.b -= uMouse.x * 0.03;
  col.g += uMouse.y * 0.02;
  
  // Apply dynamic light
  col *= vLight;
  
  // Distance fog to dark
  col = mix(col, vec3(0.02, 0.02, 0.04), vFog);
  
  gl_FragColor = vec4(col, 1.0);
}
`;

// ========== SHIP SHADERS ==========
const shipVS = `
precision mediump float;
attribute vec3 aPos;
uniform vec2 uMouse;
varying vec3 vNorm;

void main() {
  vec3 pos = aPos;
  
  // Ship tilts slightly with mouse (banking effect)
  float tiltX = uMouse.x * 0.15;
  float tiltY = uMouse.y * 0.1;
  
  // Apply tilt rotation (simplified)
  pos.x += pos.z * tiltX;
  pos.y += pos.z * tiltY * 0.5;
  
  pos.y -= 0.35;
  
  gl_Position = vec4(pos.x, pos.y, 0.5, 1.0);
  vNorm = aPos;
}
`;

const shipFS = `
precision mediump float;
varying vec3 vNorm;
uniform vec2 uMouse;

void main() {
  // Glowing cyan ship
  vec3 col = vec3(0.0, 0.7, 1.0);
  
  // Simple lighting
  float light = 0.5 + vNorm.y * 0.5;
  col *= light;
  
  // Mouse-based glow intensity
  float glowIntensity = 0.3 + abs(uMouse.x) * 0.2 + abs(uMouse.y) * 0.1;
  col += vec3(0.1, glowIntensity, glowIntensity + 0.1);
  
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

// Descent-style wedge ship
function createShip() {
  const s = 0.08;
  const verts = [
    0, s * 0.3, -s * 2.5, -s, 0, s, s, 0, s,
    0, -s * 0.2, -s * 2.5, s, 0, s, -s, 0, s,
    0, s * 0.3, -s * 2.5, 0, -s * 0.2, -s * 2.5, -s, 0, s,
    0, s * 0.3, -s * 2.5, s, 0, s, 0, -s * 0.2, -s * 2.5,
    -s, 0, s, -s * 2.5, 0, s * 0.5, -s * 0.5, 0, s,
    s, 0, s, s * 0.5, 0, s, s * 2.5, 0, s * 0.5,
  ];

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  return { buf, count: verts.length / 3 };
}

// ========== INIT ==========
const canyonProg = createProgram(canyonVS, canyonFS);
const shipProg = createProgram(shipVS, shipFS);
const canyon = createCanyon();
const ship = createShip();

gl.enable(gl.DEPTH_TEST);
gl.clearColor(0.02, 0.02, 0.04, 1);

// ========== RENDER LOOP ==========
let time = 0;

function render() {
  time += 0.016;

  // Smooth mouse movement (easing)
  mouseX += (targetMouseX - mouseX) * 0.05;
  mouseY += (targetMouseY - mouseY) * 0.05;

  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // Draw canyon
  gl.useProgram(canyonProg);
  gl.bindBuffer(gl.ARRAY_BUFFER, canyon.buf);

  const canyonPos = gl.getAttribLocation(canyonProg, 'aPos');
  gl.enableVertexAttribArray(canyonPos);
  gl.vertexAttribPointer(canyonPos, 3, gl.FLOAT, false, 0, 0);
  gl.uniform1f(gl.getUniformLocation(canyonProg, 'uTime'), time);
  gl.uniform2f(gl.getUniformLocation(canyonProg, 'uMouse'), mouseX, mouseY);

  gl.drawArrays(gl.TRIANGLES, 0, canyon.count);

  // Draw ship on top
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(shipProg);
  gl.bindBuffer(gl.ARRAY_BUFFER, ship.buf);

  const shipPos = gl.getAttribLocation(shipProg, 'aPos');
  gl.enableVertexAttribArray(shipPos);
  gl.vertexAttribPointer(shipPos, 3, gl.FLOAT, false, 0, 0);
  gl.uniform2f(gl.getUniformLocation(shipProg, 'uMouse'), mouseX, mouseY);

  gl.drawArrays(gl.TRIANGLES, 0, ship.count);
  gl.enable(gl.DEPTH_TEST);

  requestAnimationFrame(render);
}

render();
