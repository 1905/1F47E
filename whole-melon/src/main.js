// ===== main.js =====
// ─────────────────────────────────────────────────────────────
//  App: world ↔ render glue, camera, picking, cutting, UI
// ─────────────────────────────────────────────────────────────

const srgbToLin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linToSrgb = c => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const hex = rgb => '#' + rgb.map(c => Math.round(Math.min(1, Math.max(0, linToSrgb(c))) * 255).toString(16).padStart(2, '0')).join('');

// three varieties (linear RGB)
const PALETTES = {
  crimson: {
    name: 'Crimson',
    flesh: [0.93, 0.07, 0.11], fleshDeep: [0.42, 0.018, 0.035],
    pale: [0.72, 0.85, 0.56], skin: [0.05, 0.16, 0.04], stripe: [0.006, 0.036, 0.011],
    seed: [0.01, 0.0065, 0.005], shadowTint: [0.5, 0.5, 0.48], spot: [0.5, 0.42, 0.12],
    ui: { flesh: [0.62, 0.03, 0.06] },
  },
  golden: {
    name: 'Golden',
    flesh: [0.97, 0.52, 0.05], fleshDeep: [0.6, 0.24, 0.012],
    pale: [0.84, 0.88, 0.64], skin: [0.06, 0.17, 0.035], stripe: [0.008, 0.04, 0.01],
    seed: [0.012, 0.008, 0.005], shadowTint: [0.52, 0.5, 0.46], spot: [0.55, 0.45, 0.12],
    ui: { flesh: [0.72, 0.3, 0.02] },
  },
  rose: {
    name: 'Rosé',
    flesh: [0.95, 0.2, 0.3], fleshDeep: [0.6, 0.08, 0.15],
    pale: [0.84, 0.9, 0.72], skin: [0.07, 0.2, 0.09], stripe: [0.012, 0.055, 0.028],
    seed: [0.014, 0.009, 0.007], shadowTint: [0.51, 0.5, 0.5], spot: [0.52, 0.46, 0.16],
    ui: { flesh: [0.72, 0.16, 0.24] },
  },
};

const BG_SRGB = [0.886, 0.875, 0.855]; // #E2DFDA, the studio sweep
const BG_RENDER = BG_SRGB.map(srgbToLin).map(c => c + 0.04);
const KG_PER_UNIT3 = 1.02;  // 1000 cm³ per unit³ at 1.02 g/cm³
const MAX_PIECES = 24;

const $ = s => document.querySelector(s);
function setStatus(text, state) { $('#statusText').textContent = text; $('#status').dataset.state = state; }
function showFallback(title, detail) {
  $('#fallback').hidden = false;
  $('#fallbackTitle').textContent = title;
  $('#fallbackDetail').textContent = detail;
  document.body.classList.add('no-gpu');
  setStatus('WEBGPU · UNAVAILABLE', 'off');
  for (const el of document.querySelectorAll('.panel button, .panel input')) el.disabled = true;
}
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));

async function main() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const canvas = $('#gl');
  const params = new URLSearchParams(location.search);
  if (!navigator.gpu) {
    showFallback('This specimen needs WebGPU.', 'Your browser does not expose WebGPU, so there is nothing to render the jelly with. Try a current Chrome, Edge or Safari (or Firefox on Windows) with hardware acceleration switched on.');
    return;
  }

  let renderer;
  try {
    Renderer.quality = window.__jellyQuality || 'studio';
    renderer = await Renderer.create(canvas, { cpuPresent: params.has('cpu') });
  } catch (err) {
    console.warn(err);
    const msg = String(err && err.message || err);
    if (msg === 'no-adapter') showFallback('No WebGPU adapter was found.', 'WebGPU exists in this browser but could not reach a graphics adapter, usually because hardware acceleration is off or the GPU is blocked. Turn acceleration on or try another device.');
    else showFallback('The renderer could not start.', msg.slice(0, 400));
    return;
  }
  renderer.onError = e => console.error('[webgpu]', e.message);
  renderer.onLost = info => { if (info.reason !== 'destroyed') showFallback('The GPU device was lost.', (info.message || '') + ' Reload the page to restart the study.'); };

  // ── the whole melon ──
  setStatus('WEBGPU · GROWING', 'idle');
  await nextFrame();
  const wholePiece = runGen(buildPiece([]));
  const world = new World([new Body(wholePiece)], { firmness: 0.45, damping: reduced.matches ? 0.65 : 0.45 });
  $('#nSeeds').textContent = melonInclusions().seeds.length.toLocaleString('en');

  let currentPalette = 'crimson';
  const swatches = $('#swatches');
  for (const [key, p] of Object.entries(PALETTES)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'swatch'; b.dataset.key = key;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', p.name + ' variety');
    b.innerHTML = `<span class="chip"><i style="background:${hex(p.skin.map(c => c * 0.8))}"></i><i style="background:${hex(p.pale.map(c => c * 0.95))}"></i><i style="background:${hex(p.ui.flesh)}"></i></span><span class="swname">${p.name}</span>`;
    b.addEventListener('click', () => setPalette(key));
    swatches.appendChild(b);
  }
  function setPalette(key) {
    currentPalette = key;
    for (const b of swatches.children) b.setAttribute('aria-checked', String(b.dataset.key === key));
    document.documentElement.style.setProperty('--accent', hex(PALETTES[key].ui.flesh));
  }
  setPalette('crimson');

  const state = { paused: false, slow: false, showMesh: false, tool: 'hand', az: 0.62, el: 0.5, zoom: 1, time: 0 };

  // ── render mesh: every body's skin, seeds and bubbles in one set of buffers ──
  let mesh = null, vBody = null, triCount = 0;
  function compose() {
    let nV = 0, nB = 0, nS = 0, nU = 0, nE = 0, nP = 0;
    world.bodies.forEach(b => {
      const r = b.piece.render;
      b.vOff = nV; b.pOff = nP; b.nV = r.rest.length / 3;
      nV += b.nV; nP += b.n; nB += r.body.length; nS += r.seeds.length; nU += r.bubbles.length; nE += b.L.edges.length;
      b.skinned = false;
      if (!b.Fn) { b.Fn = new Float32Array(b.n * 9); b.Fw = new Float32Array(b.n); b.vbox = new Float32Array(6); }
    });
    const rest = new Float32Array(nV * 3), mat = new Float32Array(nV), index = new Uint32Array(nB + nS + nU), lines = new Uint32Array(nE);
    vBody = new Uint16Array(nV);
    let bo = 0, so = nB, uo = nB + nS, eo = 0;
    world.bodies.forEach((b, k) => {
      const r = b.piece.render;
      rest.set(r.rest, b.vOff * 3); mat.set(r.mat, b.vOff); vBody.fill(k, b.vOff, b.vOff + b.nV);
      for (const i of r.body) index[bo++] = i + b.vOff;
      for (const i of r.seeds) index[so++] = i + b.vOff;
      for (const i of r.bubbles) index[uo++] = i + b.vOff;
      for (const e of b.L.edges) lines[eo++] = e + b.pOff;
    });
    mesh = { rest, mat, index, body: { first: 0, count: nB }, seeds: { first: nB, count: nS }, bubbles: { first: nB + nS, count: nU } };
    triCount = nB;
    renderer.setMesh(mesh, lines, nP);
    $('#piecesOut').textContent = String(world.bodies.length);
    $('#nParticles').textContent = world.particleCount().toLocaleString('en');
    $('#nCells').textContent = world.cellCount().toLocaleString('en');
  }

  // ── skinning: positions from the embedding, normals from the local deformation ──
  // n_world = cof(F) · n_rest, with F averaged over the tets around each lattice node
  function skinBody(b) {
    const L = b.L, x = b.x, Fn = b.Fn, Fw = b.Fw, tets = L.tets, inv = L.tetInv;
    Fn.fill(0); Fw.fill(0);
    for (let t = 0; t < L.nT; t++) {
      const w = L.restVol[t];
      if (w <= 0) continue;
      const a = 3 * tets[4 * t], bb = 3 * tets[4 * t + 1], c = 3 * tets[4 * t + 2], d = 3 * tets[4 * t + 3];
      const d00 = x[bb] - x[a], d10 = x[bb + 1] - x[a + 1], d20 = x[bb + 2] - x[a + 2];
      const d01 = x[c] - x[a], d11 = x[c + 1] - x[a + 1], d21 = x[c + 2] - x[a + 2];
      const d02 = x[d] - x[a], d12 = x[d + 1] - x[a + 1], d22 = x[d + 2] - x[a + 2];
      const I = 9 * t;
      const F0 = (d00 * inv[I] + d01 * inv[I + 3] + d02 * inv[I + 6]) * w, F1 = (d00 * inv[I + 1] + d01 * inv[I + 4] + d02 * inv[I + 7]) * w, F2 = (d00 * inv[I + 2] + d01 * inv[I + 5] + d02 * inv[I + 8]) * w;
      const F3 = (d10 * inv[I] + d11 * inv[I + 3] + d12 * inv[I + 6]) * w, F4 = (d10 * inv[I + 1] + d11 * inv[I + 4] + d12 * inv[I + 7]) * w, F5 = (d10 * inv[I + 2] + d11 * inv[I + 5] + d12 * inv[I + 8]) * w;
      const F6 = (d20 * inv[I] + d21 * inv[I + 3] + d22 * inv[I + 6]) * w, F7 = (d20 * inv[I + 1] + d21 * inv[I + 4] + d22 * inv[I + 7]) * w, F8 = (d20 * inv[I + 2] + d21 * inv[I + 5] + d22 * inv[I + 8]) * w;
      for (let k = 0; k < 4; k++) {
        const v = tets[4 * t + k], o = 9 * v;
        Fn[o] += F0; Fn[o + 1] += F1; Fn[o + 2] += F2; Fn[o + 3] += F3; Fn[o + 4] += F4; Fn[o + 5] += F5; Fn[o + 6] += F6; Fn[o + 7] += F7; Fn[o + 8] += F8;
        Fw[v] += w;
      }
    }
    const r = b.piece.render, sI = r.skinIdx, sW = r.skinW, rn = r.nrm, dyn = renderer.dyn, box = b.vbox;
    box[0] = box[1] = box[2] = Infinity; box[3] = box[4] = box[5] = -Infinity;
    for (let v = 0; v < b.nV; v++) {
      const i4 = 4 * v, o = 6 * (b.vOff + v);
      let px = 0, py = 0, pz = 0, f0 = 0, f1 = 0, f2 = 0, f3 = 0, f4 = 0, f5 = 0, f6 = 0, f7 = 0, f8 = 0;
      for (let j = 0; j < 4; j++) {
        const q = sI[i4 + j], w = sW[i4 + j], k = 3 * q, f = 9 * q, ww = w / (Fw[q] || 1);
        px += x[k] * w; py += x[k + 1] * w; pz += x[k + 2] * w;
        f0 += Fn[f] * ww; f1 += Fn[f + 1] * ww; f2 += Fn[f + 2] * ww; f3 += Fn[f + 3] * ww; f4 += Fn[f + 4] * ww; f5 += Fn[f + 5] * ww; f6 += Fn[f + 6] * ww; f7 += Fn[f + 7] * ww; f8 += Fn[f + 8] * ww;
      }
      dyn[o] = px; dyn[o + 1] = py; dyn[o + 2] = pz;
      if (px < box[0]) box[0] = px; if (py < box[1]) box[1] = py; if (pz < box[2]) box[2] = pz;
      if (px > box[3]) box[3] = px; if (py > box[4]) box[4] = py; if (pz > box[5]) box[5] = pz;
      // cofactor columns: (f_y × f_z, f_z × f_x, f_x × f_y), with f_x = (f0, f3, f6) etc.
      const nx = rn[3 * v], ny = rn[3 * v + 1], nz = rn[3 * v + 2];
      const c0x = f4 * f8 - f7 * f5, c0y = f7 * f2 - f1 * f8, c0z = f1 * f5 - f4 * f2;
      const c1x = f5 * f6 - f8 * f3, c1y = f8 * f0 - f2 * f6, c1z = f2 * f3 - f5 * f0;
      const c2x = f3 * f7 - f6 * f4, c2y = f6 * f1 - f0 * f7, c2z = f0 * f4 - f3 * f1;
      let wx = nx * c0x + ny * c1x + nz * c2x, wy = nx * c0y + ny * c1y + nz * c2y, wz = nx * c0z + ny * c1z + nz * c2z;
      const l = Math.hypot(wx, wy, wz);
      if (l > 1e-12) { dyn[o + 3] = wx / l; dyn[o + 4] = wy / l; dyn[o + 5] = wz / l; }
      else { dyn[o + 3] = nx; dyn[o + 4] = ny; dyn[o + 5] = nz; }
    }
    b.skinned = true;
  }
  function skinAll() {
    for (const b of world.bodies) if (!b.asleep || !b.skinned) skinBody(b);
    if (state.showMesh) { const P = renderer.particles; for (const b of world.bodies) P.set(b.x, b.pOff * 3); }
  }

  // ── camera & framing ──
  const cam = { viewProj: null, view: null, invViewProj: null, pos: [0, 0, 0], fwd: [0, 0, -1] };
  const target = [0, 0.8, 0];
  const FOV = 27 * Math.PI / 180;
  function safeRect() {
    const cr = canvas.getBoundingClientRect();
    if (document.body.classList.contains('stacked')) return { x: 0, y: 0, w: cr.width, h: cr.height };
    const panel = $('.panel').getBoundingClientRect(), head = $('.masthead').getBoundingClientRect(), read = $('.readouts').getBoundingClientRect();
    const left = Math.min(head.right - cr.left, cr.width * 0.24) * 0.55;
    const right = panel.left - cr.left - 12;
    const top = Math.min(head.bottom - cr.top, cr.height * 0.34) * 0.45;
    const bottom = read.top - cr.top + 30;
    return { x: left, y: top, w: Math.max(200, right - left), h: Math.max(200, bottom - top) };
  }
  // the camera eases after the pieces as they spread (never while one is held)
  function follow(dt) {
    if (drag.mode === 'grab') return;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const b of world.bodies) { const c = b.cw && b.asleep ? b.cw : b.centroid(); x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); z0 = Math.min(z0, c[2]); z1 = Math.max(z1, c[2]); }
    const k = 1 - Math.exp(-dt * 1.2);
    target[0] += ((x0 + x1) / 2 * 0.8 - target[0]) * k; target[2] += ((z0 + z1) / 2 * 0.8 - target[2]) * k;
    spread += (Math.min(1.8, Math.max(x1 - x0, z1 - z0) * 0.35) - spread) * k;
  }
  let spread = 0;
  function updateCamera() {
    const W = renderer.w, H = renderer.h, cr = canvas.getBoundingClientRect(), r = safeRect();
    const aspect = W / H, hf = r.h / cr.height, wf = r.w / cr.width;
    const Rh = 2.05 + spread, Rv = 1.25 + spread * 0.5;
    const t2 = Math.tan(FOV / 2);
    const dist = Math.max(Rv / (t2 * 0.9 * hf), Rh / (t2 * 0.92 * aspect * wf)) * state.zoom;
    const ce = Math.cos(state.el);
    const eye = [target[0] + dist * Math.sin(state.az) * ce, target[1] + dist * Math.sin(state.el), target[2] + dist * Math.cos(state.az) * ce];
    const view = M4.lookAt(eye, target, [0, 1, 0]);
    const proj = M4.perspective(FOV, aspect, 0.1, 90);
    const cx = (r.x + r.w / 2) / cr.width, cy = (r.y + r.h / 2) / cr.height;
    proj[8] -= (cx * 2 - 1); proj[9] -= -(cy * 2 - 1);
    cam.view = view; cam.viewProj = M4.mul(proj, view); cam.invViewProj = M4.invert(cam.viewProj);
    cam.pos = eye;
    const f = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    const fl = Math.hypot(...f); cam.fwd = f.map(v => v / fl);
  }

  // key light from behind-left and above, so thin edges glow toward the camera
  const keyDir = (() => { const d = [-0.45, 0.86, -0.36]; const l = Math.hypot(...d); return d.map(v => v / l); })();
  const light = { dir: keyDir, intensity: 2.3, lightVP: null, topVP: null };
  function updateLight() {
    const at = [target[0], 0.6, target[2]], e = 4.6 + spread * 1.6;
    light.lightVP = M4.mul(M4.ortho(-e, e, -e, e, 0.1, 22), M4.lookAt([at[0] + keyDir[0] * 10, at[1] + keyDir[1] * 10, at[2] + keyDir[2] * 10], at, [0, 0, 1]));
    // top-down height map: camera under the floor looking up so the lowest surface wins; depth = (y + 1) / 5
    light.topVP = M4.mul(M4.ortho(-e, e, -e, e, 0, 5), M4.lookAt([at[0], -1, at[2]], [at[0], 1, at[2]], [0, 0, -1]));
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, (QUALITY[Renderer.quality] || QUALITY.studio).res);
    renderer.resize(r.width * dpr, r.height * dpr);
  }
  const stacked = matchMedia('(max-width: 860px), (max-height: 560px) and (max-width: 1000px)');
  const applyLayout = () => { document.body.classList.toggle('stacked', stacked.matches); resize(); };
  stacked.addEventListener('change', applyLayout);
  applyLayout();
  new ResizeObserver(resize).observe(canvas);
  // render presets from the Jelly Studio switcher
  window.addEventListener('jelly-quality', e => { renderer.setQuality(e.detail); resize(); });

  // ── picking ──
  function rayFrom(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const nx = ((clientX - r.left) / r.width) * 2 - 1, ny = 1 - ((clientY - r.top) / r.height) * 2;
    const m = cam.invViewProj;
    const un = (x, y, z) => {
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, (m[2] * x + m[6] * y + m[10] * z + m[14]) / w];
    };
    const a = un(nx, ny, 0), b = un(nx, ny, 1);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; const l = Math.hypot(...d);
    return { o: a, d: d.map(v => v / l) };
  }
  const rayBox = (o, d, b) => {
    let t0 = 0, t1 = Infinity;
    for (let k = 0; k < 3; k++) {
      const inv = 1 / (d[k] || 1e-12);
      let ta = (b[k] - 0.02 - o[k]) * inv, tb = (b[3 + k] + 0.02 - o[k]) * inv;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return false;
    }
    return true;
  };
  let lastPickBody = -1;
  function pick(ray) {
    let best = Infinity; lastPickBody = -1;
    const { o, d } = ray, dyn = renderer.dyn, index = mesh.index;
    world.bodies.forEach((body, k) => {
      if (!rayBox(o, d, body.vbox)) return;
      const r = body.piece.render, idx = r.body, off = body.vOff;
      for (let t = 0; t < idx.length; t += 3) {
        const a = 6 * (idx[t] + off), b = 6 * (idx[t + 1] + off), c = 6 * (idx[t + 2] + off);
        const e1x = dyn[b] - dyn[a], e1y = dyn[b + 1] - dyn[a + 1], e1z = dyn[b + 2] - dyn[a + 2];
        const e2x = dyn[c] - dyn[a], e2y = dyn[c + 1] - dyn[a + 1], e2z = dyn[c + 2] - dyn[a + 2];
        const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const tx = o[0] - dyn[a], ty = o[1] - dyn[a + 1], tz = o[2] - dyn[a + 2];
        const uu = (tx * px + ty * py + tz * pz) * inv; if (uu < 0 || uu > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const vv = (d[0] * qx + d[1] * qy + d[2] * qz) * inv; if (vv < 0 || uu + vv > 1) continue;
        const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (tt > 1e-4 && tt < best) { best = tt; lastPickBody = k; }
      }
    });
    return best < Infinity ? [o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best] : null;
  }
  // forgiving fallback for grabs that land just outside the silhouette
  function pickNear(clientX, clientY, maxPx) {
    const r = canvas.getBoundingClientRect(), M = cam.viewProj;
    let best = null, bd = maxPx * maxPx; lastPickBody = -1;
    world.bodies.forEach((b, k) => {
      const x = b.x;
      for (let i = 0; i < b.n; i++) {
        const X = x[3 * i], Y = x[3 * i + 1], Z = x[3 * i + 2];
        const w = M[3] * X + M[7] * Y + M[11] * Z + M[15];
        const sx = r.left + ((M[0] * X + M[4] * Y + M[8] * Z + M[12]) / w * 0.5 + 0.5) * r.width;
        const sy = r.top + (0.5 - (M[1] * X + M[5] * Y + M[9] * Z + M[13]) / w * 0.5) * r.height;
        const dd = (sx - clientX) ** 2 + (sy - clientY) ** 2 - w * 1e-3;
        if (dd < bd) { bd = dd; best = [X, Y, Z]; lastPickBody = k; }
      }
    });
    return best;
  }

  // ── stroke overlay and toasts ──
  const knife = { ax: 0, ay: 0, bx: 0, by: 0 };
  const strokeSvg = $('#stroke'), strokeLine = $('#strokeLine');
  let strokeFade = 0;
  function drawStroke(on) {
    const r = canvas.getBoundingClientRect();
    strokeLine.setAttribute('x1', knife.ax - r.left); strokeLine.setAttribute('y1', knife.ay - r.top);
    strokeLine.setAttribute('x2', knife.bx - r.left); strokeLine.setAttribute('y2', knife.by - r.top);
    clearTimeout(strokeFade);
    strokeSvg.classList.toggle('on', on);
    if (!on) strokeSvg.classList.add('fading'), strokeFade = setTimeout(() => strokeSvg.classList.remove('fading'), 420);
    else strokeSvg.classList.remove('fading');
  }
  const toastEl = $('#toast');
  let toastT = 0;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('on'), 2400);
  }

  // ── cutting ──
  // The stroke, read on top of what it crosses, fixes a vertical blade plane. For every piece it
  // passes through, the piece's best-fit rotation carries the plane into the shared rest frame,
  // where the piece is split in two. The new pieces are built over the next frames while the
  // knife lines up and presses; they are swapped in when the edge breaks through.
  const rayPlaneY = (ray, y) => {
    if (ray.d[1] > -1e-4) return null;
    const t = (y - ray.o[1]) / ray.d[1];
    return t > 0 ? [ray.o[0] + ray.d[0] * t, y, ray.o[2] + ray.d[2] * t] : null;
  };
  const camRightYaw = () => -state.az;
  const canonicalYaw = (dx, dz) => {
    let yaw = Math.atan2(dz, dx);
    if (Math.cos(yaw - camRightYaw()) < 0) yaw += Math.PI;   // handle on the left, tip on the right
    return yaw;
  };
  // thickness of the thinnest direction of a sampled piece (a slab of thickness t has variance t²/12)
  const thinness = S => { if (S.n < 4) return 0; const e = eigSym3(Array.from(S.cov, v => v / S.n)).values; return Math.sqrt(12 * Math.max(0, Math.min(...e))); };
  function planCut(ax, ay, bx, by) {
    if (Math.hypot(bx - ax, by - ay) < 24) return { miss: '' };
    const hit = new Set(); let yTop = 0, t0 = -1, t1 = -1;
    for (let k = 0; k <= 48; k++) {
      const t = k / 48;
      const p = pick(rayFrom(ax + (bx - ax) * t, ay + (by - ay) * t));
      if (p && lastPickBody >= 0) { hit.add(world.bodies[lastPickBody]); yTop = Math.max(yTop, p[1]); if (t0 < 0) t0 = t; t1 = t; }
    }
    if (!hit.size) return { miss: 'Missed. Draw the blade across the melon.' };
    const at = t => rayPlaneY(rayFrom(ax + (bx - ax) * t, ay + (by - ay) * t), yTop);
    const A = at(0) || at(t0), B = at(1) || at(t1), A2 = at(t0), B2 = at(t1);
    if (!A || !B || !A2 || !B2) return { miss: 'Missed. Draw the blade across the melon.' };
    let dx = B[0] - A[0], dz = B[2] - A[2];
    const dl = Math.hypot(dx, dz); if (dl < 0.05) return { miss: '' };
    dx /= dl; dz /= dl;
    const n = [-dz, 0, dx];
    const o = [(A2[0] + B2[0]) / 2, yTop, (A2[2] + B2[2]) / 2];
    // the blade plane also cuts pieces it passes through without the stroke landing on them
    for (const b of world.bodies) {
      if (hit.has(b)) continue;
      const bx0 = b.vbox; let lo = Infinity, hi = -Infinity;
      for (const X of [bx0[0], bx0[3]]) for (const Z of [bx0[2], bx0[5]]) { const s = n[0] * (X - o[0]) + n[2] * (Z - o[2]); lo = Math.min(lo, s); hi = Math.max(hi, s); }
      if (lo >= 0 || hi <= 0) continue;
      // only along the stroke's own extent
      const c = b.centroid(), along = dx * (c[0] - o[0]) + dz * (c[2] - o[2]);
      if (Math.abs(along) < Math.hypot(B2[0] - A2[0], B2[2] - A2[2]) / 2 + 0.3) hit.add(b);
    }
    const jobs = []; let thin = 0;
    for (const b of hit) {
      b.updateFrame(10);
      const R = b.R;
      const nr = [R[0] * n[0] + R[3] * n[1] + R[6] * n[2], R[1] * n[0] + R[4] * n[1] + R[7] * n[2], R[2] * n[0] + R[5] * n[1] + R[8] * n[2]];
      const d = [o[0] - b.cw[0], o[1] - b.cw[1], o[2] - b.cw[2]];
      const pr = [R[0] * d[0] + R[3] * d[1] + R[6] * d[2] + b.cr[0], R[1] * d[0] + R[4] * d[1] + R[7] * d[2] + b.cr[1], R[2] * d[0] + R[5] * d[1] + R[8] * d[2] + b.cr[2]];
      const c = nr[0] * pr[0] + nr[1] * pr[1] + nr[2] * pr[2];
      const pa = [...b.piece.planes, [nr[0], nr[1], nr[2], c - MELON.gap]];
      const pb = [...b.piece.planes, [-nr[0], -nr[1], -nr[2], -(c + MELON.gap)]];
      const flat = l => { const f = new Float64Array(l.length * 4); l.forEach((p, i) => f.set(p, 4 * i)); return f; };
      const Sa = samplePiece(flat(pa), 0.07), Sb = samplePiece(flat(pb), 0.07);
      if (!Sa.n || !Sb.n) continue;   // the plane only grazes it
      if (Sa.vol < 0.03 || Sb.vol < 0.03 || thinness(Sa) < 0.12 || thinness(Sb) < 0.12) { thin++; continue; }
      jobs.push({ body: b, parts: [pa, pb] });
    }
    if (!jobs.length) return { miss: thin ? 'Too thin to cut there.' : 'Missed. Draw the blade across the melon.' };
    if (world.bodies.length + jobs.length > MAX_PIECES) return { miss: 'That’s plenty of pieces. Reset for a fresh melon.' };
    return { jobs, n, o, yTop, yaw: canonicalYaw(dx, dz), built: null, gen: buildJobs(jobs) };
  }
  function* buildJobs(jobs) {
    const out = [];
    for (const job of jobs) {
      const pieces = [];
      for (const planes of job.parts) pieces.push(yield* buildPiece(planes));
      out.push({ body: job.body, pieces });
    }
    return out;
  }
  // run the cooperative build for up to `ms` this frame
  function advanceBuild(plan, ms) {
    if (!plan || plan.built) return;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const r = plan.gen.next();
      if (r.done) { plan.built = r.value; break; }
    }
  }

  // Swap the new pieces in: each new particle takes the position and velocity of the flesh it came
  // from, found by its rest position in the parent's lattice.
  function installCut(plan, sepSpeed = 0.2) {
    if (drag.mode === 'grab') { world.endGrab(); drag.mode = null; }
    const next = [];
    const replaced = new Map(plan.built.map(r => [r.body, r]));
    for (const b of world.bodies) {
      const r = replaced.get(b);
      if (!r) { next.push(b); continue; }
      r.pieces.forEach((piece, side) => {
        const nb = new Body(piece);
        for (let i = 0; i < nb.n; i++) {
          const Lc = locate(b.L, nb.rest[3 * i], nb.rest[3 * i + 1], nb.rest[3 * i + 2]);
          for (let k = 0; k < 3; k++) {
            let xs = 0, vs = 0;
            for (let j = 0; j < 4; j++) { const q = b.L.tets[4 * Lc.t + j]; xs += b.x[3 * q + k] * Lc.w[j]; vs += b.v[3 * q + k] * Lc.w[j]; }
            nb.x[3 * i + k] = xs; nb.v[3 * i + k] = vs;
          }
          if (nb.x[3 * i + 1] < 0) nb.x[3 * i + 1] = 0;
        }
        // which way this half lies from the blade: it is eased away on that side
        const c = nb.centroid();
        const sg = Math.sign(plan.n[0] * (c[0] - plan.o[0]) + plan.n[2] * (c[2] - plan.o[2])) || (side ? 1 : -1);
        for (let i = 0; i < nb.n; i++) { nb.v[3 * i] += plan.n[0] * sg * sepSpeed; nb.v[3 * i + 2] += plan.n[2] * sg * sepSpeed; }
        nb.prev.set(nb.x);
        nb.side = Math.sign(plan.n[0] * sg * blade.n[0] + plan.n[2] * sg * blade.n[2]) || sg;
        nb.updateFrame(10);
        next.push(nb);
      });
    }
    world.bodies = next;
    world.wakeAll();
    compose();
    hoverDirty = true;
  }

  // ── the knife: hovers under the pointer, lines up over the stroke, presses, then cuts ──
  const knifeMesh = buildKnifeMesh();
  renderer.setKnife(knifeMesh);
  const S = KNIFE.S;
  const TOP = MELON.cy + MELON.B;
  const HOVER_H = 0.35;
  const kp = { P: [0, TOP + HOVER_H + 2, 1.4], yaw: -0.62, roll: 0.16, pitch: 0.05 };
  const blade = { holdY: 0, mode: null, p: [0, 0, 0], d: [1, 0, 0], n: [0, 0, 1], a0: -KNIFE.xr * S, a1: (KNIFE.Lb - KNIFE.xr) * S, top: KNIFE.H * S * 0.95, halfGap: 0.03, grooveW: 0.17, grooveD: 0.13 };
  world.blade = blade;
  let knifeAnim = null, hoverSeen = false;
  const wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));
  const lerp = (a, b, s) => a + (b - a) * s;
  const lerp3 = (a, b, s) => [lerp(a[0], b[0], s), lerp(a[1], b[1], s), lerp(a[2], b[2], s)];
  const ease = s => { s = Math.min(1, Math.max(0, s)); return s * s * (3 - 2 * s); };
  function knifeBasis(yaw, roll, pitch) {
    const d = [Math.cos(yaw), 0, Math.sin(yaw)], z = [-d[2], 0, d[0]];
    const cr = Math.cos(roll), sr = Math.sin(roll), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const Y1 = [-sr * z[0], cr, -sr * z[2]], Z = [cr * z[0], sr, cr * z[2]];
    const X = [cp * d[0] - sp * Y1[0], cp * d[1] - sp * Y1[1], cp * d[2] - sp * Y1[2]];
    const Y = [sp * d[0] + cp * Y1[0], sp * d[1] + cp * Y1[1], sp * d[2] + cp * Y1[2]];
    return [X, Y, Z];
  }
  function poseKnife() {
    const [X, Y, Z] = knifeBasis(kp.yaw, kp.roll, kp.pitch);
    const out = renderer.knifeDyn, r = knifeMesh.rest, nr = knifeMesh.nrm, P = kp.P, xr = KNIFE.xr;
    for (let v = 0, o = 0; v < r.length; v += 3, o += 6) {
      const lx = (r[v] - xr) * S, ly = r[v + 1] * S, lz = r[v + 2] * S;
      out[o] = P[0] + X[0] * lx + Y[0] * ly + Z[0] * lz;
      out[o + 1] = P[1] + X[1] * lx + Y[1] * ly + Z[1] * lz;
      out[o + 2] = P[2] + X[2] * lx + Y[2] * ly + Z[2] * lz;
      const nx = nr[v], ny = nr[v + 1], nz = nr[v + 2];
      out[o + 3] = X[0] * nx + Y[0] * ny + Z[0] * nz;
      out[o + 4] = X[1] * nx + Y[1] * ny + Z[1] * nz;
      out[o + 5] = X[2] * nx + Y[2] * ny + Z[2] * nz;
    }
  }
  function topNear(q) {
    let top = 0;
    for (const b of world.bodies) { const bx = b.vbox; if (q[0] > bx[0] - 0.4 && q[0] < bx[3] + 0.4 && q[2] > bx[2] - 0.4 && q[2] < bx[5] + 0.4) top = Math.max(top, bx[4]); }
    return top;
  }
  function hoverPose() {
    let q = hoverSeen ? rayPlaneY(rayFrom(hoverX, hoverY), TOP * 0.6) : null;
    if (q) { const dx = q[0] - target[0], dz = q[2] - target[2], dl = Math.hypot(dx, dz); if (dl > 4) { q[0] = target[0] + dx / dl * 4; q[2] = target[2] + dz / dl * 4; } }
    if (!q) q = [target[0] + 0.1, 0, target[2] + 0.4];
    q[1] = Math.max(topNear(q), 0.3) + HOVER_H;
    return { P: q, yaw: camRightYaw(), roll: 0.16, pitch: 0.05 };
  }
  function strokePose() {
    const h = TOP * 0.6;
    const A = rayPlaneY(rayFrom(knife.ax, knife.ay), h), B = rayPlaneY(rayFrom(knife.bx, knife.by), h);
    if (!A || !B) return hoverPose();
    const dl = Math.hypot(B[0] - A[0], B[2] - A[2]);
    const yaw = dl > 0.08 ? canonicalYaw(B[0] - A[0], B[2] - A[2]) : kp.yaw;
    const M = [(A[0] + B[0]) / 2, 0, (A[2] + B[2]) / 2];
    M[1] = topNear(M) + 0.12;
    return { P: M, yaw, roll: 0.08, pitch: 0 };
  }
  function easeToward(pose, k) {
    kp.P = lerp3(kp.P, pose.P, k);
    kp.yaw += wrapA(pose.yaw - kp.yaw) * k;
    kp.roll = lerp(kp.roll, pose.roll, k); kp.pitch = lerp(kp.pitch, pose.pitch, k);
  }
  // the cut, as a piece of choreography (seconds); the press holds until the new pieces are built
  const KT = { align: 0.2, press: 0.5, through: 0.62, hold: 0.74, lift: 1.15 };
  function startCut(plan) {
    knifeAnim = { t: 0, plan, from: { P: kp.P.slice(), yaw: kp.yaw, roll: kp.roll, pitch: kp.pitch }, committed: false, wait: 0 };
  }
  function runKnifeAnim(dt) {
    const a = knifeAnim, pl = a.plan;
    const d = [Math.cos(pl.yaw), 0, Math.sin(pl.yaw)], M = pl.o;
    const at = (s, y) => [M[0] + d[0] * s, y, M[2] + d[2] * s];
    const P1 = at(-0.15, pl.yTop + 0.12), P2 = at(0.0, pl.yTop - blade.grooveD * 1.1), P3 = at(0.3, 0.004);
    // the press waits for the build: the clock stops at the end of the press until it is ready
    if (a.t + dt >= KT.press && !pl.built) { a.t = Math.min(a.t + dt, KT.press - 1e-4); a.wait += dt; }
    else a.t += dt;
    const t = a.t;
    if (t < KT.align) {
      const s = ease(t / KT.align);
      kp.P = lerp3(a.from.P, P1, s);
      kp.yaw = a.from.yaw + wrapA(pl.yaw - a.from.yaw) * s;
      kp.roll = lerp(a.from.roll, 0, s); kp.pitch = lerp(a.from.pitch, 0, s);
      blade.mode = null;
    } else if (t < KT.press) {
      // the edge meets the jelly and pushes a groove into it before it gives
      const s = (t - KT.align) / (KT.press - KT.align);
      kp.P = lerp3(P1, P2, Math.min(1, s * s * 1.2)); kp.yaw = pl.yaw; kp.roll = 0; kp.pitch = 0;
      blade.mode = 'press';
    } else if (t < KT.hold) {
      if (!a.committed) {
        a.committed = true;
        blade.n = [-d[2], 0, d[0]];
        blade.holdY = kp.P[1];
        const tc = performance.now();
        installCut(pl, 0.22);
        window.__melon.lastCommitMs = performance.now() - tc;
        window.__melon.lastWaitMs = a.wait * 1000;
      }
      const s = 1 - Math.pow(1 - Math.min(1, (t - KT.press) / (KT.through - KT.press)), 2);
      kp.P = lerp3(P2, P3, s);
      blade.halfGap = 0.012 + 0.03 * s;
      blade.mode = 'split';
    } else if (t < KT.lift) {
      blade.mode = null;
      const s = ease((t - KT.hold) / (KT.lift - KT.hold));
      const h = state.tool === 'knife' ? hoverPose() : { P: [P3[0], P3[1] + 3, P3[2]], yaw: pl.yaw, roll: 0.3, pitch: 0.05 };
      kp.P = lerp3(P3, h.P, s);
      kp.yaw = pl.yaw + wrapA(h.yaw - pl.yaw) * s;
      kp.roll = lerp(0, h.roll, s); kp.pitch = lerp(0, h.pitch, s);
    } else {
      knifeAnim = null; blade.mode = null;
    }
  }
  function updateKnife(dt, animDt) {
    if (knifeAnim) advanceBuild(knifeAnim.plan, knifeAnim.t > KT.align ? 10 : 6);
    if (state.tool !== 'knife' && !knifeAnim) { renderer.knifeVisible = false; blade.mode = null; return; }
    if (knifeAnim) runKnifeAnim(animDt);
    else easeToward(drag.mode === 'knife' ? strokePose() : hoverPose(), 1 - Math.exp(-dt * 14));
    blade.p = kp.P; blade.d = [Math.cos(kp.yaw), 0, Math.sin(kp.yaw)];
    if (!knifeAnim || !knifeAnim.committed) blade.n = [-blade.d[2], 0, blade.d[0]];
    if (blade.mode) for (const b of world.bodies) {
      const bx = b.vbox; if (bx && kp.P[1] < bx[4] + 0.1) b.wake();
    }
    poseKnife();
    renderer.knifeVisible = true;
  }

  // ── pointer interaction ──
  const drag = { mode: null, id: -1, plane: null, twist: 0, twist0: 0, second: null, lastX: 0, lastY: 0, pinch: 0, zoom0: 1 };
  function rotMat(axis, ang) {
    const [x, y, z] = axis, c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
    return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
  }
  function dragTarget(clientX, clientY) {
    const ray = rayFrom(clientX, clientY);
    const { p, n } = drag.plane;
    const den = ray.d[0] * n[0] + ray.d[1] * n[1] + ray.d[2] * n[2];
    if (Math.abs(den) < 1e-5) return null;
    const t = ((p[0] - ray.o[0]) * n[0] + (p[1] - ray.o[1]) * n[1] + (p[2] - ray.o[2]) * n[2]) / den;
    const q = [ray.o[0] + ray.d[0] * t, ray.o[1] + ray.d[1] * t, ray.o[2] + ray.d[2] * t];
    // a wide table, but a finite one
    const dx = q[0] - target[0], dz = q[2] - target[2], lim = 7, dl = Math.hypot(dx, dz);
    if (dl > lim) { q[0] = target[0] + dx / dl * lim; q[2] = target[2] + dz / dl * lim; }
    q[1] = Math.min(Math.max(q[1], 0.02), 4);
    return q;
  }
  function applyGrab(x, y) {
    const q = dragTarget(x, y);
    if (q) world.moveGrab(q, rotMat(cam.fwd, drag.twist));
  }
  canvas.addEventListener('pointerdown', e => {
    if (drag.mode && e.pointerId !== drag.id && e.pointerType === 'touch') {
      if (drag.mode === 'grab') {
        // a second finger twists the grabbed patch
        drag.second = { id: e.pointerId, x: e.clientX, y: e.clientY };
        drag.twist0 = drag.twist - Math.atan2(e.clientY - drag.lastY, e.clientX - drag.lastX);
      } else if (drag.mode === 'orbit') {
        // a second finger on the table pinches to zoom
        drag.second = { id: e.pointerId, x: e.clientX, y: e.clientY };
        drag.pinch = Math.hypot(e.clientX - drag.lastX, e.clientY - drag.lastY) || 1; drag.zoom0 = state.zoom;
      }
      try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
      return;
    }
    if (drag.mode) return;
    if (e.button !== undefined && e.button > 0 && e.pointerType === 'mouse') return;
    if (state.tool === 'knife') {
      if (state.paused || knifeAnim) { e.preventDefault(); return; }
      drag.mode = 'knife'; drag.id = e.pointerId;
      if (e.pointerType !== 'mouse') { hoverX = e.clientX; hoverY = e.clientY; hoverSeen = true; }
      knife.ax = knife.bx = e.clientX; knife.ay = knife.by = e.clientY;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
      drawStroke(true);
      e.preventDefault();
      return;
    }
    const hit = !state.paused ? (pick(rayFrom(e.clientX, e.clientY)) || pickNear(e.clientX, e.clientY, e.pointerType === 'touch' ? 34 : 18)) : null;
    drag.id = e.pointerId; drag.lastX = e.clientX; drag.lastY = e.clientY;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
    if (hit && lastPickBody >= 0) {
      drag.mode = 'grab'; drag.twist = 0;
      drag.plane = { p: hit, n: cam.fwd.slice() };
      world.beginGrab(world.bodies[lastPickBody], hit, 0.42);
      canvas.dataset.cursor = 'grabbing';
    } else {
      drag.mode = 'orbit';
      canvas.dataset.cursor = 'orbit';
    }
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', e => {
    if (drag.second && e.pointerId === drag.second.id) {
      drag.second.x = e.clientX; drag.second.y = e.clientY;
      if (drag.mode === 'grab') {
        drag.twist = Math.max(-1.3, Math.min(1.3, drag.twist0 + Math.atan2(drag.second.y - drag.lastY, drag.second.x - drag.lastX)));
        applyGrab(drag.lastX, drag.lastY);
      } else if (drag.mode === 'orbit') {
        const dd = Math.hypot(drag.second.x - drag.lastX, drag.second.y - drag.lastY) || 1;
        state.zoom = Math.max(0.45, Math.min(2.4, drag.zoom0 * drag.pinch / dd));
      }
      return;
    }
    if (e.pointerId !== drag.id || !drag.mode) { hoverX = e.clientX; hoverY = e.clientY; hoverDirty = true; hoverSeen = true; return; }
    if (drag.mode === 'knife') { knife.bx = e.clientX; knife.by = e.clientY; drawStroke(true); return; }
    const dx = e.clientX - drag.lastX, dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    if (drag.mode === 'grab') applyGrab(e.clientX, e.clientY);
    else if (!drag.second) {
      state.az = Math.max(-0.6, Math.min(1.9, state.az - dx * 0.006));
      state.el = Math.max(0.1, Math.min(1.3, state.el + dy * 0.005));
    } else {
      const dd = Math.hypot(drag.second.x - drag.lastX, drag.second.y - drag.lastY) || 1;
      state.zoom = Math.max(0.45, Math.min(2.4, drag.zoom0 * drag.pinch / dd));
    }
  });
  const endPointer = e => {
    if (drag.second && e.pointerId === drag.second.id) { drag.second = null; return; }
    if (e.pointerId !== drag.id) return;
    if (drag.mode === 'knife') {
      if (e.type === 'pointerup') {
        knife.bx = e.clientX; knife.by = e.clientY; drawStroke(true);
        const plan = planCut(knife.ax, knife.ay, knife.bx, knife.by);
        if (plan.miss !== undefined) { if (plan.miss) toast(plan.miss); }
        else startCut(plan);
        hoverX = e.clientX; hoverY = e.clientY;
      }
      drawStroke(false);
    }
    if (drag.mode === 'grab') world.endGrab();
    drag.mode = null; drag.id = -1; drag.second = null;
    canvas.dataset.cursor = state.tool === 'knife' ? 'knife' : '';
    hoverDirty = true;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('lostpointercapture', endPointer);
  // wheel: twists the held patch, otherwise zooms when over the stage
  window.addEventListener('wheel', e => {
    if (drag.mode === 'grab') {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      drag.twist = Math.max(-1.3, Math.min(1.3, drag.twist + d * 0.004));
      applyGrab(drag.lastX, drag.lastY);
    } else if (e.target === canvas) {
      e.preventDefault();
      state.zoom = Math.max(0.45, Math.min(2.4, state.zoom * Math.exp(e.deltaY * 0.001)));
    }
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { state.az = 0.62; state.el = 0.5; state.zoom = 1; });
  let hoverX = 0, hoverY = 0, hoverDirty = false;

  // ── UI ──
  const firm = $('#firmness'), damp = $('#damping'), firmOut = $('#firmnessOut'), dampOut = $('#dampingOut');
  const syncSliders = () => {
    world.firmness = firm.value / 100; world.damping = damp.value / 100;
    firmOut.textContent = (firm.value / 100).toFixed(2); dampOut.textContent = (damp.value / 100).toFixed(2);
    world.wakeAll();
  };
  firm.value = Math.round(world.firmness * 100); damp.value = Math.round(world.damping * 100);
  firm.addEventListener('input', syncSliders); damp.addEventListener('input', syncSliders);
  syncSliders();
  $('#nudge').addEventListener('click', () => { if (!state.paused) world.nudge(reduced.matches ? 0.45 : 1); });
  $('#reset').addEventListener('click', () => {
    knifeAnim = null; blade.mode = null;
    world.endGrab(); drag.mode = null;
    world.bodies = [new Body(wholePiece)];
    world.reset(reduced.matches ? 0 : 0.35);
    compose(); acc = 0;
  });
  const hint = $('#hintText');
  function setTool(t) {
    if (t === 'knife' && state.tool !== 'knife' && !knifeAnim) {
      const h = hoverPose(); kp.P = [h.P[0], h.P[1] + 2, h.P[2]]; kp.yaw = h.yaw; kp.roll = h.roll; kp.pitch = h.pitch;
    }
    state.tool = t;
    for (const b of document.querySelectorAll('.tool')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
    document.body.dataset.tool = t;
    canvas.dataset.cursor = t === 'knife' ? 'knife' : '';
    hint.innerHTML = t === 'knife'
      ? '<b>Knife</b>Draw a line across the melon. The knife lines up over it and cuts when you let go. Cut the pieces again, as small as you like.'
      : '<b>Hand</b>Grab the melon or any piece and pull. Scroll, or add a second finger, while holding to twist it. Drag the table to look around.';
  }
  for (const b of document.querySelectorAll('.tool')) b.addEventListener('click', () => setTool(b.dataset.tool));
  setTool('hand');
  $('#slow').addEventListener('change', e => { state.slow = e.target.checked; });
  $('#mesh').addEventListener('change', e => { state.showMesh = e.target.checked; });
  const pauseBtn = $('#pause');
  pauseBtn.addEventListener('click', () => {
    state.paused = !state.paused;
    if (state.paused && drag.mode === 'grab') { world.endGrab(); drag.mode = null; }
    pauseBtn.textContent = state.paused ? 'Resume' : 'Pause';
    pauseBtn.setAttribute('aria-pressed', String(state.paused));
    setStatus(state.paused ? 'WEBGPU · PAUSED' : 'WEBGPU · LIVE', state.paused ? 'paused' : 'live');
  });
  window.addEventListener('keydown', e => {
    if (e.target.closest && e.target.closest('input, button, summary')) return;
    if (e.key === ' ') { e.preventDefault(); pauseBtn.click(); }
    if (e.key === 'n' || e.key === 'N') $('#nudge').click();
    if (e.key === 'r' || e.key === 'R') $('#reset').click();
    if (e.key === 'k' || e.key === 'K') setTool(state.tool === 'knife' ? 'hand' : 'knife');
    if (e.key === 'h' || e.key === 'H') setTool('hand');
  });

  const massOut = $('#massOut'), volOut = $('#volOut'), keOut = $('#keOut'), fpsOut = $('#fpsOut');
  function updateReadouts() {
    // mass from each piece's sampled volume (lattices lose a little at every edge)
    let sampled = 0; for (const b of world.bodies) sampled += b.piece.vol;
    const restV = world.restVolume(), massKg = sampled * KG_PER_UNIT3;
    massOut.textContent = massKg.toFixed(1);
    volOut.textContent = (world.volume() / restV * 100).toFixed(1);
    // KE: v[m/s] = v_sim × 0.1, mass shared out by the sim masses
    const ke = world.kinetic() / world.totalMass() * massKg * 0.01 * 1000; // mJ
    keOut.textContent = ke < 0.05 ? '0.00' : ke < 100 ? ke.toFixed(2) : ke.toFixed(0);
    fpsOut.textContent = fps ? fps.toFixed(0) : '—';
  }

  compose();
  world.reset(reduced.matches ? 0 : 0.35);

  // hooks for automated checks
  window.__melon = {
    world, state, cam, renderer, pick, rayFrom, planCut, startCut, kp, blade,
    get knifeAnim() { return knifeAnim; }, get fps() { return fps; }, get pieces() { return world.bodies.length; },
    setHover(x, y) { hoverX = x; hoverY = y; hoverSeen = true; },
    // step the simulation and the knife by `sec` of sim time, with frames drawn along the way
    advance(sec, build = 12) { for (let t = 0; t < sec - 1e-6; t += 1 / 60) { if (knifeAnim) advanceBuild(knifeAnim.plan, build); updateKnife(1 / 60, 1 / 60); world.step(); } },
    // a whole cut, synchronously: plan, build, install, settle
    cutNow(ax, ay, bx, by) { const p = planCut(ax, ay, bx, by); if (p.miss !== undefined) return p.miss || 'miss'; p.built = runGen(p.gen); blade.n = [-Math.sin(p.yaw), 0, Math.cos(p.yaw)]; installCut(p, 0.35); return 'ok'; },
    frame() { renderFrame(0); },
  };

  // ── loop ──
  let last = performance.now(), acc = 0, readoutT = 0, fps = 0, frames = 0, fpsT = 0, first = true;
  function renderFrame(dt) {
    skinAll();
    follow(dt);
    updateCamera();
    updateLight();
    if (hoverDirty && !drag.mode) {
      hoverDirty = false;
      canvas.dataset.cursor = state.tool === 'knife' ? 'knife' : !state.paused && (pick(rayFrom(hoverX, hoverY)) || pickNear(hoverX, hoverY, 18)) ? 'grab' : '';
    }
    renderer.setUniforms(cam, light, PALETTES[currentPalette], { time: state.time, exposure: 1.0, meshAlpha: state.showMesh ? 0.32 : 0, bg: BG_RENDER });
    renderer.uploadGeometry(state.showMesh);
    renderer.draw(state.showMesh);
  }
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (!state.paused) {
      acc += dt * (state.slow ? 0.25 : 1);
      let steps = 0;
      while (acc >= world.stepDt && steps < 3) { world.step(); acc -= world.stepDt; steps++; }
      if (steps === 3) acc = Math.min(acc, world.stepDt);
      state.time += dt;
    }
    // the knife may swap in new pieces mid-cut, so it goes before skinning
    updateKnife(dt, state.paused ? 0 : dt * (state.slow ? 0.25 : 1));
    renderFrame(dt);
    if (first) { first = false; setStatus('WEBGPU · LIVE', 'live'); document.body.classList.add('ready'); }
    frames++; fpsT += dt; readoutT += dt;
    if (fpsT >= 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
    if (readoutT > 0.15) { readoutT = 0; updateReadouts(); }
    if (!renderer.lost) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch(err => { console.error(err); showFallback('Something went wrong while starting.', String(err && err.message || err)); });
