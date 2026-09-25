/*
  /Users/esshka/hireme/bloom.js
  HDR render target for the scene plus a dual-filter bloom mip chain, then the
  tone-mapped composite to the canvas. Returns null when the GPU cannot render
  to float textures; the caller then draws the scene straight to the canvas.
  RELEVANT FILES: webgl.js, shaders.js, gl-util.js
*/

import { createProgram, makeTexture, uniformLocations } from './gl-util.js';
import { BLOOM_DOWN_FS, BLOOM_UP_FS, COMPOSITE_FS, FULLSCREEN_VS } from './shaders.js';

// Units 0-2 belong to the scene's own textures.
const UNIT_SRC = 3;
const UNIT_BLOOM = 4;
const MIN_LEVEL_PX = 4;

export function createBloom(gl) {
  if (!gl.getExtension('EXT_color_buffer_float')) return null;

  const down = createProgram(gl, FULLSCREEN_VS, BLOOM_DOWN_FS);
  const up = createProgram(gl, FULLSCREEN_VS, BLOOM_UP_FS);
  const composite = createProgram(gl, FULLSCREEN_VS, COMPOSITE_FS);
  if (!down || !up || !composite) return null;

  const passNames = ['uSrc', 'uSrcTexel', 'uInvDst', 'uKaris'];
  const downU = uniformLocations(gl, down, passNames);
  const upU = uniformLocations(gl, up, passNames);
  const compU = uniformLocations(gl, composite, ['uScene', 'uBloom', 'uInvDst', 'uBloomNorm', 'uFade']);

  gl.useProgram(down);
  gl.uniform1i(downU.uSrc, UNIT_SRC);
  gl.useProgram(up);
  gl.uniform1i(upU.uSrc, UNIT_SRC);
  gl.useProgram(composite);
  gl.uniform1i(compU.uScene, UNIT_SRC);
  gl.uniform1i(compU.uBloom, UNIT_BLOOM);

  // targets[0] is the full-res HDR scene; targets[i] is mip level i.
  let targets = [];
  let sizeKey = '';

  function createTarget(width, height) {
    const tex = makeTexture(gl, {
      unit: UNIT_SRC, internalFormat: gl.RGBA16F, width, height, format: gl.RGBA, type: gl.HALF_FLOAT,
    });
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, width, height };
  }

  function resize(width, height, levels) {
    const key = `${width}x${height}x${levels}`;
    if (key === sizeKey) return;
    sizeKey = key;

    targets.forEach((t) => {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    });
    targets = [createTarget(width, height)];
    for (let i = 1; i <= levels; i += 1) {
      const w = width >> i;
      const h = height >> i;
      if (w < MIN_LEVEL_PX || h < MIN_LEVEL_PX) break;
      targets.push(createTarget(w, h));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function pass(program, u, src, dst) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.width, dst.height);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform2f(u.uSrcTexel, 1 / src.width, 1 / src.height);
    gl.uniform2f(u.uInvDst, 1 / dst.width, 1 / dst.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function beginScene() {
    const scene = targets[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);
    gl.viewport(0, 0, scene.width, scene.height);
  }

  function present(fade) {
    const levels = targets.length - 1;
    gl.activeTexture(gl.TEXTURE0 + UNIT_SRC);

    gl.useProgram(down);
    for (let i = 1; i <= levels; i += 1) {
      gl.uniform1f(downU.uKaris, i === 1 ? 1 : 0);
      pass(down, downU, targets[i - 1], targets[i]);
    }

    // Each level accumulates the blurred level below it, so level 1 ends up
    // holding every scale at once.
    gl.useProgram(up);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = levels; i > 1; i -= 1) {
      pass(up, upU, targets[i], targets[i - 1]);
    }
    gl.disable(gl.BLEND);

    const scene = targets[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, scene.width, scene.height);
    gl.useProgram(composite);
    gl.bindTexture(gl.TEXTURE_2D, scene.tex);
    gl.activeTexture(gl.TEXTURE0 + UNIT_BLOOM);
    gl.bindTexture(gl.TEXTURE_2D, targets[Math.min(1, levels)].tex);
    gl.uniform2f(compU.uInvDst, 1 / scene.width, 1 / scene.height);
    gl.uniform1f(compU.uBloomNorm, 1 / Math.max(levels, 1));
    gl.uniform1f(compU.uFade, fade);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return { resize, beginScene, present };
}
