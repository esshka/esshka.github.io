/*
  /Users/esshka/hireme/lens-worker.js
  Builds the light-bending table off the main thread (~40 ms of RK4 that
  would otherwise stall first paint). Receives the compiled wasm module and
  transfers back copies, since this worker's wasm memory dies with it.
  RELEVANT FILES: webgl.js, blackhole.wasm
*/

self.onmessage = async ({ data: module }) => {
  try {
    const { exports: x } = await WebAssembly.instantiate(module);
    x.bh_lens_build();
    const rows = x.bh_lut_rows();
    const lut = new Float32Array(x.memory.buffer, x.bh_lut_ptr(), x.bh_lut_cols() * rows).slice();
    const deflection = new Float32Array(x.memory.buffer, x.bh_deflection_ptr(), rows).slice();
    self.postMessage({ lut, deflection }, [lut.buffer, deflection.buffer]);
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
