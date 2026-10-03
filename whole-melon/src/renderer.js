// ===== renderer.js =====
// ─────────────────────────────────────────────────────────────
//  WebGPU renderer
//  passes: key-light shadow map (+ colour of what the light crosses first)
//          · top-down height map (contact AO) · scene (floor, seeds, bubbles,
//          knife; MSAA) · jelly nearest-back-face depth · jelly (refraction,
//          absorption; MSAA) + mesh overlay · tone map
// ─────────────────────────────────────────────────────────────

const M4 = {
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  },
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), o = new Float32Array(16);
    o[0] = f / aspect; o[5] = f; o[10] = far / (near - far); o[11] = -1; o[14] = near * far / (near - far);
    return o;
  },
  ortho(l, r, b, t, n, f) {
    const o = new Float32Array(16);
    o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = 1 / (n - f);
    o[12] = -(r + l) / (r - l); o[13] = -(t + b) / (t - b); o[14] = n / (n - f); o[15] = 1;
    return o;
  },
  lookAt(eye, at, up) {
    let zx = eye[0] - at[0], zy = eye[1] - at[1], zz = eye[2] - at[2];
    let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * eye[0] + xy * eye[1] + xz * eye[2]), -(yx * eye[0] + yy * eye[1] + yz * eye[2]), -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1]);
  },
  invert(m) {
    const inv = new Float32Array(16);
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
    inv[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; inv[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    inv[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; inv[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    inv[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; inv[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    inv[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; inv[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    inv[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; inv[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    inv[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; inv[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    inv[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; inv[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    inv[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; inv[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return inv;
  },
};

const MSAA = 4;

// Render presets for the Jelly Studio switcher: device pixels per CSS pixel (cap), MSAA samples,
// shadow map size, soft-shadow taps, contact-occlusion rings, refraction taps.
const QUALITY = {
  studio:   { res: 2,    msaa: 4, shadow: 1536, shadowTaps: 16, aoRings: 3, refrTaps: 7 },
  balanced: { res: 1,    msaa: 4, shadow: 1024, shadowTaps: 8, aoRings: 2, refrTaps: 4 },
  lite:     { res: 0.75, msaa: 1, shadow: 768, shadowTaps: 4, aoRings: 1, refrTaps: 2 },
  minimal:  { res: 0.5,  msaa: 1, shadow: 512, shadowTaps: 1, aoRings: 0, refrTaps: 1 },
};
const UBO_FLOATS = 144;

class Renderer {
  static async create(canvas, opts = {}) {
    if (!navigator.gpu) throw new Error('no-webgpu');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no-adapter');
    const device = await adapter.requestDevice();
    const r = new Renderer(canvas, device, opts);
    r.adapter = adapter; Renderer.keep = { adapter, gpu: navigator.gpu };
    await r.checkShaders();
    return r;
  }

  constructor(canvas, device, opts) {
    this.canvas = canvas;
    this.device = device;
    // cpuPresent: draw into a texture and copy frames to a 2D canvas (headless test browsers
    // can lose the device as soon as a WebGPU canvas context exists)
    this.cpuPresent = !!opts.cpuPresent;
    if (this.cpuPresent) { this.ctx2d = canvas.getContext('2d'); this.format = 'rgba8unorm'; }
    else {
      this.ctx = canvas.getContext('webgpu');
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
    }
    this.lost = false;
    device.lost.then(info => { this.lost = true; this.onLost && this.onLost(info); });
    device.addEventListener && device.addEventListener('uncapturederror', e => { this.onError && this.onError(e.error); });

    this.ubo = device.createBuffer({ size: UBO_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.uboData = new Float32Array(UBO_FLOATS);
    this.topUbo = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    this.cmpSampler = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
    this.linSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    this.q = QUALITY[Renderer.quality] || QUALITY.studio;
    this.topSize = 512;
    const RA = GPUTextureUsage.RENDER_ATTACHMENT, TB = GPUTextureUsage.TEXTURE_BINDING;
    this.makeShadowMaps();
    this.topTex = device.createTexture({ size: [this.topSize, this.topSize], format: 'depth32float', usage: RA | TB });

    this.buildPipelines();
    this.w = 0; this.h = 0;
    this.knifeVisible = false;
    this.capV = 0; this.capI = 0; this.capP = 0; this.capL = 0;
  }

  setKnife(k) {
    const device = this.device;
    const nK = k.rest.length / 3;
    this.knifeDyn = new Float32Array(nK * 6);
    this.knifeDynBuf = device.createBuffer({ size: this.knifeDyn.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const st = new Float32Array(nK * 4);
    for (let i = 0; i < nK; i++) { st[4 * i] = k.rest[3 * i]; st[4 * i + 1] = k.rest[3 * i + 1]; st[4 * i + 2] = k.rest[3 * i + 2]; st[4 * i + 3] = k.mat[i]; }
    const mk = (data, usage) => { const b = device.createBuffer({ size: Math.ceil(data.byteLength / 4) * 4, usage: usage | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(b, 0, data); return b; };
    this.knifeStatic = mk(st, GPUBufferUsage.VERTEX);
    this.knifeIdx = mk(k.index, GPUBufferUsage.INDEX);
    this.knifeCount = k.index.length;
  }

  // mesh = { rest, mat, index, body:{count}, seeds:{first,count}, bubbles:{first,count} }; buffers grow, never shrink
  setMesh(mesh, edges, nParticles) {
    const device = this.device;
    this.mesh = mesh;
    const nV = mesh.rest.length / 3;
    const grow = (key, need, usage, bytesPer) => {
      if (this['cap' + key] >= need && this['buf' + key]) return false;
      const cap = Math.ceil(need * 1.25) + 64;
      if (this['buf' + key]) this['buf' + key].destroy();
      this['buf' + key] = device.createBuffer({ size: cap * bytesPer, usage: usage | GPUBufferUsage.COPY_DST });
      this['cap' + key] = cap;
      return true;
    };
    grow('Dyn', nV, GPUBufferUsage.VERTEX, 24);
    grow('Static', nV, GPUBufferUsage.VERTEX, 16);
    grow('Index', mesh.index.length, GPUBufferUsage.INDEX, 4);
    grow('Lines', edges.length, GPUBufferUsage.INDEX, 4);
    grow('Particles', nParticles, GPUBufferUsage.VERTEX, 12);
    const st = new Float32Array(nV * 4);
    for (let i = 0; i < nV; i++) { st[4 * i] = mesh.rest[3 * i]; st[4 * i + 1] = mesh.rest[3 * i + 1]; st[4 * i + 2] = mesh.rest[3 * i + 2]; st[4 * i + 3] = mesh.mat[i]; }
    device.queue.writeBuffer(this.bufStatic, 0, st);
    device.queue.writeBuffer(this.bufIndex, 0, mesh.index);
    device.queue.writeBuffer(this.bufLines, 0, edges);
    this.lineCount = edges.length;
    this.dyn = new Float32Array(nV * 6);
    this.particles = new Float32Array(nParticles * 3);
  }

  makeShadowMaps() {
    const RA = GPUTextureUsage.RENDER_ATTACHMENT, TB = GPUTextureUsage.TEXTURE_BINDING, n = this.q.shadow;
    for (const t of ['shadowTex', 'shadowColTex']) this[t] && this[t].destroy();
    this.shadowSize = n;
    this.shadowTex = this.device.createTexture({ size: [n, n], format: 'depth32float', usage: RA | TB });
    this.shadowColTex = this.device.createTexture({ size: [n, n], format: 'rgba8unorm', usage: RA | TB });
  }

  // switch render preset: shadow maps, pipelines (MSAA, shader taps) and screen targets are rebuilt
  setQuality(name) {
    const q = QUALITY[name] || QUALITY.studio;
    Renderer.quality = name in QUALITY ? name : 'studio';
    this.q = q;
    if (q.shadow !== this.shadowSize) this.makeShadowMaps();
    this.buildPipelines();
    const w = this.w, h = this.h; this.w = this.h = 0;
    if (w) this.resize(w, h);
  }

  buildPipelines() {
    const d = this.device;
    const V = GPUShaderStage.VERTEX, F = GPUShaderStage.FRAGMENT;
    this.modules = {
      depth: d.createShaderModule({ label: 'depth', code: WGSL_DEPTH }),
      shadow: d.createShaderModule({ label: 'shadow', code: WGSL_SHADOW }),
      scene: d.createShaderModule({ label: 'scene', code: WGSL_SCENE }),
      back: d.createShaderModule({ label: 'back', code: WGSL_BACK }),
      main: d.createShaderModule({ label: 'main', code: WGSL_MAIN }),
      post: d.createShaderModule({ label: 'post', code: WGSL_POST }),
    };
    const uboEntry = { binding: 0, visibility: V | F, buffer: { type: 'uniform' } };
    this.layoutDepth = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: V, buffer: { type: 'uniform' } }] });
    this.layoutScene = d.createBindGroupLayout({ entries: [uboEntry,
      { binding: 1, visibility: F, texture: { sampleType: 'depth' } },
      { binding: 2, visibility: F, texture: { sampleType: 'depth' } },
      { binding: 3, visibility: F, sampler: { type: 'comparison' } },
      { binding: 4, visibility: F, texture: { sampleType: 'float' } },
      { binding: 5, visibility: F, sampler: { type: 'filtering' } }] });
    this.layoutU = d.createBindGroupLayout({ entries: [uboEntry] });
    this.layoutMain = d.createBindGroupLayout({ entries: [uboEntry,
      { binding: 1, visibility: F, texture: { sampleType: 'float' } },
      { binding: 2, visibility: F, texture: { sampleType: 'unfilterable-float' } },
      { binding: 3, visibility: F, sampler: { type: 'filtering' } }] });
    this.layoutPost = d.createBindGroupLayout({ entries: [uboEntry,
      { binding: 1, visibility: F, texture: { sampleType: 'unfilterable-float' } }] });
    const pl = l => d.createPipelineLayout({ bindGroupLayouts: [l] });

    const posOnly = { arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] };
    const meshVB = [
      { arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] },
      { arrayStride: 16, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x3' }, { shaderLocation: 3, offset: 12, format: 'float32' }] },
    ];
    const HDR = 'rgba16float';
    const ms = { count: this.q.msaa };
    const q = this.q;

    this.pDepth = d.createRenderPipeline({
      label: 'height', layout: pl(this.layoutDepth),
      vertex: { module: this.modules.depth, entryPoint: 'vs', buffers: [posOnly] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.pShadow = d.createRenderPipeline({
      label: 'shadow', layout: pl(this.layoutU),
      vertex: { module: this.modules.shadow, entryPoint: 'vs', buffers: meshVB },
      fragment: { module: this.modules.shadow, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 },
    });
    this.pBackground = d.createRenderPipeline({
      label: 'background', layout: pl(this.layoutScene),
      vertex: { module: this.modules.scene, entryPoint: 'vsFull' },
      fragment: { module: this.modules.scene, entryPoint: 'fsBackground', targets: [{ format: HDR }], constants: { SHADOW_TAPS: q.shadowTaps, AO_RINGS: q.aoRings } },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
      multisample: ms,
    });
    this.pProps = d.createRenderPipeline({
      label: 'props', layout: pl(this.layoutScene),
      vertex: { module: this.modules.scene, entryPoint: 'vsMesh', buffers: meshVB },
      fragment: { module: this.modules.scene, entryPoint: 'fsProps', targets: [{ format: HDR }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      multisample: ms,
    });
    // nearest back face: the first place a view ray leaves the jelly
    this.pBack = d.createRenderPipeline({
      label: 'back', layout: pl(this.layoutU),
      vertex: { module: this.modules.back, entryPoint: 'vs', buffers: [posOnly] },
      fragment: { module: this.modules.back, entryPoint: 'fs', targets: [{ format: 'r32float' }] },
      primitive: { topology: 'triangle-list', cullMode: 'front' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.pCopy = d.createRenderPipeline({
      label: 'copy', layout: pl(this.layoutMain),
      vertex: { module: this.modules.main, entryPoint: 'vsFull' },
      fragment: { module: this.modules.main, entryPoint: 'fsCopy', targets: [{ format: HDR }] },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
      multisample: ms,
    });
    this.pJelly = d.createRenderPipeline({
      label: 'jelly', layout: pl(this.layoutMain),
      vertex: { module: this.modules.main, entryPoint: 'vsJelly', buffers: meshVB },
      fragment: { module: this.modules.main, entryPoint: 'fsJelly', targets: [{ format: HDR }], constants: { REFR_TAPS: q.refrTaps } },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      multisample: ms,
    });
    this.pLines = d.createRenderPipeline({
      label: 'lines', layout: pl(this.layoutMain),
      vertex: { module: this.modules.main, entryPoint: 'vsLine', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
      fragment: {
        module: this.modules.main, entryPoint: 'fsLine', targets: [{
          format: HDR,
          blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } },
        }],
      },
      primitive: { topology: 'line-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
      multisample: ms,
    });
    this.pPost = d.createRenderPipeline({
      label: 'post', layout: pl(this.layoutPost),
      vertex: { module: this.modules.post, entryPoint: 'vs' },
      fragment: { module: this.modules.post, entryPoint: 'fs', targets: [{ format: this.format }] },
    });

    this.bgTop = d.createBindGroup({ layout: this.layoutDepth, entries: [{ binding: 0, resource: { buffer: this.topUbo } }] });
    this.bgScene = d.createBindGroup({ layout: this.layoutScene, entries: [
      { binding: 0, resource: { buffer: this.ubo } },
      { binding: 1, resource: this.shadowTex.createView() },
      { binding: 2, resource: this.topTex.createView() },
      { binding: 3, resource: this.cmpSampler },
      { binding: 4, resource: this.shadowColTex.createView() },
      { binding: 5, resource: this.linSampler }] });
    this.bgU = d.createBindGroup({ layout: this.layoutU, entries: [{ binding: 0, resource: { buffer: this.ubo } }] });
  }

  async checkShaders() {
    const problems = [];
    for (const [name, m] of Object.entries(this.modules)) {
      if (!m.getCompilationInfo) continue;
      const info = await m.getCompilationInfo();
      for (const msg of info.messages) if (msg.type === 'error') problems.push(`${name}:${msg.lineNum}:${msg.linePos} ${msg.message}`);
    }
    if (problems.length) throw new Error('WGSL compile error\n' + problems.join('\n'));
  }

  // a colour target: multisampled and resolved, or drawn straight into the texture without MSAA
  target(ms, tex, clearValue) {
    return ms ? { view: ms.createView(), resolveTarget: tex.createView(), clearValue, loadOp: 'clear', storeOp: 'discard' }
              : { view: tex.createView(), clearValue, loadOp: 'clear', storeOp: 'store' };
  }

  resize(w, h) {
    w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.canvas.width = w; this.canvas.height = h;
    const d = this.device;
    for (const t of ['msScene', 'msDepth', 'sceneTex', 'backTex', 'backDepth', 'msHdr', 'hdrTex', 'outTex']) this[t] && this[t].destroy();
    const RA = GPUTextureUsage.RENDER_ATTACHMENT, TB = GPUTextureUsage.TEXTURE_BINDING;
    const ms = this.q.msaa;
    this.msScene = ms > 1 ? d.createTexture({ size: [w, h], format: 'rgba16float', sampleCount: ms, usage: RA }) : null;
    this.msDepth = d.createTexture({ size: [w, h], format: 'depth24plus', sampleCount: ms, usage: RA });
    this.sceneTex = d.createTexture({ size: [w, h], format: 'rgba16float', usage: RA | TB });
    this.backTex = d.createTexture({ size: [w, h], format: 'r32float', usage: RA | TB });
    this.backDepth = d.createTexture({ size: [w, h], format: 'depth32float', usage: RA });
    this.msHdr = ms > 1 ? d.createTexture({ size: [w, h], format: 'rgba16float', sampleCount: ms, usage: RA }) : null;
    this.hdrTex = d.createTexture({ size: [w, h], format: 'rgba16float', usage: RA | TB });
    if (this.cpuPresent) {
      this.outTex = d.createTexture({ size: [w, h], format: 'rgba8unorm', usage: RA | GPUTextureUsage.COPY_SRC });
      this.readBpr = Math.ceil(w * 4 / 256) * 256;
      this.readToken = (this.readToken || 0) + 1;
      this.readBusy = false;
    }
    this.bgMain = d.createBindGroup({ layout: this.layoutMain, entries: [
      { binding: 0, resource: { buffer: this.ubo } },
      { binding: 1, resource: this.sceneTex.createView() },
      { binding: 2, resource: this.backTex.createView() },
      { binding: 3, resource: this.linSampler }] });
    this.bgPost = d.createBindGroup({ layout: this.layoutPost, entries: [
      { binding: 0, resource: { buffer: this.ubo } },
      { binding: 1, resource: this.hdrTex.createView() }] });
  }

  setUniforms(cam, light, palette, params) {
    const u = this.uboData;
    u.set(cam.viewProj, 0); u.set(cam.view, 16); u.set(cam.invViewProj, 32);
    u.set(light.lightVP, 48); u.set(light.topVP, 64);
    u.set([...cam.pos, 0], 80);
    u.set([...cam.fwd, 0], 84);
    u.set([...light.dir, light.intensity], 88);
    u.set([this.w, this.h, 1 / this.w, 1 / this.h], 92);
    u.set([...palette.flesh, 1], 96);
    u.set([...palette.fleshDeep, 1], 100);
    u.set([...palette.pale, 1], 104);
    u.set([...palette.skin, 1], 108);
    u.set([...palette.stripe, 1], 112);
    u.set([...palette.seed, 1], 116);
    u.set([MELON.A, MELON.B, MELON.C, MELON.cy], 120);
    u.set([MELON.skin, MELON.pith, MELON.belly, MELON.bellyK], 124);
    u.set([params.exposure, params.meshAlpha, params.time, 0], 128);
    u.set([...params.bg, 1], 132);
    u.set([...palette.shadowTint, 1], 136);
    u.set([...palette.spot, 1], 140);
    this.device.queue.writeBuffer(this.ubo, 0, u);
    this.device.queue.writeBuffer(this.topUbo, 0, light.topVP);
  }

  uploadGeometry(showMesh) {
    this.device.queue.writeBuffer(this.bufDyn, 0, this.dyn);
    if (this.knifeVisible && this.knifeDynBuf) this.device.queue.writeBuffer(this.knifeDynBuf, 0, this.knifeDyn);
    if (showMesh) this.device.queue.writeBuffer(this.bufParticles, 0, this.particles);
  }

  draw(showMesh) {
    if (this.lost) return;
    // software rendering in tests: draw only once the previous frame has been read back
    if (this.cpuPresent && this.readBusy) return;
    const d = this.device, m = this.mesh;
    const enc = d.createCommandEncoder();
    const knife = this.knifeVisible && this.knifeDynBuf;
    const bodyAndSeeds = m.body.count + m.seeds.count;

    // key-light shadow map with the colour of what the light crosses first
    {
      const p = enc.beginRenderPass({
        colorAttachments: [{ view: this.shadowColTex.createView(), clearValue: [1, 1, 1, 1], loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: this.shadowTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      p.setPipeline(this.pShadow); p.setBindGroup(0, this.bgU);
      p.setVertexBuffer(0, this.bufDyn); p.setVertexBuffer(1, this.bufStatic); p.setIndexBuffer(this.bufIndex, 'uint32');
      p.drawIndexed(bodyAndSeeds, 1, 0, 0, 0);
      if (knife) {
        p.setVertexBuffer(0, this.knifeDynBuf); p.setVertexBuffer(1, this.knifeStatic); p.setIndexBuffer(this.knifeIdx, 'uint32');
        p.drawIndexed(this.knifeCount, 1, 0, 0, 0);
      }
      p.end();
    }
    // top-down height map for contact occlusion (the knife stays out of it)
    {
      const p = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: this.topTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
      p.setPipeline(this.pDepth); p.setBindGroup(0, this.bgTop);
      p.setVertexBuffer(0, this.bufDyn); p.setIndexBuffer(this.bufIndex, 'uint32');
      p.drawIndexed(m.body.count, 1, 0, 0, 0);
      p.end();
    }
    // the scene behind and inside the jelly
    {
      const p = enc.beginRenderPass({
        colorAttachments: [this.target(this.msScene, this.sceneTex, [0, 0, 0, 1000])],
        depthStencilAttachment: { view: this.msDepth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      p.setBindGroup(0, this.bgScene);
      p.setPipeline(this.pBackground); p.draw(3);
      p.setPipeline(this.pProps);
      p.setVertexBuffer(0, this.bufDyn); p.setVertexBuffer(1, this.bufStatic); p.setIndexBuffer(this.bufIndex, 'uint32');
      if (m.seeds.count) p.drawIndexed(m.seeds.count, 1, m.seeds.first, 0, 0);
      if (m.bubbles.count) p.drawIndexed(m.bubbles.count, 1, m.bubbles.first, 0, 0);
      if (knife) {
        p.setVertexBuffer(0, this.knifeDynBuf); p.setVertexBuffer(1, this.knifeStatic); p.setIndexBuffer(this.knifeIdx, 'uint32');
        p.drawIndexed(this.knifeCount, 1, 0, 0, 0);
      }
      p.end();
    }
    // nearest back faces
    {
      const p = enc.beginRenderPass({
        colorAttachments: [{ view: this.backTex.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: this.backDepth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      });
      p.setPipeline(this.pBack); p.setBindGroup(0, this.bgU);
      p.setVertexBuffer(0, this.bufDyn); p.setIndexBuffer(this.bufIndex, 'uint32');
      p.drawIndexed(m.body.count, 1, 0, 0, 0);
      p.end();
    }
    // the jelly
    {
      const p = enc.beginRenderPass({
        colorAttachments: [this.target(this.msHdr, this.hdrTex, [0, 0, 0, 1])],
        depthStencilAttachment: { view: this.msDepth.createView(), depthLoadOp: 'load', depthStoreOp: 'discard' },
      });
      p.setBindGroup(0, this.bgMain);
      p.setPipeline(this.pCopy); p.draw(3);
      p.setPipeline(this.pJelly);
      p.setVertexBuffer(0, this.bufDyn); p.setVertexBuffer(1, this.bufStatic); p.setIndexBuffer(this.bufIndex, 'uint32');
      p.drawIndexed(m.body.count, 1, 0, 0, 0);
      if (showMesh) {
        p.setPipeline(this.pLines);
        p.setVertexBuffer(0, this.bufParticles); p.setIndexBuffer(this.bufLines, 'uint32');
        p.drawIndexed(this.lineCount, 1, 0, 0, 0);
      }
      p.end();
    }
    // tone map
    const read = this.cpuPresent && !this.readBusy;
    const out = this.cpuPresent ? this.outTex : this.ctx.getCurrentTexture();
    if (!this.cpuPresent || read) {
      const p = enc.beginRenderPass({ colorAttachments: [{ view: out.createView(), clearValue: [1, 1, 1, 1], loadOp: 'clear', storeOp: 'store' }] });
      p.setPipeline(this.pPost); p.setBindGroup(0, this.bgPost); p.draw(3);
      p.end();
    }
    let buf = null;
    if (read) {
      buf = d.createBuffer({ size: this.readBpr * this.h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      enc.copyTextureToBuffer({ texture: out }, { buffer: buf, bytesPerRow: this.readBpr }, [this.w, this.h]);
    }
    d.queue.submit([enc.finish()]);
    if (read) {
      this.readBusy = true;
      const token = this.readToken, w = this.w, h = this.h, bpr = this.readBpr;
      const done = () => { buf.destroy(); if (token === this.readToken) this.readBusy = false; };
      buf.mapAsync(GPUMapMode.READ).then(() => {
        if (token === this.readToken) {
          const src = new Uint8Array(buf.getMappedRange());
          const img = new ImageData(w, h);
          for (let y = 0; y < h; y++) img.data.set(src.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
          this.ctx2d.putImageData(img, 0, 0);
          this.presented = (this.presented || 0) + 1;
        }
        buf.unmap(); done();
      }).catch(done);
    }
  }
}
