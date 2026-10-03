// ─────────────────────────────────────────────────────────────
//  Pieces: the slice and everything cut from it.
//  Every piece is a convex "inner polygon" I in the slice's rest plane (u, w);
//  its real outline is I grown by a fixed corner radius RC (so every corner is
//  rounded, including fresh knife cuts). All pieces share one rest frame, so
//  the rind / pith / flesh shading and seeds stay exactly where they were.
// ─────────────────────────────────────────────────────────────

import { SHAPE, rng, delaunay, tetVolume, embed } from './geometry.js';

export const RC = SHAPE.rho;          // corner radius of every piece outline
export const MIN_INNER_AREA = 0.004;

export function initialPiece() {
  const { alpha: a, Ri } = SHAPE;
  const I = [[0, 0]];
  const a0 = Math.PI / 2 - a, a1 = Math.PI / 2 + a, n = 40;
  for (let k = 0; k <= n; k++) { const t = a0 + (a1 - a0) * k / n; I.push([Math.cos(t) * Ri, Math.sin(t) * Ri]); }
  return { I, cache: null };
}

export function polyArea(P) {
  let s = 0;
  for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; s += p[0] * q[1] - q[0] * p[1]; }
  return s / 2;
}

// Sutherland–Hodgman against the half-plane a·u + b·w ≤ c
export function clipHalf(P, a, b, c) {
  const out = [];
  for (let i = 0; i < P.length; i++) {
    const p = P[i], q = P[(i + 1) % P.length];
    const dp = a * p[0] + b * p[1] - c, dq = a * q[0] + b * q[1] - c;
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  // drop near-duplicate vertices
  const clean = [];
  for (const p of out) { const l = clean[clean.length - 1]; if (!l || Math.hypot(l[0] - p[0], l[1] - p[1]) > 1e-5) clean.push(p); }
  if (clean.length > 1) { const f = clean[0], l = clean[clean.length - 1]; if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-5) clean.pop(); }
  return clean;
}

// split a piece along the rest-plane line a·u + b·w = c (a, b normalised); null if a part would be too thin
export function splitPiece(I, a, b, c) {
  const A = clipHalf(I, a, b, c - RC);
  const B = clipHalf(I, -a, -b, -(c + RC));
  if (A.length < 3 || B.length < 3 || polyArea(A) < MIN_INNER_AREA || polyArea(B) < MIN_INNER_AREA) return null;
  return [A, B];
}

// does the line pass through the piece's real outline?
export function lineCrossesPiece(I, a, b, c) {
  let lo = Infinity, hi = -Infinity;
  for (const p of I) { const d = a * p[0] + b * p[1]; lo = Math.min(lo, d); hi = Math.max(hi, d); }
  return c > lo - RC * 0.6 && c < hi + RC * 0.6;
}

// signed distance to the piece outline (negative inside)
export function sdInner(I, u, w) {
  let d = -Infinity;
  for (let i = 0; i < I.length; i++) {
    const p = I[i], q = I[(i + 1) % I.length];
    const ex = q[0] - p[0], ew = q[1] - p[1], l = Math.hypot(ex, ew) || 1;
    const nx = ew / l, nw = -ex / l;
    d = Math.max(d, nx * (u - p[0]) + nw * (w - p[1]));
  }
  // outside near a vertex the max-of-planes underestimates; good enough for lattice filtering
  return d;
}
export function sdPiece(I, u, w, inset = 0) { return sdInner(I, u, w) - RC + inset; }

// outline samples: base point q on I and outward normal n; the outline at offset d is q + n·d
export function pieceSamples(I, spacing, maxAngleStep) {
  const out = [], N = I.length;
  const edgeN = [];
  for (let i = 0; i < N; i++) {
    const p = I[i], q = I[(i + 1) % N];
    const ex = q[0] - p[0], ew = q[1] - p[1], l = Math.hypot(ex, ew) || 1;
    edgeN.push([ew / l, -ex / l, l]);
  }
  for (let i = 0; i < N; i++) {
    const n0 = edgeN[(i - 1 + N) % N], n1 = edgeN[i];
    let a0 = Math.atan2(n0[1], n0[0]), a1 = Math.atan2(n1[1], n1[0]);
    let da = a1 - a0; while (da < 0) da += Math.PI * 2; if (da > Math.PI * 1.5) da = 0;
    const na = Math.max(1, Math.ceil(Math.max(RC * da / spacing, da / maxAngleStep)));
    for (let k = 0; k < na; k++) { const t = a0 + da * k / na; out.push({ q: I[i], n: [Math.cos(t), Math.sin(t)] }); }
    const nl = Math.max(1, Math.ceil(n1[2] / spacing));
    for (let k = 1; k < nl; k++) {
      const t = k / nl, p = I[i], q = I[(i + 1) % N];
      out.push({ q: [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t], n: [n1[0], n1[1]] });
    }
  }
  return out;
}

export function bboxLattice(I, pad, spacing, keep) {
  let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
  for (const p of I) { u0 = Math.min(u0, p[0]); u1 = Math.max(u1, p[0]); w0 = Math.min(w0, p[1]); w1 = Math.max(w1, p[1]); }
  u0 -= pad; u1 += pad; w0 -= pad; w1 += pad;
  const pts = [], dy = spacing * Math.sqrt(3) / 2;
  let row = 0;
  for (let w = w0; w <= w1; w += dy, row++) for (let u = u0 + (row % 2) * spacing / 2; u <= u1; u += spacing) if (keep(u, w)) pts.push(u, w);
  return pts;
}

// ── per-piece simulation mesh: Delaunay of the outline, extruded into prisms → tets ──
export function buildPieceSim(I, h = 0.15, layers = 3) {
  const { T, Ro, skin, pale } = SHAPE;
  const bs = pieceSamples(I, h, 0.5);
  const P2 = [];
  for (const s of bs) {
    const x = s.q[0] + s.n[0] * RC, z = s.q[1] + s.n[1] * RC;
    let dup = false;
    for (let j = 0; j < P2.length; j += 2) if (Math.hypot(P2[j] - x, P2[j + 1] - z) < h * 0.45) { dup = true; break; }
    if (!dup) P2.push(x, z);
  }
  const all = P2.concat(bboxLattice(I, RC, h, (u, w) => sdPiece(I, u, w) < -h * 0.55));
  const tri2 = delaunay(all);
  const t2 = [];
  for (let i = 0; i < tri2.length; i += 3) {
    const a = tri2[i], b = tri2[i + 1], c = tri2[i + 2];
    const ax = all[2 * a], ay = all[2 * a + 1], bx = all[2 * b], by = all[2 * b + 1], cx = all[2 * c], cy = all[2 * c + 1];
    const area = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
    const l2 = Math.max((bx - ax) ** 2 + (by - ay) ** 2, (cx - bx) ** 2 + (cy - by) ** 2, (ax - cx) ** 2 + (ay - cy) ** 2);
    if (area / l2 > 0.1) t2.push(a, b, c);
  }
  const used = new Int32Array(all.length / 2).fill(-1);
  const v2 = [];
  for (const v of t2) if (used[v] < 0) { used[v] = v2.length / 2; v2.push(all[2 * v], all[2 * v + 1]); }
  const tris = t2.map(v => used[v]);
  const n2 = v2.length / 2, nL = layers + 1;
  const rest = new Float32Array(n2 * nL * 3);
  for (let l = 0; l < nL; l++) for (let i = 0; i < n2; i++) {
    const k = (l * n2 + i) * 3;
    rest[k] = v2[2 * i]; rest[k + 1] = T * l / layers; rest[k + 2] = v2[2 * i + 1];
  }
  const tets = [];
  for (let l = 0; l < layers; l++) for (let i = 0; i < tris.length; i += 3) {
    const s = [tris[i], tris[i + 1], tris[i + 2]].sort((x, y) => x - y);
    const a = l * n2 + s[0], b = l * n2 + s[1], c = l * n2 + s[2];
    tets.push(a, b, c, a + n2, b, c, a + n2, b + n2, c, a + n2, b + n2, c + n2);
  }
  for (let t = 0; t < tets.length; t += 4) if (tetVolume(rest, tets[t], tets[t + 1], tets[t + 2], tets[t + 3]) < 0) { const tmp = tets[t + 2]; tets[t + 2] = tets[t + 3]; tets[t + 3] = tmp; }
  const nP = n2 * nL, region = new Uint8Array(nP);
  for (let i = 0; i < nP; i++) {
    const depth = Ro - Math.hypot(rest[3 * i], rest[3 * i + 2]);
    region[i] = depth < skin + 0.03 ? 2 : depth < pale ? 1 : 0;
  }
  return { rest, tets: new Uint32Array(tets), region };
}

// ── seeds and bubbles, generated once in the shared rest frame ──
export let PROPS = null;
export function globalProps() {
  if (PROPS) return PROPS;
  const { T } = SHAPE;
  const R = rng(9);
  const list = [];
  const seeds = [];
  const rows = [{ r: 0.46, n: 2 }, { r: 0.68, n: 3 }, { r: 0.9, n: 4 }, { r: 1.12, n: 5 }, { r: 1.33, n: 5 }];
  for (const face of [1, -1]) for (const row of rows) {
    const maxTh = SHAPE.alpha - (0.12 + 0.07) / row.r - 0.02;
    for (let i = 0; i < row.n; i++) {
      const t = row.n === 1 ? 0 : (i / (row.n - 1)) * 2 - 1;
      seeds.push({ r: row.r + (R() - 0.5) * 0.08, th: t * maxTh * 0.88 + (R() - 0.5) * 0.06 + (face < 0 ? 0.05 : 0), face, s: 0.85 + R() * 0.3 });
    }
  }
  seeds.push({ r: 0.9, th: 0.12, face: 0, s: 0.9 }, { r: 1.12, th: -0.2, face: 0, s: 0.8 });
  const nt = 10, nph = 12;
  for (const sd of seeds) {
    const L = 0.15 * sd.s, W = 0.088 * sd.s, H = 0.042 * sd.s;
    const cx = Math.sin(sd.th) * sd.r, cz = Math.cos(sd.th) * sd.r;
    const ax = [Math.sin(sd.th), 0, Math.cos(sd.th)], lx = [Math.cos(sd.th), 0, -Math.sin(sd.th)];
    const tilt = (R() - 0.5) * 0.25;
    const cy = sd.face > 0 ? T - H * 0.64 : sd.face < 0 ? H * 0.64 : T * (0.35 + R() * 0.25);
    const pos = [], nrm = [], idx = [];
    for (let i = 0; i <= nt; i++) {
      const t = Math.PI * i / nt, s = (1 - Math.cos(t)) / 2;
      const prof = Math.pow(Math.sin(t), 0.9) * (0.38 + 0.62 * Math.pow(s, 0.7));
      for (let j = 0; j < nph; j++) {
        const ph = 2 * Math.PI * j / nph;
        const la = Math.cos(ph) * prof * W / 2, up = Math.sin(ph) * prof * H / 2, al = (s - 0.5) * L, upT = up + al * tilt * 0.3;
        pos.push(cx + ax[0] * al + lx[0] * la, cy + upT, cz + ax[2] * al + lx[2] * la);
        nrm.push(ax[0] * al / L + lx[0] * la / W, upT / H, ax[2] * al / L + lx[2] * la / W);
      }
    }
    for (let i = 0; i < nt; i++) for (let j = 0; j < nph; j++) {
      const a = i * nph + j, bb = i * nph + (j + 1) % nph, c = a + nph, d = bb + nph;
      idx.push(a, bb, c, bb, d, c);
    }
    list.push({ mat: 1, cx, cz, rad: L * 0.5, pos, nrm, idx });
  }
  const bub = [];
  for (let i = 0; i < 9; i++) {
    const r = 0.45 + R() * 0.85, th = (R() * 2 - 1) * (SHAPE.alpha - 0.14 / r) * 0.9;
    const rad = 0.009 + R() * R() * 0.02, y = R() < 0.6 ? T - 0.035 - R() * 0.16 : 0.05 + R() * 0.14;
    bub.push([Math.sin(th) * r, y, Math.cos(th) * r, rad]);
  }
  bub.push([0.22, T - 0.06, 0.45, 0.012], [-0.2, T - 0.09, 1.05, 0.016]);
  const bs = 8, bp = 12;
  for (const [x, y, z, r] of bub) {
    const pos = [], nrm = [], idx = [];
    for (let i = 0; i <= bs; i++) {
      const t = Math.PI * i / bs;
      for (let j = 0; j < bp; j++) {
        const ph = 2 * Math.PI * j / bp;
        const nx = Math.sin(t) * Math.cos(ph), ny = Math.cos(t), nz = Math.sin(t) * Math.sin(ph);
        pos.push(x + nx * r, y + ny * r, z + nz * r); nrm.push(nx, ny, nz);
      }
    }
    for (let i = 0; i < bs; i++) for (let j = 0; j < bp; j++) {
      const a = i * bp + j, bb = i * bp + (j + 1) % bp, c = a + bp, d = bb + bp;
      idx.push(a, bb, c, bb, d, c);
    }
    list.push({ mat: 2, cx: x, cz: z, rad: r, pos, nrm, idx });
  }
  PROPS = list;
  return list;
}

// ── per-piece render mesh: rounded walls, two caps, and the seeds/bubbles that lie inside it ──
export function buildPieceRender(I) {
  const { T, bevel: b } = SHAPE;
  const pos = [], nrm = [], mat = [], body = [], seeds = [], bubbles = [];
  const add = (x, y, z, m, nx, ny, nz) => { pos.push(x, y, z); nrm.push(nx, ny, nz); mat.push(m); return pos.length / 3 - 1; };
  const samples = pieceSamples(I, 0.03, 0.1);
  const N = samples.length;
  const qb = 8, qs = 3, rings = [];
  for (let j = 0; j <= qb; j++) { const ps = -Math.PI / 2 + (Math.PI / 2) * j / qb; rings.push({ d: RC - b + b * Math.cos(ps), y: b + b * Math.sin(ps), ny: Math.sin(ps), nr: Math.cos(ps) }); }
  for (let j = 1; j < qs; j++) rings.push({ d: RC, y: b + (T - 2 * b) * j / qs, ny: 0, nr: 1 });
  for (let j = 0; j <= qb; j++) { const ps = (Math.PI / 2) * j / qb; rings.push({ d: RC - b + b * Math.cos(ps), y: T - b + b * Math.sin(ps), ny: Math.sin(ps), nr: Math.cos(ps) }); }
  const ringStart = [];
  for (const r of rings) {
    ringStart.push(pos.length / 3);
    for (const s of samples) add(s.q[0] + s.n[0] * r.d, r.y, s.q[1] + s.n[1] * r.d, 0, s.n[0] * r.nr, r.ny, s.n[1] * r.nr);
  }
  for (let j = 0; j < rings.length - 1; j++) for (let k = 0; k < N; k++) {
    const a = ringStart[j] + k, bb = ringStart[j] + (k + 1) % N, c = ringStart[j + 1] + k, d = ringStart[j + 1] + (k + 1) % N;
    body.push(a, c, bb, bb, c, d);
  }
  const inset = RC - b, capPts = [];
  for (const s of samples) capPts.push(s.q[0] + s.n[0] * inset, s.q[1] + s.n[1] * inset);
  const sp = 0.048;
  const cp = capPts.concat(bboxLattice(I, RC, sp, (u, w) => sdPiece(I, u, w, b) < -sp * 0.6));
  const ctri = delaunay(cp);
  const topRing = ringStart[rings.length - 1], botRing = ringStart[0];
  const topMap = [], botMap = [];
  for (let i = 0; i < cp.length / 2; i++) {
    if (i < N) { topMap.push(topRing + i); botMap.push(botRing + i); }
    else { topMap.push(add(cp[2 * i], T, cp[2 * i + 1], 0, 0, 1, 0)); botMap.push(add(cp[2 * i], 0, cp[2 * i + 1], 0, 0, -1, 0)); }
  }
  for (let i = 0; i < ctri.length; i += 3) {
    const a = ctri[i], c1 = ctri[i + 1], c2 = ctri[i + 2];
    body.push(topMap[a], topMap[c2], topMap[c1]);
    body.push(botMap[a], botMap[c1], botMap[c2]);
  }
  // seeds and bubbles that sit wholly inside this piece
  for (const pr of globalProps()) {
    if (sdPiece(I, pr.cx, pr.cz) + pr.rad > -0.02) continue;
    const base = pos.length / 3;
    for (let k = 0; k < pr.pos.length; k += 3) add(pr.pos[k], pr.pos[k + 1], pr.pos[k + 2], pr.mat, pr.nrm[k], pr.nrm[k + 1], pr.nrm[k + 2]);
    const dst = pr.mat === 1 ? seeds : bubbles;
    for (const v of pr.idx) dst.push(base + v);
  }
  // windings agree with analytic outward normals (CCW = front)
  for (const idx of [body, seeds, bubbles]) for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b1 = idx[i + 1], c = idx[i + 2];
    const e1x = pos[3 * b1] - pos[3 * a], e1y = pos[3 * b1 + 1] - pos[3 * a + 1], e1z = pos[3 * b1 + 2] - pos[3 * a + 2];
    const e2x = pos[3 * c] - pos[3 * a], e2y = pos[3 * c + 1] - pos[3 * a + 1], e2z = pos[3 * c + 2] - pos[3 * a + 2];
    const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    let d = 0;
    for (const v of [a, b1, c]) d += fx * nrm[3 * v] + fy * nrm[3 * v + 1] + fz * nrm[3 * v + 2];
    if (d < 0) { idx[i + 1] = c; idx[i + 2] = b1; }
  }
  return { rest: new Float32Array(pos), mat: new Float32Array(mat), body, seeds, bubbles };
}

export function ensureCache(piece) {
  if (piece.cache) return piece.cache;
  const sim = buildPieceSim(piece.I);
  const ren = buildPieceRender(piece.I);
  const emb = embed(sim.rest, sim.tets, ren.rest);
  piece.cache = { sim, ren, emb };
  return piece.cache;
}

// ── the world: every piece concatenated into one simulation and one render mesh ──
export function buildWorld(pieces) {
  let nP = 0, nT = 0, nV = 0, nB = 0, nS = 0, nU = 0;
  for (const p of pieces) {
    const c = ensureCache(p);
    nP += c.sim.rest.length / 3; nT += c.sim.tets.length / 4; nV += c.ren.rest.length / 3;
    nB += c.ren.body.length; nS += c.ren.seeds.length; nU += c.ren.bubbles.length;
  }
  const rest = new Float32Array(nP * 3), tets = new Uint32Array(nT * 4), region = new Uint8Array(nP), comp = new Uint16Array(nP);
  const rRest = new Float32Array(nV * 3), rMat = new Float32Array(nV), vComp = new Uint16Array(nV);
  const index = new Uint32Array(nB + nS + nU);
  const skinIdx = new Uint32Array(nV * 4), skinW = new Float32Array(nV * 4);
  let po = 0, to = 0, vo = 0, bo = 0, so = nB, uo = nB + nS;
  pieces.forEach((p, k) => {
    const { sim, ren, emb } = p.cache;
    const np = sim.rest.length / 3, nt = sim.tets.length / 4, nv = ren.rest.length / 3;
    rest.set(sim.rest, po * 3); region.set(sim.region, po); comp.fill(k, po, po + np);
    for (let i = 0; i < nt * 4; i++) tets[to * 4 + i] = sim.tets[i] + po;
    rRest.set(ren.rest, vo * 3); rMat.set(ren.mat, vo); vComp.fill(k, vo, vo + nv);
    for (let v = 0; v < nv; v++) for (let j = 0; j < 4; j++) {
      skinIdx[(vo + v) * 4 + j] = sim.tets[4 * emb.tetOf[v] + j] + po;
      skinW[(vo + v) * 4 + j] = emb.w[4 * v + j];
    }
    for (const i of ren.body) index[bo++] = i + vo;
    for (const i of ren.seeds) index[so++] = i + vo;
    for (const i of ren.bubbles) index[uo++] = i + vo;
    po += np; to += nt; vo += nv;
  });
  return {
    sim: { rest, tets, region, comp, nComp: pieces.length },
    render: {
      rest: rRest, mat: rMat, index, vComp,
      body: { first: 0, count: nB }, seeds: { first: nB, count: nS }, bubbles: { first: nB + nS, count: nU },
    },
    skinIdx, skinW,
  };
}
