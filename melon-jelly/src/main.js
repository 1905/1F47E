// ─────────────────────────────────────────────────────────────
//  App: sim ↔ render glue, camera, picking, UI
// ─────────────────────────────────────────────────────────────

import { SHAPE, embed } from './geometry.js';
import { KNIFE, buildKnifeMesh } from './knife.js';
import { initialPiece, splitPiece, lineCrossesPiece, buildWorld } from './pieces.js';
import { SoftBody } from './physics.js';
import { M4, Renderer, QUALITY } from './renderer.js';

const srgbToLin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linToSrgb = c => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const hex = rgb => '#' + rgb.map(c => Math.round(Math.min(1, Math.max(0, linToSrgb(c))) * 255).toString(16).padStart(2, '0')).join('');

// three coordinated varieties (linear RGB)
const PALETTES = {
  crimson: {
    name: 'Crimson',
    flesh: [0.93, 0.07, 0.11], fleshDeep: [0.42, 0.018, 0.035],
    pale: [0.8, 0.86, 0.62], skin: [0.03, 0.13, 0.035], stripe: [0.005, 0.034, 0.01],
    seed: [0.01, 0.0065, 0.005], shadowTint: [0.6, 0.47, 0.46],
    ui: { flesh: [0.62, 0.03, 0.06] },
  },
  golden: {
    name: 'Golden',
    flesh: [0.97, 0.52, 0.05], fleshDeep: [0.6, 0.24, 0.012],
    pale: [0.84, 0.88, 0.64], skin: [0.04, 0.15, 0.03], stripe: [0.007, 0.04, 0.01],
    seed: [0.012, 0.008, 0.005], shadowTint: [0.64, 0.55, 0.44],
    ui: { flesh: [0.72, 0.3, 0.02] },
  },
  rose: {
    name: 'Rosé',
    flesh: [0.95, 0.2, 0.3], fleshDeep: [0.6, 0.08, 0.15],
    pale: [0.84, 0.9, 0.72], skin: [0.06, 0.2, 0.1], stripe: [0.012, 0.06, 0.03],
    seed: [0.014, 0.009, 0.007], shadowTint: [0.64, 0.5, 0.52],
    ui: { flesh: [0.72, 0.16, 0.24] },
  },
};

const BG_SRGB = [0.886, 0.875, 0.855]; // #E2DFDA — the studio sweep
const BG_LIN = BG_SRGB.map(srgbToLin);
// tone mapper subtracts a small toe offset; lift the backdrop so it lands on the page colour
const BG_RENDER = BG_LIN.map(c => c + 0.04);

const SCALE_CM = 3.5;      // illustrative: 1 simulation unit ≈ 3.5 cm
const DENSITY = 1.3;       // g/cm³, gummy candy

const $ = s => document.querySelector(s);

function setStatus(text, state) {
  const el = $('#status');
  $('#statusText').textContent = text;
  el.dataset.state = state;
}

function showFallback(title, detail) {
  const f = $('#fallback');
  f.hidden = false;
  $('#fallbackTitle').textContent = title;
  $('#fallbackDetail').textContent = detail;
  document.body.classList.add('no-gpu');
  setStatus('WEBGPU · UNAVAILABLE', 'off');
  for (const el of document.querySelectorAll('.panel button, .panel input')) el.disabled = true;
}

async function main() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const canvas = $('#gl');

  // ── build everything once ──
  // the world is a list of pieces; at the start there is one — the whole slice
  let pieces = [initialPiece()];
  let world = buildWorld(pieces);
  let sim = new SoftBody(world.sim, { firmness: 0.4, damping: reduced.matches ? 0.65 : 0.45 });
  let renderMesh = world.render;
  let nV = renderMesh.rest.length / 3;
  let skinIdx = world.skinIdx, skinW = world.skinW;
  let index = renderMesh.index;
  let bodyTriEnd = renderMesh.body.count;
  let vComp = renderMesh.vComp;

  let currentPalette = 'crimson';
  const swatches = $('#swatches');
  for (const [key, p] of Object.entries(PALETTES)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'swatch'; b.dataset.key = key;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', p.name + ' variety');
    b.innerHTML = `<span class="chip"><i style="background:${hex(p.skin)}"></i><i style="background:${hex(p.pale.map(c => c * 0.95))}"></i><i style="background:${hex(p.ui.flesh)}"></i></span><span class="swname">${p.name}</span>`;
    b.addEventListener('click', () => setPalette(key));
    swatches.appendChild(b);
  }
  function setPalette(key) {
    currentPalette = key;
    for (const b of swatches.children) b.setAttribute('aria-checked', String(b.dataset.key === key));
    document.documentElement.style.setProperty('--accent', hex(PALETTES[key].ui.flesh));
  }
  setPalette('crimson');

  let renderer;
  try {
    if (!navigator.gpu) throw new Error('no-webgpu');
    Renderer.quality = window.__jellyQuality || 'studio';
    renderer = await Renderer.create(canvas, renderMesh, sim.edges, sim.n);
  } catch (err) {
    console.warn(err);
    const msg = String(err && err.message || err);
    if (msg === 'no-webgpu') showFallback('This specimen needs WebGPU.', 'Your browser does not expose navigator.gpu, so there is nothing to render with. Rather than fake the jelly with a lesser renderer, the study stays dark. Try a current Chrome, Edge or Safari (or Firefox on Windows) with hardware acceleration switched on.');
    else if (msg === 'no-adapter') showFallback('No WebGPU adapter was found.', 'WebGPU exists in this browser but it could not reach a graphics adapter — usually because hardware acceleration is disabled or the GPU is on a block list. Enable acceleration or try another device.');
    else showFallback('The renderer could not start.', msg.slice(0, 400));
    return;
  }
  // a lost device (driver reset, GPU switch) gets two attempts at a clean rebuild before giving up
  let recoveries = 0;
  const wire = r => {
    r.onError = e => console.error('[webgpu]', e.message);
    r.onLost = async info => {
      if (info.reason === 'destroyed') return;
      if (recoveries++ < 2) {
        try {
          const fresh = await Renderer.create(canvas, renderMesh, sim.edges, sim.n);
          fresh.dyn = dyn; fresh.setKnife(knifeMesh); renderer = fresh; wire(fresh); resize();
          requestAnimationFrame(frame);
          return;
        } catch (e) { console.warn(e); }
      }
      showFallback('The GPU device was lost.', (info.message || '') + ' Reload the page to restart the study.');
    };
  };
  wire(renderer);
  let dyn = renderer.dyn;

  // ── state ──
  const state = {
    paused: false, slow: false, showMesh: false, tool: 'hand',
    az: 0.62, el: 0.6, zoom: 1,
    time: 0,
  };


  // ── skinning: every render vertex (body, seeds, bubbles) follows its tetrahedron ──
  function skin() {
    const x = sim.x;
    for (let v = 0; v < nV; v++) {
      const i4 = 4 * v, o = 6 * v;
      const a = 3 * skinIdx[i4], b = 3 * skinIdx[i4 + 1], c = 3 * skinIdx[i4 + 2], d = 3 * skinIdx[i4 + 3];
      const w0 = skinW[i4], w1 = skinW[i4 + 1], w2 = skinW[i4 + 2], w3 = skinW[i4 + 3];
      dyn[o] = x[a] * w0 + x[b] * w1 + x[c] * w2 + x[d] * w3;
      dyn[o + 1] = x[a + 1] * w0 + x[b + 1] * w1 + x[c + 1] * w2 + x[d + 1] * w3;
      dyn[o + 2] = x[a + 2] * w0 + x[b + 2] * w1 + x[c + 2] * w2 + x[d + 2] * w3;
      dyn[o + 3] = 0; dyn[o + 4] = 0; dyn[o + 5] = 0;
    }
    for (let t = 0; t < index.length; t += 3) {
      const a = 6 * index[t], b = 6 * index[t + 1], c = 6 * index[t + 2];
      const e1x = dyn[b] - dyn[a], e1y = dyn[b + 1] - dyn[a + 1], e1z = dyn[b + 2] - dyn[a + 2];
      const e2x = dyn[c] - dyn[a], e2y = dyn[c + 1] - dyn[a + 1], e2z = dyn[c + 2] - dyn[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      dyn[a + 3] += nx; dyn[a + 4] += ny; dyn[a + 5] += nz;
      dyn[b + 3] += nx; dyn[b + 4] += ny; dyn[b + 5] += nz;
      dyn[c + 3] += nx; dyn[c + 4] += ny; dyn[c + 5] += nz;
    }
    for (let o = 0; o < dyn.length; o += 6) {
      const l = Math.hypot(dyn[o + 3], dyn[o + 4], dyn[o + 5]) || 1;
      dyn[o + 3] /= l; dyn[o + 4] /= l; dyn[o + 5] /= l;
    }
  }

  // ── camera & framing (keeps the slice clear of the text and panel) ──
  const cam = { viewProj: null, view: null, invViewProj: null, pos: [0, 0, 0], fwd: [0, 0, -1] };
  const target = [0, 0.24, 1.0];
  const FOV = 27 * Math.PI / 180;
  function safeRect(W, H) {
    const cr = canvas.getBoundingClientRect();
    if (document.body.classList.contains('stacked')) return { x: 0, y: 0, w: cr.width, h: cr.height };
    const panel = $('.panel').getBoundingClientRect();
    const head = $('.masthead').getBoundingClientRect();
    const read = $('.readouts').getBoundingClientRect();
    const left = Math.min(head.right - cr.left, cr.width * 0.24) * 0.55;
    const right = panel.left - cr.left - 12;
    const top = Math.min(head.bottom - cr.top, cr.height * 0.34) * 0.5;
    const bottom = read.top - cr.top + 24;
    return { x: left, y: top, w: Math.max(200, right - left), h: Math.max(200, bottom - top) };
  }
  // the camera eases after the slice if it is thrown or dragged far from home (never while holding it)
  const home = target.slice();
  function followSlice(dt) {
    if (drag.mode === 'grab') return;
    const c = sim.centroid();
    const k = 1 - Math.exp(-dt * 1.4);
    const gx = home[0] + (c[0] - 0.0) * 0.7, gz = home[2] + (c[2] - 1.01) * 0.7;
    target[0] += (gx - target[0]) * k; target[2] += (gz - target[2]) * k;
  }
  function updateCamera() {
    const W = renderer.w, H = renderer.h;
    const cr = canvas.getBoundingClientRect();
    const r = safeRect(W, H);
    const aspect = W / H;
    const hf = r.h / cr.height, wf = r.w / cr.width;
    // fit the slice's footprint: wider than it is tall from this angle
    const Rh = 1.32, Rv = 1.0;
    const t2 = Math.tan(FOV / 2);
    const dist = Math.max(Rv / (t2 * 0.9 * hf), Rh / (t2 * 0.92 * aspect * wf)) * state.zoom;
    const ce = Math.cos(state.el);
    const eye = [target[0] + dist * Math.sin(state.az) * ce, target[1] + dist * Math.sin(state.el), target[2] + dist * Math.cos(state.az) * ce];
    const view = M4.lookAt(eye, target, [0, 1, 0]);
    const proj = M4.perspective(FOV, aspect, 0.1, 60);
    // lens shift so the target lands at the centre of the safe rect
    const cx = (r.x + r.w / 2) / cr.width, cy = (r.y + r.h / 2) / cr.height;
    proj[8] -= (cx * 2 - 1); proj[9] -= -(cy * 2 - 1);
    cam.view = view; cam.viewProj = M4.mul(proj, view); cam.invViewProj = M4.invert(cam.viewProj);
    cam.pos = eye;
    const f = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    const fl = Math.hypot(...f); cam.fwd = f.map(v => v / fl);
  }

  // light rig: key from behind-left and above (so thin edges glow toward the camera)
  const keyDir = (() => { const d = [-0.45, 0.86, -0.36]; const l = Math.hypot(...d); return d.map(v => v / l); })();
  const light = { dir: keyDir, intensity: 2.3, lightVP: null, topVP: null };
  function updateLight() {
    // shadow and height maps are centred on the slice itself so they never lose it
    const c = sim.centroid();
    const at = [c[0], 0.3, c[2]];
    light.lightVP = M4.mul(M4.ortho(-2.4, 2.4, -2.4, 2.4, 0.1, 14), M4.lookAt([at[0] + keyDir[0] * 7, at[1] + keyDir[1] * 7, at[2] + keyDir[2] * 7], at, [0, 0, 1]));
    // top-down height map: camera under the floor looking up so the lowest surface wins; depth = (y + 1) / 5
    light.topVP = M4.mul(M4.ortho(-2.6, 2.6, -2.6, 2.6, 0, 5), M4.lookAt([at[0], -1, at[2]], [at[0], 1, at[2]], [0, 0, -1]));
  }

  // ── resize ──
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
  let lastPickTri = -1;
  function pick(ray) {
    let best = Infinity;
    const { o, d } = ray;
    for (let t = 0; t < bodyTriEnd; t += 3) {
      const a = 6 * index[t], b = 6 * index[t + 1], c = 6 * index[t + 2];
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
      if (tt > 1e-4 && tt < best) { best = tt; lastPickTri = t; }
    }
    return best < Infinity ? [o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best] : null;
  }

  // forgiving fallback for grabs that land just outside the rounded silhouette
  function pickNear(clientX, clientY, maxPx) {
    const r = canvas.getBoundingClientRect(), M = cam.viewProj, x = sim.x;
    let best = -1, bd = maxPx * maxPx;
    for (let i = 0; i < sim.n; i++) {
      const X = x[3 * i], Y = x[3 * i + 1], Z = x[3 * i + 2];
      const w = M[3] * X + M[7] * Y + M[11] * Z + M[15];
      const sx = r.left + ((M[0] * X + M[4] * Y + M[8] * Z + M[12]) / w * 0.5 + 0.5) * r.width;
      const sy = r.top + (0.5 - (M[1] * X + M[5] * Y + M[9] * Z + M[13]) / w * 0.5) * r.height;
      const d = (sx - clientX) ** 2 + (sy - clientY) ** 2 - w * 1e-3; // prefer nearer particles on ties
      if (d < bd) { bd = d; best = i; }
    }
    return best < 0 ? null : [x[3 * best], x[3 * best + 1], x[3 * best + 2]];
  }

  // ── knife ──
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
    clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('on'), 2200);
  }
  const MAX_PIECES = 14;

  // Cut: the stroke, seen on the top of the slice, defines a vertical blade plane; every piece the
  // stroke passes over is split along it. The plane is carried into each piece's rest frame
  // (best-fit rotation of the deformed piece), where it becomes a straight line across the slice.
  // Planning happens on release (so the heavy rebuild is done before the knife moves); the new
  // world is swapped in mid-stroke, at the moment the edge breaks through.
  const rayPlaneY = (ray, y) => {
    if (ray.d[1] > -1e-4) return null;
    const t = (y - ray.o[1]) / ray.d[1];
    return t > 0 ? [ray.o[0] + ray.d[0] * t, y, ray.o[2] + ray.d[2] * t] : null;
  };
  const camRightYaw = () => -state.az;          // blade direction that shows its face to the camera
  const canonicalYaw = (dx, dz) => {
    let yaw = Math.atan2(dz, dx);
    if (Math.cos(yaw - camRightYaw()) < 0) yaw += Math.PI;   // keep the handle on the left, tip on the right
    return yaw;
  };
  function planCut(ax, ay, bx, by) {
    if (Math.hypot(bx - ax, by - ay) < 24) return { miss: '' };
    const hit = new Set(); let yTop = 0, t0 = -1, t1 = -1;
    for (let k = 0; k <= 48; k++) {
      const t = k / 48;
      const p = pick(rayFrom(ax + (bx - ax) * t, ay + (by - ay) * t));
      if (p && lastPickTri >= 0) { hit.add(vComp[index[lastPickTri]]); yTop = Math.max(yTop, p[1]); if (t0 < 0) t0 = t; t1 = t; }
    }
    if (!hit.size) return { miss: 'Missed — draw the blade across the slice.' };
    if (pieces.length + hit.size > MAX_PIECES) return { miss: 'That’s plenty of pieces. Reset to start a fresh slice.' };
    // the stroke as seen on the surface it was drawn over
    const at = t => rayPlaneY(rayFrom(ax + (bx - ax) * t, ay + (by - ay) * t), yTop);
    const A = at(0) || at(t0), B = at(1) || at(t1);
    const A2 = at(t0), B2 = at(t1);
    if (!A || !B || !A2 || !B2) return { miss: 'Missed — draw the blade across the slice.' };
    let dx = B[0] - A[0], dz = B[2] - A[2];
    const dl = Math.hypot(dx, dz); if (dl < 0.05) return { miss: '' };
    dx /= dl; dz /= dl;
    const n = [-dz, 0, dx];
    const o = [(A2[0] + B2[0]) / 2, yTop, (A2[2] + B2[2]) / 2];
    const next = [], sep = [];
    let thin = 0, cut = 0;
    pieces.forEach((pc, c) => {
      if (!hit.has(c)) { next.push(pc); return; }
      const F = sim.pieceFrame(c), R = F.R;
      // world plane n·x = n·o  →  rest plane nr·X = nr·pr
      const nr = [R[0] * n[0] + R[3] * n[1] + R[6] * n[2], R[1] * n[0] + R[4] * n[1] + R[7] * n[2], R[2] * n[0] + R[5] * n[1] + R[8] * n[2]];
      const d = [o[0] - F.cw[0], o[1] - F.cw[1], o[2] - F.cw[2]];
      const pr = [R[0] * d[0] + R[3] * d[1] + R[6] * d[2] + F.cr[0], R[1] * d[0] + R[4] * d[1] + R[7] * d[2] + F.cr[1], R[2] * d[0] + R[5] * d[1] + R[8] * d[2] + F.cr[2]];
      const L = Math.hypot(nr[0], nr[2]);
      if (L < 0.3) { next.push(pc); thin++; return; }   // piece lying on its side: the blade runs along its faces
      const cc = (nr[0] * pr[0] + nr[1] * pr[1] + nr[2] * pr[2] - nr[1] * SHAPE.T / 2) / L;
      const a = nr[0] / L, b = nr[2] / L;
      if (!lineCrossesPiece(pc.I, a, b, cc)) { next.push(pc); return; }
      const parts = splitPiece(pc.I, a, b, cc);
      if (!parts) { next.push(pc); thin++; return; }
      cut++;
      parts.forEach((I, side) => {
        // which way does this half lie in the world? it is nudged away from the blade on that side
        let su = 0, sw = 0; for (const p of I) { su += p[0]; sw += p[1]; } su /= I.length; sw /= I.length;
        const X = [su - F.cr[0], SHAPE.T / 2 - F.cr[1], sw - F.cr[2]];
        const W = [R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + F.cw[0], R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + F.cw[1], R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + F.cw[2]];
        const sg = Math.sign(n[0] * (W[0] - o[0]) + n[2] * (W[2] - o[2])) || (side ? 1 : -1);
        sep.push({ piece: next.length, dir: [n[0] * sg, 0, n[2] * sg] });
        next.push({ I, cache: null });
      });
    });
    if (!cut) return { miss: thin ? 'Too thin to cut there.' : 'Missed — draw the blade across the slice.' };
    // do the expensive part now, while the knife is still in the air
    const w = buildWorld(next);
    const ns = new SoftBody(w.sim, { firmness: sim.firmness, damping: sim.damping });
    return { next, sep, world: w, sim: ns, M: o, yTop, yaw: canonicalYaw(dx, dz) };
  }
  // instant cut without the knife animation (kept for automated checks)
  function performCut(ax, ay, bx, by) {
    const plan = planCut(ax, ay, bx, by);
    if (plan.miss !== undefined) { if (plan.miss) toast(plan.miss); return false; }
    installWorld(plan.next, plan.sep, plan, 0.75, 0.35);
    return true;
  }

  // Rebuild the simulation and the GPU buffers for a new set of pieces, carrying the current
  // positions and velocities across by interpolation in the shared rest frame.
  function installWorld(nextPieces, sep = [], pre = null, sepSpeed = 0.75, hop = 0.35) {
    if (drag.mode === 'grab') { sim.endGrab(); drag.mode = null; }
    const old = sim;
    const w = pre ? pre.world : buildWorld(nextPieces);
    const ns = pre ? pre.sim : new SoftBody(w.sim, { firmness: old.firmness, damping: old.damping });
    ns.firmness = old.firmness; ns.damping = old.damping;
    if (old) {
      const e = embed(old.rest, old.tets, ns.rest);
      for (let i = 0; i < ns.n; i++) {
        const t = e.tetOf[i];
        for (let k = 0; k < 3; k++) {
          let xs = 0, vs = 0;
          for (let j = 0; j < 4; j++) { const q = old.tets[4 * t + j]; xs += old.x[3 * q + k] * e.w[4 * i + j]; vs += old.v[3 * q + k] * e.w[4 * i + j]; }
          ns.x[3 * i + k] = xs; ns.v[3 * i + k] = vs;
        }
        if (ns.x[3 * i + 1] < 0) ns.x[3 * i + 1] = 0;
      }
      for (const sp of sep) for (let i = 0; i < ns.n; i++) if (ns.comp[i] === sp.piece) {
        ns.v[3 * i] += sp.dir[0] * sepSpeed; ns.v[3 * i + 1] += Math.abs(sp.dir[1]) * 0.2 * hop + hop; ns.v[3 * i + 2] += sp.dir[2] * sepSpeed;
      }
      ns.prev.set(ns.x);
    }
    pieces = nextPieces; world = w; sim = ns;
    sim.blade = blade;
    blade.side = new Int8Array(sim.nComp);
    for (const sp of sep) blade.side[sp.piece] = Math.sign(sp.dir[0] * blade.n[0] + sp.dir[2] * blade.n[2]) || 0;
    renderMesh = w.render; nV = renderMesh.rest.length / 3;
    skinIdx = w.skinIdx; skinW = w.skinW; index = renderMesh.index; bodyTriEnd = renderMesh.body.count; vComp = renderMesh.vComp;
    renderer.setMesh(renderMesh, sim.edges, sim.n);
    dyn = renderer.dyn;
    window.__melon.sim = sim;
    $('#piecesOut').textContent = String(pieces.length);
    hoverDirty = true;
  }

  // ── the visible knife: hovers under the pointer, lines up over the stroke, then cuts ──
  const knifeMesh = buildKnifeMesh();
  renderer.setKnife(knifeMesh);
  const HOVER_H = 0.42;                           // edge height above the top of the slice while hovering
  const kp = { P: [0, SHAPE.T + HOVER_H + 1.4, 0.9], yaw: -0.62, roll: 0.16, pitch: 0.05 };
  const blade = { holdY: 0, mode: null, p: [0, 0, 0], d: [1, 0, 0], n: [0, 0, 1], a0: -KNIFE.xr, a1: KNIFE.Lb - KNIFE.xr, top: KNIFE.H * 0.95, halfGap: 0.03, side: null };
  sim.blade = blade;
  let knifeAnim = null, hoverSeen = false;
  const wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));
  const lerp = (a, b, s) => a + (b - a) * s;
  const lerp3 = (a, b, s) => [lerp(a[0], b[0], s), lerp(a[1], b[1], s), lerp(a[2], b[2], s)];
  const ease = s => { s = Math.min(1, Math.max(0, s)); return s * s * (3 - 2 * s); };
  function knifeBasis(yaw, roll, pitch) {
    const d = [Math.cos(yaw), 0, Math.sin(yaw)], z = [-d[2], 0, d[0]];
    // roll about the blade (tips the face up toward the viewer), then pitch (tip down)
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
      const lx = r[v] - xr, ly = r[v + 1], lz = r[v + 2];
      out[o] = P[0] + X[0] * lx + Y[0] * ly + Z[0] * lz;
      out[o + 1] = P[1] + X[1] * lx + Y[1] * ly + Z[1] * lz;
      out[o + 2] = P[2] + X[2] * lx + Y[2] * ly + Z[2] * lz;
      const nx = nr[v], ny = nr[v + 1], nz = nr[v + 2];
      out[o + 3] = X[0] * nx + Y[0] * ny + Z[0] * nz;
      out[o + 4] = X[1] * nx + Y[1] * ny + Z[1] * nz;
      out[o + 5] = X[2] * nx + Y[2] * ny + Z[2] * nz;
    }
  }
  // where the knife wants to be when it is not cutting
  function hoverPose() {
    let q = hoverSeen ? rayPlaneY(rayFrom(hoverX, hoverY), SHAPE.T + HOVER_H) : null;
    if (q) { const dx = q[0] - target[0], dz = q[2] - target[2], dl = Math.hypot(dx, dz); if (dl > 3) { q[0] = target[0] + dx / dl * 3; q[2] = target[2] + dz / dl * 3; } }
    if (!q) { const c = sim.centroid(); q = [c[0] + 0.1, SHAPE.T + HOVER_H, c[2] + 0.25]; }
    return { P: q, yaw: camRightYaw(), roll: 0.16, pitch: 0.05 };
  }
  // while the stroke is being drawn: lined up over it, edge just above the jelly
  function strokePose() {
    const h = SHAPE.T + 0.1;
    const A = rayPlaneY(rayFrom(knife.ax, knife.ay), h), B = rayPlaneY(rayFrom(knife.bx, knife.by), h);
    if (!A || !B) return hoverPose();
    const dl = Math.hypot(B[0] - A[0], B[2] - A[2]);
    const yaw = dl > 0.08 ? canonicalYaw(B[0] - A[0], B[2] - A[2]) : kp.yaw;
    return { P: [(A[0] + B[0]) / 2, h, (A[2] + B[2]) / 2], yaw, roll: 0.08, pitch: 0 };
  }
  function easeToward(pose, k) {
    kp.P = lerp3(kp.P, pose.P, k);
    kp.yaw += wrapA(pose.yaw - kp.yaw) * k;
    kp.roll = lerp(kp.roll, pose.roll, k); kp.pitch = lerp(kp.pitch, pose.pitch, k);
  }
  // the cut, as a little piece of choreography (seconds)
  const KT = { align: 0.16, press: 0.42, through: 0.6, hold: 0.7, lift: 1.08 };
  function startCut(plan) {
    knifeAnim = { t: 0, plan, from: { P: kp.P.slice(), yaw: kp.yaw, roll: kp.roll, pitch: kp.pitch }, committed: false };
  }
  function runKnifeAnim(dt) {
    const a = knifeAnim, pl = a.plan;
    a.t += dt;
    const t = a.t, d = [Math.cos(pl.yaw), 0, Math.sin(pl.yaw)], M = pl.M;
    const at = (s, y) => [M[0] + d[0] * s, y, M[2] + d[2] * s];
    const P1 = at(-0.12, pl.yTop + 0.1), P2 = at(0.0, pl.yTop - 0.13), P3 = at(0.2, 0.004);
    if (t < KT.align) {
      const s = ease(t / KT.align);
      kp.P = lerp3(a.from.P, P1, s);
      kp.yaw = a.from.yaw + wrapA(pl.yaw - a.from.yaw) * s;
      kp.roll = lerp(a.from.roll, 0, s); kp.pitch = lerp(a.from.pitch, 0, s);
      blade.mode = null;
    } else if (t < KT.press) {
      // the edge meets the jelly and pushes it down before it gives
      const s = (t - KT.align) / (KT.press - KT.align);
      kp.P = lerp3(P1, P2, s * s); kp.yaw = pl.yaw; kp.roll = 0; kp.pitch = 0;
      blade.mode = 'press';
    } else if (t < KT.hold) {
      if (!a.committed) {
        a.committed = true;
        blade.n = [-d[2], 0, d[0]];
        blade.holdY = kp.P[1];
        const tc = performance.now();
        installWorld(pl.next, pl.sep, pl, 0.22, 0);
        window.__melon.lastCommitMs = performance.now() - tc;
      }
      const s = 1 - Math.pow(1 - Math.min(1, (t - KT.press) / (KT.through - KT.press)), 2);
      kp.P = lerp3(P2, P3, s);
      blade.halfGap = 0.012 + 0.02 * s;
      blade.mode = 'split';
    } else if (t < KT.lift) {
      blade.mode = null;
      const s = ease((t - KT.hold) / (KT.lift - KT.hold));
      const h = state.tool === 'knife' ? hoverPose() : { P: [P3[0], P3[1] + 2.5, P3[2]], yaw: pl.yaw, roll: 0.3, pitch: 0.05 };
      kp.P = lerp3(P3, h.P, s);
      kp.yaw = pl.yaw + wrapA(h.yaw - pl.yaw) * s;
      kp.roll = lerp(0, h.roll, s); kp.pitch = lerp(0, h.pitch, s);
    } else {
      knifeAnim = null; blade.mode = null;
    }
  }
  function updateKnife(dt, animDt) {
    if (state.tool !== 'knife' && !knifeAnim) { renderer.knifeVisible = false; blade.mode = null; return; }
    if (knifeAnim) runKnifeAnim(animDt);
    else easeToward(drag.mode === 'knife' ? strokePose() : hoverPose(), 1 - Math.exp(-dt * 16));
    blade.p = kp.P; blade.d = [Math.cos(kp.yaw), 0, Math.sin(kp.yaw)];
    if (!knifeAnim || !knifeAnim.committed) blade.n = [-blade.d[2], 0, blade.d[0]];
    poseKnife();
    renderer.knifeVisible = true;
  }

  // ── pointer interaction ──
  const drag = { mode: null, id: -1, plane: null, twist: 0, twist0: 0, second: null, lastX: 0, lastY: 0 };
  function rotMat(axis, ang) {
    const [x, y, z] = axis, c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
    return [t * x * x + c, t * x * y - s * z, t * x * z + s * y,
      t * x * y + s * z, t * y * y + c, t * y * z - s * x,
      t * x * z - s * y, t * y * z + s * x, t * z * z + c];
  }
  function dragTarget(clientX, clientY) {
    const ray = rayFrom(clientX, clientY);
    const { p, n } = drag.plane;
    const den = ray.d[0] * n[0] + ray.d[1] * n[1] + ray.d[2] * n[2];
    if (Math.abs(den) < 1e-5) return null;
    const t = ((p[0] - ray.o[0]) * n[0] + (p[1] - ray.o[1]) * n[1] + (p[2] - ray.o[2]) * n[2]) / den;
    const q = [ray.o[0] + ray.d[0] * t, ray.o[1] + ray.d[1] * t, ray.o[2] + ray.d[2] * t];
    // keep the grab within a generous but finite reach, and above the floor
    const dx = q[0] - target[0], dz = q[2] - target[2], lim = 3.4, dl = Math.hypot(dx, dz);
    if (dl > lim) { q[0] = target[0] + dx / dl * lim; q[2] = target[2] + dz / dl * lim; }
    q[1] = Math.min(Math.max(q[1], 0.02), 3.2);
    return q;
  }
  function applyGrab(x, y) {
    const q = dragTarget(x, y);
    if (q) sim.moveGrab(q, rotMat(cam.fwd, drag.twist));
  }
  canvas.addEventListener('pointerdown', e => {
    if (drag.mode === 'grab' && e.pointerId !== drag.id && e.pointerType === 'touch') {
      // second finger twists the grabbed patch
      drag.second = { id: e.pointerId, x: e.clientX, y: e.clientY };
      drag.twist0 = drag.twist - Math.atan2(e.clientY - drag.lastY, e.clientX - drag.lastX);
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
    if (hit) {
      drag.mode = 'grab'; drag.twist = 0;
      drag.plane = { p: hit, n: cam.fwd.slice() };
      sim.beginGrab(hit, 0.4);
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
      drag.twist = drag.twist0 + Math.atan2(drag.second.y - drag.lastY, drag.second.x - drag.lastX);
      drag.twist = Math.max(-1.3, Math.min(1.3, drag.twist));
      applyGrab(drag.lastX, drag.lastY);
      return;
    }
    if (e.pointerId !== drag.id || !drag.mode) { hoverX = e.clientX; hoverY = e.clientY; hoverDirty = true; hoverSeen = true; return; }
    if (drag.mode === 'knife') { knife.bx = e.clientX; knife.by = e.clientY; drawStroke(true); return; }
    const dx = e.clientX - drag.lastX, dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    if (drag.mode === 'grab') applyGrab(e.clientX, e.clientY);
    else {
      state.az = Math.max(-0.35, Math.min(1.6, state.az - dx * 0.006));
      state.el = Math.max(0.12, Math.min(1.25, state.el + dy * 0.005));
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
    if (drag.mode === 'grab') sim.endGrab();
    drag.mode = null; drag.id = -1; drag.second = null;
    canvas.dataset.cursor = state.tool === 'knife' ? 'knife' : '';
    hoverDirty = true;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('lostpointercapture', endPointer);
  // wheel: twists the held patch (wherever the pointer is), otherwise zooms when over the stage
  window.addEventListener('wheel', e => {
    if (drag.mode === 'grab') {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      drag.twist = Math.max(-1.3, Math.min(1.3, drag.twist + d * 0.004));
      applyGrab(drag.lastX, drag.lastY);
    } else if (e.target === canvas) {
      e.preventDefault();
      state.zoom = Math.max(0.65, Math.min(1.6, state.zoom * Math.exp(e.deltaY * 0.001)));
    }
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { state.az = 0.62; state.el = 0.6; state.zoom = 1; });
  let hoverX = 0, hoverY = 0, hoverDirty = false;

  // ── UI ──
  const firm = $('#firmness'), damp = $('#damping');
  const firmOut = $('#firmnessOut'), dampOut = $('#dampingOut');
  const syncSliders = () => {
    sim.firmness = firm.value / 100; sim.damping = damp.value / 100;
    firmOut.textContent = (firm.value / 100).toFixed(2);
    dampOut.textContent = (damp.value / 100).toFixed(2);
  };
  firm.value = Math.round(sim.firmness * 100); damp.value = Math.round(sim.damping * 100);
  firm.addEventListener('input', syncSliders); damp.addEventListener('input', syncSliders);
  syncSliders();


  $('#nudge').addEventListener('click', () => { if (!state.paused) sim.nudge(reduced.matches ? 0.45 : 1); });
  const wholePiece = pieces[0];   // keeps its built meshes, so Reset is instant
  $('#reset').addEventListener('click', () => {
    knifeAnim = null; blade.mode = null;
    if (pieces.length > 1) installWorld([wholePiece]);
    sim.reset(reduced.matches ? 0 : 0.35); acc = 0;
  });
  // tools: hand (grab and pull) or knife (draw across the slice to cut it)
  const hint = $('#hintText');
  function setTool(t) {
    if (t === 'knife' && state.tool !== 'knife' && !knifeAnim) {
      // the knife drops in from above
      const h = hoverPose(); kp.P = [h.P[0], h.P[1] + 1.6, h.P[2]]; kp.yaw = h.yaw; kp.roll = h.roll; kp.pitch = h.pitch;
    }
    state.tool = t;
    for (const b of document.querySelectorAll('.tool')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
    document.body.dataset.tool = t;
    canvas.dataset.cursor = t === 'knife' ? 'knife' : '';
    hint.innerHTML = t === 'knife'
      ? '<b>Knife</b>Draw a line across the slice — the knife lines up over it and cuts when you let go. Cut the pieces again, as small as you like.'
      : '<b>Hand</b>Grab any piece — tip, corner, flesh or rind — and pull. Scroll, or add a second finger, while holding to twist it.';
  }
  for (const b of document.querySelectorAll('.tool')) b.addEventListener('click', () => setTool(b.dataset.tool));
  setTool('hand');
  $('#slow').addEventListener('change', e => { state.slow = e.target.checked; });
  $('#mesh').addEventListener('change', e => { state.showMesh = e.target.checked; });
  const pauseBtn = $('#pause');
  pauseBtn.addEventListener('click', () => {
    state.paused = !state.paused;
    if (state.paused && drag.mode === 'grab') { sim.endGrab(); drag.mode = null; }
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

  $('#nParticles').textContent = sim.n.toLocaleString('en');
  $('#nTets').textContent = sim.nT.toLocaleString('en');
  const massOut = $('#massOut'), volOut = $('#volOut'), keOut = $('#keOut');
  let massG = 0;
  function updateReadouts() {
    massG = sim.totalRestVolume * SCALE_CM ** 3 * DENSITY;
    massOut.textContent = massG.toFixed(0);
    volOut.textContent = (sim.volumeRatio() * 100).toFixed(1);
    // KE with the illustrative length scale: v[m/s] = v_sim × 0.035, m[kg] = share of the candy's mass
    const ke = sim.kineticEnergy() / sim.totalMass * (massG / 1000) * (SCALE_CM / 100) ** 2; // J
    const uj = ke * 1e6;
    keOut.textContent = uj < 0.05 ? '0.00' : uj < 100 ? uj.toFixed(2) : uj.toFixed(0);
  }

  // expose a small hook for automated checks
  window.__melon = { sim, state, cam, pick, rayFrom, renderer, performCut, planCut, startCut, kp, blade, get knifeAnim() { return knifeAnim; }, setHover(x, y) { hoverX = x; hoverY = y; hoverSeen = true; },
    advance(sec) { for (let t = 0; t < sec - 1e-6; t += 1 / 60) { updateKnife(1 / 60, 1 / 60); sim.step(); } },
    compStats() { const c = sim.nComp, out = []; for (let k = 0; k < c; k++) { let n = 0, x = 0, y = 0, z = 0, v = 0; for (let i = 0; i < sim.n; i++) if (sim.comp[i] === k) { n++; x += sim.x[3 * i]; y += sim.x[3 * i + 1]; z += sim.x[3 * i + 2]; v = Math.max(v, Math.hypot(sim.v[3 * i], sim.v[3 * i + 1], sim.v[3 * i + 2])); } out.push([x / n, y / n, z / n, v].map(q => +q.toFixed(3))); } return out; }, get pieces() { return pieces.length; }, get fps() { return fps; } };

  // ── loop ──
  sim.reset(reduced.matches ? 0 : 0.35);
  let last = performance.now(), fpsStart = last, acc = 0, readoutT = 0, fps = 60, frames = 0, fpsT = 0, first = true;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (!state.paused) {
      acc += dt * (state.slow ? 0.25 : 1);
      let steps = 0;
      while (acc >= sim.stepDt && steps < 3) { sim.step(); acc -= sim.stepDt; steps++; }
      if (steps === 3) acc = Math.min(acc, sim.stepDt);
      state.time += dt;
    }
    // the knife may swap in a new world mid-cut, so it goes before skinning
    updateKnife(dt, state.paused ? 0 : dt * (state.slow ? 0.25 : 1));
    skin();
    followSlice(dt);
    updateCamera();
    updateLight();
    if (hoverDirty && !drag.mode) {
      hoverDirty = false;
      canvas.dataset.cursor = state.tool === 'knife' ? 'knife' : !state.paused && (pick(rayFrom(hoverX, hoverY)) || pickNear(hoverX, hoverY, 18)) ? 'grab' : '';
    }
    renderer.setUniforms(cam, light, PALETTES[currentPalette], {
      time: state.time, shape: [SHAPE.T, SHAPE.Ro, SHAPE.skin, SHAPE.pale],
      exposure: 1.0, meshAlpha: state.showMesh ? 0.32 : 0, bg: BG_RENDER,
    });
    renderer.uploadGeometry(sim.x, state.showMesh);
    renderer.draw(state.showMesh);
    if (first) { first = false; setStatus('WEBGPU · LIVE', 'live'); document.body.classList.add('ready'); }
    readoutT += dt; frames++; fpsT += dt;
    if (fpsT > 0.5) { fps = frames / ((now - fpsStart) / 1000); frames = 0; fpsT = 0; fpsStart = now; }
    if (readoutT > 0.12) { readoutT = 0; updateReadouts(); }
    if (!renderer.lost) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch(err => { console.error(err); showFallback('Something went wrong while starting.', String(err && err.message || err)); });
