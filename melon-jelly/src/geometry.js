// ─────────────────────────────────────────────────────────────
//  Geometry: rounded watermelon wedge, tetrahedral sim mesh,
//  smooth render surface, seeds and bubbles, and the barycentric
//  embedding that ties every render vertex to a tetrahedron.
// ─────────────────────────────────────────────────────────────

export const SHAPE = {
  alpha: 32 * Math.PI / 180, // half angle of the wedge
  Ri: 1.62,                  // inner sector radius (before rounding)
  rho: 0.17,                 // in-plane corner rounding
  T: 0.58,                   // thickness
  bevel: 0.13,               // rounding of the top / bottom edges
  skin: 0.075,               // green skin band depth
  pale: 0.25,                // skin + pale layer depth
};
SHAPE.Ro = SHAPE.Ri + SHAPE.rho;

// seeded PRNG so the specimen is identical on each load
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Profile coords: origin O = inner sector apex, +w along the bisector (tip → rind), u lateral.
// Signed distance to the inner (unrounded) sector — iq's exact pie SDF.
export function sdPie(u, w, alpha, r) {
  const px = Math.abs(u), py = w;
  const cx = Math.sin(alpha), cy = Math.cos(alpha);
  const l = Math.hypot(px, py) - r;
  const d = Math.min(Math.max(px * cx + py * cy, 0), r);
  const m = Math.hypot(px - cx * d, py - cy * d);
  const s = Math.sign(cy * px - cx * py) || 1;
  return Math.max(l, m * s);
}
export function sdShape(u, w, inset = 0) {
  return sdPie(u, w, SHAPE.alpha, SHAPE.Ri) - SHAPE.rho + inset;
}

// Outline samples of the inner sector boundary: base point q and outward normal n.
// Any offset curve (rounded outline at offset d) is q + n*d with matching indices.
export function outlineSamples(spacing, maxAngleStep) {
  const { alpha: a, Ri, rho } = SHAPE;
  const out = [];
  const u1 = [Math.sin(a), Math.cos(a)];    // upper side dir (u, w)
  const u2 = [-Math.sin(a), Math.cos(a)];   // other side dir
  const n1 = [Math.cos(a), -Math.sin(a)];   // outward normal of side 1
  const n2 = [-Math.cos(a), -Math.sin(a)];  // outward normal of side 2
  const ang = v => Math.atan2(v[1], v[0]);
  const arc = (cq, a0, a1, rad) => {
    let da = a1 - a0;
    while (da <= 0) da += Math.PI * 2;
    const n = Math.max(2, Math.ceil(Math.max(rad * da / spacing, da / maxAngleStep)));
    for (let i = 0; i < n; i++) {
      const t = a0 + da * i / n;
      out.push({ q: [cq[0], cq[1]], n: [Math.cos(t), Math.sin(t)] });
    }
  };
  const line = (p0, p1, nrm) => {
    const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const n = Math.max(1, Math.ceil(L / spacing));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      out.push({ q: [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t], n: nrm.slice() });
    }
  };
  const C1 = [u1[0] * Ri, u1[1] * Ri], C2 = [u2[0] * Ri, u2[1] * Ri];
  // counter-clockwise in (u,w): tip arc (from n1 to n2 through -w), side 2, corner 2, big arc, corner 1, side 1
  arc([0, 0], ang(n2), ang(n1), rho); // tip: n2 → n1 going CCW passes through -w (downwards)
  line([0, 0], C1, n1);
  arc(C1, ang(n1), ang(u1), rho);
  // big arc from u1 to u2 (CCW, through +w)
  {
    const a0 = ang(u1), a1 = ang(u2);
    let da = a1 - a0; while (da <= 0) da += Math.PI * 2;
    const rad = Ri + rho;
    const n = Math.max(2, Math.ceil(rad * da / spacing));
    for (let i = 0; i < n; i++) {
      const t = a0 + da * i / n;
      out.push({ q: [Math.cos(t) * Ri, Math.sin(t) * Ri], n: [Math.cos(t), Math.sin(t)] });
    }
  }
  arc(C2, ang(u2), ang(n2), rho);
  line(C2, [0, 0], n2);
  return out;
}

// ── Bowyer–Watson Delaunay (convex point sets, a few thousand points) ──
export function delaunay(pts) {
  const n = pts.length / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, pts[2 * i]); maxX = Math.max(maxX, pts[2 * i]);
    minY = Math.min(minY, pts[2 * i + 1]); maxY = Math.max(maxY, pts[2 * i + 1]);
  }
  const d = Math.max(maxX - minX, maxY - minY) * 20;
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const P = Array.from(pts);
  P.push(mx - d, my - d, mx + d, my - d, mx, my + d);
  let tris = [];
  const mk = (a, b, c) => {
    const ax = P[2 * a], ay = P[2 * a + 1], bx = P[2 * b], by = P[2 * b + 1], cx = P[2 * c], cy = P[2 * c + 1];
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / D;
    const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / D;
    return { a, b, c, x: ux, y: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };
  tris.push(mk(n, n + 1, n + 2));
  for (let i = 0; i < n; i++) {
    const px = P[2 * i], py = P[2 * i + 1];
    const bad = [], keep = [];
    for (const t of tris) ((px - t.x) ** 2 + (py - t.y) ** 2 < t.r2 * (1 + 1e-9) ? bad : keep).push(t);
    const edges = new Map();
    for (const t of bad) for (const [e0, e1] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
      const k = e0 < e1 ? e0 * 100003 + e1 : e1 * 100003 + e0;
      const ex = edges.get(k);
      if (ex) ex.count++; else edges.set(k, { e0, e1, count: 1 });
    }
    tris = keep;
    for (const e of edges.values()) if (e.count === 1) tris.push(mk(e.e0, e.e1, i));
  }
  const res = [];
  for (const t of tris) {
    if (t.a >= n || t.b >= n || t.c >= n) continue;
    // CCW orientation
    const ax = P[2 * t.a], ay = P[2 * t.a + 1];
    const cr = (P[2 * t.b] - ax) * (P[2 * t.c + 1] - ay) - (P[2 * t.b + 1] - ay) * (P[2 * t.c] - ax);
    if (cr > 0) res.push(t.a, t.b, t.c); else res.push(t.a, t.c, t.b);
  }
  return res;
}

export function hexLattice(spacing, keep) {
  const pts = [];
  const { Ro, rho } = SHAPE;
  const dy = spacing * Math.sqrt(3) / 2;
  let row = 0;
  for (let w = -rho - 0.2; w < Ro + 0.2; w += dy, row++) {
    const off = (row % 2) * spacing / 2;
    for (let u = -Ro - 0.2 + off; u < Ro + 0.2; u += spacing) if (keep(u, w)) pts.push(u, w);
  }
  return pts;
}

// ── Simulation mesh: 2D Delaunay of the rounded profile, extruded into prisms → tets ──
export function buildSimMesh(h = 0.15, layers = 3) {
  const { T, Ro, skin, pale } = SHAPE;
  const bs = outlineSamples(h, 0.5);
  const pts = [];
  for (const s of bs) pts.push(s.q[0] + s.n[0] * SHAPE.rho, s.q[1] + s.n[1] * SHAPE.rho);
  // de-duplicate near-coincident outline samples
  const P2 = [];
  for (let i = 0; i < pts.length; i += 2) {
    let dup = false;
    for (let j = 0; j < P2.length; j += 2) if (Math.hypot(P2[j] - pts[i], P2[j + 1] - pts[i + 1]) < h * 0.45) { dup = true; break; }
    if (!dup) P2.push(pts[i], pts[i + 1]);
  }
  const inner = hexLattice(h, (u, w) => sdShape(u, w) < -h * 0.55);
  const all = P2.concat(inner);
  let tri2 = delaunay(all);
  // drop sliver hull triangles (nearly collinear boundary triples)
  const t2 = [];
  for (let i = 0; i < tri2.length; i += 3) {
    const a = tri2[i], b = tri2[i + 1], c = tri2[i + 2];
    const ax = all[2 * a], ay = all[2 * a + 1], bx = all[2 * b], by = all[2 * b + 1], cx = all[2 * c], cy = all[2 * c + 1];
    const area = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
    const l2 = Math.max((bx - ax) ** 2 + (by - ay) ** 2, (cx - bx) ** 2 + (cy - by) ** 2, (ax - cx) ** 2 + (ay - cy) ** 2);
    if (area / l2 > 0.12) t2.push(a, b, c);
  }
  // keep only vertices referenced
  const used = new Int32Array(all.length / 2).fill(-1);
  const verts2 = [];
  for (const v of t2) if (used[v] < 0) { used[v] = verts2.length / 2; verts2.push(all[2 * v], all[2 * v + 1]); }
  const tris = t2.map(v => used[v]);
  const n2 = verts2.length / 2;
  const nL = layers + 1;
  const rest = new Float32Array(n2 * nL * 3);
  for (let l = 0; l < nL; l++) for (let i = 0; i < n2; i++) {
    const k = (l * n2 + i) * 3;
    rest[k] = verts2[2 * i]; rest[k + 1] = T * l / layers; rest[k + 2] = verts2[2 * i + 1];
  }
  const tets = [];
  for (let l = 0; l < layers; l++) for (let i = 0; i < tris.length; i += 3) {
    const s = [tris[i], tris[i + 1], tris[i + 2]].sort((x, y) => x - y);
    const a = l * n2 + s[0], b = l * n2 + s[1], c = l * n2 + s[2];
    const A = a + n2, B = b + n2, C = c + n2;
    tets.push(a, b, c, A, b, c, A, B, c, A, B, C);
  }
  // orient every tet to positive volume
  for (let t = 0; t < tets.length; t += 4) {
    if (tetVolume(rest, tets[t], tets[t + 1], tets[t + 2], tets[t + 3]) < 0) {
      const tmp = tets[t + 2]; tets[t + 2] = tets[t + 3]; tets[t + 3] = tmp;
    }
  }
  // per-particle material region: 0 flesh, 1 pale, 2 rind
  const nP = n2 * nL;
  const region = new Uint8Array(nP);
  for (let i = 0; i < nP; i++) {
    const depth = Ro - Math.hypot(rest[3 * i], rest[3 * i + 2]);
    region[i] = depth < skin + 0.03 ? 2 : depth < pale ? 1 : 0;
  }
  return { rest, tets: new Uint32Array(tets), region, n2, layers };
}

export function tetVolume(p, a, b, c, d) {
  const ax = p[3 * a], ay = p[3 * a + 1], az = p[3 * a + 2];
  const b0 = p[3 * b] - ax, b1 = p[3 * b + 1] - ay, b2 = p[3 * b + 2] - az;
  const c0 = p[3 * c] - ax, c1 = p[3 * c + 1] - ay, c2 = p[3 * c + 2] - az;
  const d0 = p[3 * d] - ax, d1 = p[3 * d + 1] - ay, d2 = p[3 * d + 2] - az;
  return (b0 * (c1 * d2 - c2 * d1) - b1 * (c0 * d2 - c2 * d0) + b2 * (c0 * d1 - c1 * d0)) / 6;
}

// ── Render mesh: rounded slab (caps + beveled wall) + seeds + bubbles ──
// material ids: 0 body, 1 seed, 2 bubble
export function buildRenderMesh() {
  const { T, bevel: b, rho, Ro } = SHAPE;
  const pos = [], nrm = [], mat = [], idx = [];
  const add = (x, y, z, m, nx = 0, ny = 1, nz = 0) => { pos.push(x, y, z); nrm.push(nx, ny, nz); mat.push(m); return pos.length / 3 - 1; };

  const samples = outlineSamples(0.028, 0.09);
  const N = samples.length;
  // wall rings: bottom bevel quarter, straight band, top bevel quarter
  const qb = 9, qs = 3;
  const rings = [];
  for (let j = 0; j <= qb; j++) { const ps = -Math.PI / 2 + (Math.PI / 2) * j / qb; rings.push({ d: rho - b + b * Math.cos(ps), y: b + b * Math.sin(ps), ny: Math.sin(ps), nr: Math.cos(ps) }); }
  for (let j = 1; j < qs; j++) rings.push({ d: rho, y: b + (T - 2 * b) * j / qs, ny: 0, nr: 1 });
  for (let j = 0; j <= qb; j++) { const ps = (Math.PI / 2) * j / qb; rings.push({ d: rho - b + b * Math.cos(ps), y: T - b + b * Math.sin(ps), ny: Math.sin(ps), nr: Math.cos(ps) }); }
  const ringStart = [];
  for (const r of rings) {
    ringStart.push(pos.length / 3);
    for (const s of samples) add(s.q[0] + s.n[0] * r.d, r.y, s.q[1] + s.n[1] * r.d, 0, s.n[0] * r.nr, r.ny, s.n[1] * r.nr);
  }
  for (let j = 0; j < rings.length - 1; j++) for (let k = 0; k < N; k++) {
    const a = ringStart[j] + k, bb = ringStart[j] + (k + 1) % N, c = ringStart[j + 1] + k, d = ringStart[j + 1] + (k + 1) % N;
    // outline runs CCW in (u,w) = (x,z); outward wall normal → winding for CCW front faces seen from outside
    idx.push(a, c, bb, bb, c, d);
  }
  // caps: Delaunay on inset outline + fine hex lattice
  const inset = rho - b;
  const capPts = [];
  for (const s of samples) capPts.push(s.q[0] + s.n[0] * inset, s.q[1] + s.n[1] * inset);
  const sp = 0.045;
  const lat = hexLattice(sp, (u, w) => sdShape(u, w, b) < -sp * 0.6);
  const cp = capPts.concat(lat);
  const ctri = delaunay(cp);
  const topRing = ringStart[rings.length - 1], botRing = ringStart[0];
  const topMap = [], botMap = [];
  for (let i = 0; i < cp.length / 2; i++) {
    if (i < N) { topMap.push(topRing + i); botMap.push(botRing + i); }
    else {
      topMap.push(add(cp[2 * i], T, cp[2 * i + 1], 0, 0, 1, 0));
      botMap.push(add(cp[2 * i], 0, cp[2 * i + 1], 0, 0, -1, 0));
    }
  }
  for (let i = 0; i < ctri.length; i += 3) {
    const a = ctri[i], c1 = ctri[i + 1], c2 = ctri[i + 2];
    // delaunay returns CCW in (u,w)=(x,z). Looking from +y down at the xz plane, CCW in (x,z) is clockwise → flip for top.
    idx.push(topMap[a], topMap[c2], topMap[c1]);
    idx.push(botMap[a], botMap[c1], botMap[c2]);
  }
  const bodyIndexCount = idx.length;

  // ── seeds ──
  const R = rng(9);
  const seeds = [];
  const place = (r, th, face, s) => seeds.push({ r, th, face, s });
  const rows = [
    { r: 0.46, n: 2 }, { r: 0.68, n: 3 }, { r: 0.9, n: 4 }, { r: 1.12, n: 5 }, { r: 1.33, n: 5 },
  ];
  for (const face of [1, -1]) {
    for (const row of rows) {
      const maxTh = SHAPE.alpha - (0.12 + 0.07) / row.r - 0.02;
      for (let i = 0; i < row.n; i++) {
        const t = row.n === 1 ? 0 : (i / (row.n - 1)) * 2 - 1;
        const th = t * maxTh * 0.88 + (R() - 0.5) * 0.06 + (face < 0 ? 0.05 : 0);
        const rr = row.r + (R() - 0.5) * 0.08;
        place(rr, th, face, 0.85 + R() * 0.3);
      }
    }
  }
  // two seeds suspended deep inside, glimpsed through the jelly
  place(0.9, 0.12, 0, 0.9); place(1.12, -0.2, 0, 0.8);

  const seedStart = idx.length;
  const nt = 10, nph = 12;
  for (const sd of seeds) {
    const L = 0.15 * sd.s, W = 0.088 * sd.s, H = 0.042 * sd.s;
    const cx = Math.sin(sd.th) * sd.r, cz = Math.cos(sd.th) * sd.r;
    const ax = [Math.sin(sd.th), 0, Math.cos(sd.th)];     // long axis: radial, wide end outward
    const lx = [Math.cos(sd.th), 0, -Math.sin(sd.th)];    // lateral
    const tilt = (R() - 0.5) * 0.25;
    const cy = sd.face > 0 ? T - H * 0.64 : sd.face < 0 ? H * 0.64 : T * (0.35 + R() * 0.25);
    const base = pos.length / 3;
    for (let i = 0; i <= nt; i++) {
      const t = Math.PI * i / nt;
      const s = (1 - Math.cos(t)) / 2;
      const prof = Math.pow(Math.sin(t), 0.9) * (0.38 + 0.62 * Math.pow(s, 0.7));
      for (let j = 0; j < nph; j++) {
        const ph = 2 * Math.PI * j / nph;
        const la = Math.cos(ph) * prof * W / 2, up = Math.sin(ph) * prof * H / 2;
        const al = (s - 0.5) * L;
        const upT = up + al * tilt * 0.3;
        const nn = [ax[0] * al / L + lx[0] * la / W, upT / H, ax[2] * al / L + lx[2] * la / W];
        add(cx + ax[0] * al + lx[0] * la, cy + upT, cz + ax[2] * al + lx[2] * la, 1, nn[0], nn[1], nn[2]);
      }
    }
    for (let i = 0; i < nt; i++) for (let j = 0; j < nph; j++) {
      const a = base + i * nph + j, bb = base + i * nph + (j + 1) % nph, c = a + nph, d = bb + nph;
      idx.push(a, bb, c, bb, d, c);
    }
  }
  const seedCount = idx.length - seedStart;

  // ── bubbles ──
  const bubbleStart = idx.length;
  const bub = [];
  for (let i = 0; i < 9; i++) {
    const r = 0.45 + R() * 0.85, th = (R() * 2 - 1) * (SHAPE.alpha - 0.14 / r) * 0.9;
    const rad = 0.009 + R() * R() * 0.02;
    const y = R() < 0.6 ? T - 0.035 - R() * 0.16 : 0.05 + R() * 0.14;
    bub.push([Math.sin(th) * r, y, Math.cos(th) * r, rad]);
  }
  bub.push([0.22, T - 0.06, 0.45, 0.012], [-0.2, T - 0.09, 1.05, 0.016]);
  const bs = 8, bp = 12;
  for (const [x, y, z, r] of bub) {
    const base = pos.length / 3;
    for (let i = 0; i <= bs; i++) {
      const t = Math.PI * i / bs;
      for (let j = 0; j < bp; j++) {
        const ph = 2 * Math.PI * j / bp;
        const nx = Math.sin(t) * Math.cos(ph), ny = Math.cos(t), nz = Math.sin(t) * Math.sin(ph);
        add(x + nx * r, y + ny * r, z + nz * r, 2, nx, ny, nz);
      }
    }
    for (let i = 0; i < bs; i++) for (let j = 0; j < bp; j++) {
      const a = base + i * bp + j, bb = base + i * bp + (j + 1) % bp, c = a + bp, d = bb + bp;
      idx.push(a, bb, c, bb, d, c);
    }
  }
  const bubbleCount = idx.length - bubbleStart;

  // make every triangle's winding agree with its analytic outward normal (CCW = front)
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b1 = idx[i + 1], c = idx[i + 2];
    const e1 = [pos[3 * b1] - pos[3 * a], pos[3 * b1 + 1] - pos[3 * a + 1], pos[3 * b1 + 2] - pos[3 * a + 2]];
    const e2 = [pos[3 * c] - pos[3 * a], pos[3 * c + 1] - pos[3 * a + 1], pos[3 * c + 2] - pos[3 * a + 2]];
    const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    let d = 0;
    for (const v of [a, b1, c]) d += fn[0] * nrm[3 * v] + fn[1] * nrm[3 * v + 1] + fn[2] * nrm[3 * v + 2];
    if (d < 0) { idx[i + 1] = c; idx[i + 2] = b1; }
  }

  return {
    rest: new Float32Array(pos), restNormal: new Float32Array(nrm), mat: new Float32Array(mat),
    index: new Uint32Array(idx),
    body: { first: 0, count: bodyIndexCount },
    seeds: { first: seedStart, count: seedCount },
    bubbles: { first: bubbleStart, count: bubbleCount },
    seedCount: seeds.length,
  };
}

// ── Barycentric embedding of render vertices into sim tets ──
export function embed(simRest, tets, verts) {
  const nT = tets.length / 4, nV = verts.length / 3;
  const cell = 0.2;
  const grid = new Map();
  const key = (i, j, k) => (i + 512) * 1048576 + (j + 512) * 1024 + (k + 512);
  const inv = new Float64Array(nT * 9);
  for (let t = 0; t < nT; t++) {
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    const id = [tets[4 * t], tets[4 * t + 1], tets[4 * t + 2], tets[4 * t + 3]];
    for (const v of id) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], simRest[3 * v + c]); mx[c] = Math.max(mx[c], simRest[3 * v + c]); }
    for (let i = Math.floor(mn[0] / cell); i <= Math.floor(mx[0] / cell); i++)
      for (let j = Math.floor(mn[1] / cell); j <= Math.floor(mx[1] / cell); j++)
        for (let k = Math.floor(mn[2] / cell); k <= Math.floor(mx[2] / cell); k++) {
          const K = key(i, j, k); let l = grid.get(K); if (!l) grid.set(K, l = []); l.push(t);
        }
    // inverse of [b-a, c-a, d-a]
    const a = id[0];
    const m = [];
    for (let c = 1; c < 4; c++) for (let r = 0; r < 3; r++) m.push(simRest[3 * id[c] + r] - simRest[3 * a + r]);
    // m as columns: col0 = m[0..2], col1 = m[3..5], col2 = m[6..8]; build row-major M
    const M = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
    const det = M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
    const id2 = 1 / det;
    inv[9 * t + 0] = (M[4] * M[8] - M[5] * M[7]) * id2; inv[9 * t + 1] = (M[2] * M[7] - M[1] * M[8]) * id2; inv[9 * t + 2] = (M[1] * M[5] - M[2] * M[4]) * id2;
    inv[9 * t + 3] = (M[5] * M[6] - M[3] * M[8]) * id2; inv[9 * t + 4] = (M[0] * M[8] - M[2] * M[6]) * id2; inv[9 * t + 5] = (M[2] * M[3] - M[0] * M[5]) * id2;
    inv[9 * t + 6] = (M[3] * M[7] - M[4] * M[6]) * id2; inv[9 * t + 7] = (M[1] * M[6] - M[0] * M[7]) * id2; inv[9 * t + 8] = (M[0] * M[4] - M[1] * M[3]) * id2;
  }
  const bary = (t, x, y, z) => {
    const a = tets[4 * t];
    const dx = x - simRest[3 * a], dy = y - simRest[3 * a + 1], dz = z - simRest[3 * a + 2];
    const I = 9 * t;
    const b1 = inv[I] * dx + inv[I + 1] * dy + inv[I + 2] * dz;
    const b2 = inv[I + 3] * dx + inv[I + 4] * dy + inv[I + 5] * dz;
    const b3 = inv[I + 6] * dx + inv[I + 7] * dy + inv[I + 8] * dz;
    return [1 - b1 - b2 - b3, b1, b2, b3];
  };
  const tetOf = new Uint32Array(nV);
  const w = new Float32Array(nV * 4);
  for (let v = 0; v < nV; v++) {
    const x = verts[3 * v], y = verts[3 * v + 1], z = verts[3 * v + 2];
    let best = -1, bestScore = -Infinity, bestB = null;
    const tryT = t => {
      const bb = bary(t, x, y, z);
      const s = Math.min(bb[0], bb[1], bb[2], bb[3]);
      if (s > bestScore) { bestScore = s; best = t; bestB = bb; }
    };
    const ci = Math.floor(x / cell), cj = Math.floor(y / cell), ck = Math.floor(z / cell);
    for (let r = 0; r <= 2 && bestScore < -1e-4; r++) {
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) for (let k = ck - r; k <= ck + r; k++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== r) continue;
        const l = grid.get(key(i, j, k)); if (l) for (const t of l) tryT(t);
      }
    }
    if (best < 0) for (let t = 0; t < nT; t++) tryT(t);
    tetOf[v] = best; w.set(bestB, 4 * v);
  }
  return { tetOf, w };
}
