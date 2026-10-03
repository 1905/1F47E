// ===== build.js =====
// ─────────────────────────────────────────────────────────────
//  Building one piece (a generator, so the work can be spread over frames):
//  · a hexahedral lattice in the piece's principal frame, boundary nodes
//    snapped onto the surface, 6 tets per cell, 8-node shape-matching cells
//  · a surface-nets render skin (only blocks near the surface are evaluated,
//    one Newton step puts each vertex onto the surface)
//  · seeds and bubbles meshed only near cut faces
//  · a barycentric embedding of every render vertex into the lattice tets
// ─────────────────────────────────────────────────────────────

const KUHN = [[0, 1, 3, 7], [0, 3, 2, 7], [0, 2, 6, 7], [0, 6, 4, 7], [0, 4, 5, 7], [0, 5, 1, 7]];
const SURF_H = 0.04;      // render grid spacing (4 mm)
const SEED_FILM = 0.007;  // jelly left over a seed the blade went through
const DENSITY = 1.0;      // sim units; the readout uses 1.02 g/cm³

function tetVol(p, a, b, c, d) {
  const ax = p[3 * a], ay = p[3 * a + 1], az = p[3 * a + 2];
  const b0 = p[3 * b] - ax, b1 = p[3 * b + 1] - ay, b2 = p[3 * b + 2] - az;
  const c0 = p[3 * c] - ax, c1 = p[3 * c + 1] - ay, c2 = p[3 * c + 2] - az;
  const d0 = p[3 * d] - ax, d1 = p[3 * d + 1] - ay, d2 = p[3 * d + 2] - az;
  return (b0 * (c1 * d2 - c2 * d1) - b1 * (c0 * d2 - c2 * d0) + b2 * (c0 * d1 - c1 * d0)) / 6;
}

// inverse of the 3x3 matrix with columns (b-a, c-a, d-a), row-major, written at out[o..o+8]
function tetInverse(p, a, b, c, d, out, o) {
  const m00 = p[3 * b] - p[3 * a], m10 = p[3 * b + 1] - p[3 * a + 1], m20 = p[3 * b + 2] - p[3 * a + 2];
  const m01 = p[3 * c] - p[3 * a], m11 = p[3 * c + 1] - p[3 * a + 1], m21 = p[3 * c + 2] - p[3 * a + 2];
  const m02 = p[3 * d] - p[3 * a], m12 = p[3 * d + 1] - p[3 * a + 1], m22 = p[3 * d + 2] - p[3 * a + 2];
  const A = m11 * m22 - m12 * m21, B = m12 * m20 - m10 * m22, C = m10 * m21 - m11 * m20;
  const det = m00 * A + m01 * B + m02 * C;
  const k = Math.abs(det) > 1e-14 ? 1 / det : 0;
  out[o] = A * k; out[o + 1] = (m02 * m21 - m01 * m22) * k; out[o + 2] = (m01 * m12 - m02 * m11) * k;
  out[o + 3] = B * k; out[o + 4] = (m00 * m22 - m02 * m20) * k; out[o + 5] = (m02 * m10 - m00 * m12) * k;
  out[o + 6] = C * k; out[o + 7] = (m01 * m20 - m00 * m21) * k; out[o + 8] = (m00 * m11 - m01 * m10) * k;
}

// ── the simulation lattice ──
function* buildLattice(planes, S) {
  const { vectors: V } = eigSym3(S.cov);
  // principal axes as rows of E (right-handed)
  const E = [[V[0], V[3], V[6]], [V[1], V[4], V[7]], [V[2], V[5], V[8]]];
  const cr = [E[0][1] * E[1][2] - E[0][2] * E[1][1], E[0][2] * E[1][0] - E[0][0] * E[1][2], E[0][0] * E[1][1] - E[0][1] * E[1][0]];
  if (cr[0] * E[2][0] + cr[1] * E[2][1] + cr[2] * E[2][2] < 0) E[2] = E[2].map(v => -v);
  const target = 70 + 290 * Math.min(1, S.vol / 7);
  const H = Math.min(0.27, Math.max(0.12, Math.cbrt(S.vol / target)));
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < S.pts.length; i += 3) {
    const d = [S.pts[i] - S.mean[0], S.pts[i + 1] - S.mean[1], S.pts[i + 2] - S.mean[2]];
    for (let k = 0; k < 3; k++) {
      const v = d[0] * E[k][0] + d[1] * E[k][1] + d[2] * E[k][2];
      if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v;
    }
  }
  const dims = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    lo[k] -= S.h * 0.5; hi[k] += S.h * 0.5;
    const cells = Math.max(1, Math.ceil((hi[k] - lo[k]) / H));
    const pad = (cells * H - (hi[k] - lo[k])) / 2;
    lo[k] -= pad; dims[k] = cells;
  }
  const O = [0, 1, 2].map(c => S.mean[c] + lo[0] * E[0][c] + lo[1] * E[1][c] + lo[2] * E[2][c]);
  const [cx, cy, cz] = dims, nx = cx + 1, ny = cy + 1;
  const latPos = (i, j, k, out) => { for (let c = 0; c < 3; c++) out[c] = O[c] + (i * E[0][c] + j * E[1][c] + k * E[2][c]) * H; };
  const tmp = [0, 0, 0];
  // cells that hold jelly
  const cellAt = new Int32Array(cx * cy * cz).fill(-1);
  const cellIJK = [];
  for (let k = 0; k < cz; k++) {
    for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
      latPos(i + 0.5, j + 0.5, k + 0.5, tmp);
      const dc = pieceSDF(planes, tmp[0], tmp[1], tmp[2]);
      let keep = dc < 0.22 * H;
      if (!keep && dc < 0.5 * H) {
        let inside = 0;
        for (let q = 0; q < 8; q++) { latPos(i + (q & 1), j + ((q >> 1) & 1), k + (q >> 2), tmp); if (pieceSDF(planes, tmp[0], tmp[1], tmp[2]) < 0) inside++; }
        keep = inside >= 4;
      }
      if (keep) { cellAt[i + cx * (j + cy * k)] = cellIJK.length / 3; cellIJK.push(i, j, k); }
    }
    yield;
  }
  const nC = cellIJK.length / 3;
  // nodes
  const nodeAt = new Map();
  const nodeIJK = [], nodeCount = [];
  const cellNodes = new Uint32Array(nC * 8);
  for (let c = 0; c < nC; c++) {
    const i = cellIJK[3 * c], j = cellIJK[3 * c + 1], k = cellIJK[3 * c + 2];
    for (let q = 0; q < 8; q++) {
      const I = i + (q & 1), J = j + ((q >> 1) & 1), K = k + (q >> 2);
      const key = I + nx * (J + ny * K);
      let id = nodeAt.get(key);
      if (id === undefined) { id = nodeIJK.length / 3; nodeAt.set(key, id); nodeIJK.push(I, J, K); nodeCount.push(0); }
      nodeCount[id]++;
      cellNodes[8 * c + q] = id;
    }
  }
  const n = nodeIJK.length / 3;
  const rest = new Float32Array(n * 3), lat = new Float32Array(n * 3);
  const boundary = new Uint8Array(n);
  for (let v = 0; v < n; v++) {
    latPos(nodeIJK[3 * v], nodeIJK[3 * v + 1], nodeIJK[3 * v + 2], tmp);
    lat.set(tmp, 3 * v); rest.set(tmp, 3 * v);
    if (nodeCount[v] < 8) {
      boundary[v] = 1;
      // snap onto the surface: always from outside, from inside only when close to it
      let x = tmp[0], y = tmp[1], z = tmp[2];
      const d0 = pieceSDF(planes, x, y, z);
      if (d0 > -0.35 * H) {
        for (let it = 0; it < 4; it++) {
          const d = pieceSDF(planes, x, y, z);
          x -= d * SG[1]; y -= d * SG[2]; z -= d * SG[3];
        }
        rest[3 * v] = x; rest[3 * v + 1] = y; rest[3 * v + 2] = z;
        if (d0 > 0) boundary[v] = 2;   // was outside: must stay on the surface
      }
    }
  }
  yield;
  // tets: 6 per cell, kept in cell order; undo snaps that crush or invert a tet
  const tets = new Uint32Array(nC * 24);
  for (let c = 0; c < nC; c++) for (let t = 0; t < 6; t++) for (let q = 0; q < 4; q++) tets[24 * c + 4 * t + q] = cellNodes[8 * c + KUHN[t][q]];
  // a snap that crushes or inverts a tet is undone, unless the node started outside the piece
  const minVol = 0.03 * H * H * H / 6;
  for (let pass = 0; pass < 2; pass++) {
    let bad = 0;
    for (let t = 0; t < nC * 6; t++) {
      const a = tets[4 * t], b = tets[4 * t + 1], c = tets[4 * t + 2], d = tets[4 * t + 3];
      const v0 = tetVol(lat, a, b, c, d), v1 = tetVol(rest, a, b, c, d);
      if (v1 * Math.sign(v0) >= minVol) continue;
      bad++;
      for (const q of [a, b, c, d]) if (boundary[q] === 1) { rest[3 * q] = lat[3 * q]; rest[3 * q + 1] = lat[3 * q + 1]; rest[3 * q + 2] = lat[3 * q + 2]; }
    }
    if (!bad) break;
  }
  // tets still crushed keep their place in the lattice but carry no volume constraint
  const crushed = new Uint8Array(nC * 6);
  for (let t = 0; t < nC * 6; t++) {
    const a = tets[4 * t], b = tets[4 * t + 1], c = tets[4 * t + 2], d = tets[4 * t + 3];
    if (tetVol(rest, a, b, c, d) * Math.sign(tetVol(lat, a, b, c, d)) < minVol) crushed[t] = 1;
  }
  for (let t = 0; t < nC * 6; t++) if (tetVol(lat, tets[4 * t], tets[4 * t + 1], tets[4 * t + 2], tets[4 * t + 3]) < 0) { const s = tets[4 * t + 2]; tets[4 * t + 2] = tets[4 * t + 3]; tets[4 * t + 3] = s; }
  const nT = nC * 6;
  const restVol = new Float32Array(nT), tetInv = new Float32Array(nT * 9);
  const mass = new Float32Array(n);
  for (let t = 0; t < nT; t++) {
    const a = tets[4 * t], b = tets[4 * t + 1], c = tets[4 * t + 2], d = tets[4 * t + 3];
    const v = crushed[t] ? 0 : Math.max(0, tetVol(rest, a, b, c, d));
    restVol[t] = v;
    for (const q of [a, b, c, d]) mass[q] += (crushed[t] ? Math.abs(tetVol(lat, a, b, c, d)) * 0.5 : v) * DENSITY / 4;
    tetInverse(rest, a, b, c, d, tetInv, 9 * t);
  }
  let mMin = Infinity, mSum = 0;
  for (let v = 0; v < n; v++) { mSum += mass[v]; if (mass[v] > 0) mMin = Math.min(mMin, mass[v]); }
  for (let v = 0; v < n; v++) mass[v] = Math.max(mass[v], mSum / n * 0.08);
  // cells: rest shape about the mass centroid, stiffness by tissue
  const cellQ = new Float32Array(nC * 24), cellFirm = new Float32Array(nC);
  for (let c = 0; c < nC; c++) {
    let M = 0; const cm = [0, 0, 0];
    for (let q = 0; q < 8; q++) { const v = cellNodes[8 * c + q], m = mass[v]; M += m; for (let k = 0; k < 3; k++) cm[k] += rest[3 * v + k] * m; }
    for (let k = 0; k < 3; k++) cm[k] /= M;
    for (let q = 0; q < 8; q++) { const v = cellNodes[8 * c + q]; for (let k = 0; k < 3; k++) cellQ[24 * c + 3 * q + k] = rest[3 * v + k] - cm[k]; }
    const depth = melonDepth(cm[0], cm[1], cm[2]);
    cellFirm[c] = depth < MELON.pith * 0.6 ? 3.0 : depth < MELON.pith + 0.06 ? 1.8 : 1.0;
  }
  // unique edges
  const eset = new Map();
  const pairs = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
  for (let t = 0; t < nT; t++) for (const [p, q] of pairs) {
    let i = tets[4 * t + p], j = tets[4 * t + q];
    if (i > j) { const s = i; i = j; j = s; }
    eset.set(i * 1048576 + j, 0);
  }
  const edges = new Uint32Array(eset.size * 2);
  let e = 0;
  for (const key of eset.keys()) { edges[e++] = Math.floor(key / 1048576); edges[e++] = key % 1048576; }
  const surf = [];
  for (let v = 0; v < n; v++) if (boundary[v]) surf.push(v);
  for (let v = 0; v < n; v++) boundary[v] = boundary[v] ? 1 : 0;
  yield;
  return { H, E, O, dims, cellAt, nC, cellNodes, cellQ, cellFirm, n, rest, mass, tets, nT, restVol, tetInv, edges, surface: new Uint32Array(surf) };
}

// barycentric location of a rest point in a lattice: writes tet index and 4 weights
const LOC = { t: 0, w: [1, 0, 0, 0] };
function locate(L, x, y, z) {
  const dx = x - L.O[0], dy = y - L.O[1], dz = z - L.O[2], E = L.E, H = L.H;
  const li = (dx * E[0][0] + dy * E[0][1] + dz * E[0][2]) / H;
  const lj = (dx * E[1][0] + dy * E[1][1] + dz * E[1][2]) / H;
  const lk = (dx * E[2][0] + dy * E[2][1] + dz * E[2][2]) / H;
  const [cx, cy, cz] = L.dims;
  const ci = Math.min(cx - 1, Math.max(0, Math.floor(li))), cj = Math.min(cy - 1, Math.max(0, Math.floor(lj))), ck = Math.min(cz - 1, Math.max(0, Math.floor(lk)));
  let best = -1, bestS = -Infinity, b0 = 0, b1 = 0, b2 = 0, b3 = 0;
  const tryTet = t => {
    const a = L.tets[4 * t], I = 9 * t, inv = L.tetInv, r = L.rest;
    const px = x - r[3 * a], py = y - r[3 * a + 1], pz = z - r[3 * a + 2];
    const w1 = inv[I] * px + inv[I + 1] * py + inv[I + 2] * pz;
    const w2 = inv[I + 3] * px + inv[I + 4] * py + inv[I + 5] * pz;
    const w3 = inv[I + 6] * px + inv[I + 7] * py + inv[I + 8] * pz;
    const w0 = 1 - w1 - w2 - w3;
    const s = Math.min(w0, w1, w2, w3);
    if (s > bestS && L.restVol[t] > 0) { bestS = s; best = t; b0 = w0; b1 = w1; b2 = w2; b3 = w3; }
  };
  for (let r = 0; r <= 3 && bestS < -1e-4; r++) {
    for (let k = ck - r; k <= ck + r; k++) for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
      if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== r) continue;
      if (i < 0 || j < 0 || k < 0 || i >= cx || j >= cy || k >= cz) continue;
      const c = L.cellAt[i + cx * (j + cy * k)];
      if (c >= 0) for (let t = 6 * c; t < 6 * c + 6; t++) tryTet(t);
    }
    if (best >= 0 && bestS > -0.6) break;
  }
  if (best < 0) for (let t = 0; t < L.nT; t++) tryTet(t);
  // keep extrapolation tame for points well outside the lattice
  LOC.t = best; LOC.w[0] = b0; LOC.w[1] = b1; LOC.w[2] = b2; LOC.w[3] = b3;
  return LOC;
}

// ── surface nets ──
function* surfaceNets(planes, S, out) {
  const h = SURF_H, B = 8;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < S.pts.length; i += 3) {
    x0 = Math.min(x0, S.pts[i]); x1 = Math.max(x1, S.pts[i]);
    y0 = Math.min(y0, S.pts[i + 1]); y1 = Math.max(y1, S.pts[i + 1]);
    z0 = Math.min(z0, S.pts[i + 2]); z1 = Math.max(z1, S.pts[i + 2]);
  }
  const pad = S.h + 2 * h;
  x0 -= pad; y0 -= pad; z0 -= pad; x1 += pad; y1 += pad; z1 += pad;
  const nx = Math.ceil((x1 - x0) / h) + 1, ny = Math.ceil((y1 - y0) / h) + 1, nz = Math.ceil((z1 - z0) / h) + 1;
  const grid = new Float32Array(nx * ny * nz).fill(NaN);
  const val = (i, j, k) => {
    const id = i + nx * (j + ny * k);
    let v = grid[id];
    if (v !== v) v = grid[id] = pieceSDF(planes, x0 + i * h, y0 + j * h, z0 + k * h);
    return v;
  };
  const cX = nx - 1, cY = ny - 1, cZ = nz - 1;
  const vertOf = new Int32Array(cX * cY * cZ).fill(-1);
  const pos = out.pos, nrm = out.nrm, mat = out.mat;
  const bx = Math.ceil(cX / B), by = Math.ceil(cY / B), bz = Math.ceil(cZ / B);
  const reach = B * h * 0.87 + 2 * h;
  const cellList = [];
  for (let K = 0; K < bz; K++) {
    for (let J = 0; J < by; J++) for (let I = 0; I < bx; I++) {
      const d = pieceSDF(planes, x0 + (I + 0.5) * B * h, y0 + (J + 0.5) * B * h, z0 + (K + 0.5) * B * h);
      if (Math.abs(d) > reach) continue;
      for (let k = K * B; k < Math.min(cZ, K * B + B); k++) for (let j = J * B; j < Math.min(cY, J * B + B); j++) for (let i = I * B; i < Math.min(cX, I * B + B); i++) {
        let mn = Infinity, mx = -Infinity;
        const c = [];
        for (let q = 0; q < 8; q++) { const v = val(i + (q & 1), j + ((q >> 1) & 1), k + (q >> 2)); c.push(v); if (v < mn) mn = v; if (v > mx) mx = v; }
        if (mn >= 0 || mx < 0) continue;
        // mean of the edge crossings
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (const [a, b] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) {
          if ((c[a] < 0) === (c[b] < 0)) continue;
          const t = c[a] / (c[a] - c[b]);
          const ax = a & 1, ay = (a >> 1) & 1, az = a >> 2, bxx = b & 1, byy = (b >> 1) & 1, bzz = b >> 2;
          sx += ax + (bxx - ax) * t; sy += ay + (byy - ay) * t; sz += az + (bzz - az) * t; cnt++;
        }
        let px = x0 + (i + sx / cnt) * h, py = y0 + (j + sy / cnt) * h, pz = z0 + (k + sz / cnt) * h;
        // one Newton step onto the surface
        const dd = pieceSDF(planes, px, py, pz);
        px -= dd * SG[1]; py -= dd * SG[2]; pz -= dd * SG[3];
        pieceSDF(planes, px, py, pz);
        vertOf[i + cX * (j + cY * k)] = pos.length / 3;
        pos.push(px, py, pz); nrm.push(SG[1], SG[2], SG[3]); mat.push(0);
        cellList.push(i, j, k);
      }
    }
    yield;
  }
  // quads across every sign-changing grid edge
  const idx = out.body;
  const V = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= cX || j >= cY || k >= cZ) ? -1 : vertOf[i + cX * (j + cY * k)];
  const quad = (a, b, c, d) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    // split along the shorter diagonal
    const dac = (pos[3 * a] - pos[3 * c]) ** 2 + (pos[3 * a + 1] - pos[3 * c + 1]) ** 2 + (pos[3 * a + 2] - pos[3 * c + 2]) ** 2;
    const dbd = (pos[3 * b] - pos[3 * d]) ** 2 + (pos[3 * b + 1] - pos[3 * d + 1]) ** 2 + (pos[3 * b + 2] - pos[3 * d + 2]) ** 2;
    if (dac <= dbd) idx.push(a, b, c, a, c, d); else idx.push(a, b, d, b, c, d);
  };
  for (let q = 0; q < cellList.length; q += 3) {
    const i = cellList[q], j = cellList[q + 1], k = cellList[q + 2];
    const v0 = val(i, j, k);
    if ((v0 < 0) !== (val(i + 1, j, k) < 0)) quad(V(i, j, k), V(i, j - 1, k), V(i, j - 1, k - 1), V(i, j, k - 1));
    if ((v0 < 0) !== (val(i, j + 1, k) < 0)) quad(V(i, j, k), V(i, j, k - 1), V(i - 1, j, k - 1), V(i - 1, j, k));
    if ((v0 < 0) !== (val(i, j, k + 1) < 0)) quad(V(i, j, k), V(i - 1, j, k), V(i - 1, j - 1, k), V(i, j - 1, k));
  }
  orientToNormals(pos, nrm, idx, 0);
  yield;
}

// make every triangle's winding agree with its vertex normals (CCW = front)
function orientToNormals(pos, nrm, idx, from) {
  for (let i = from; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    const e1x = pos[3 * b] - pos[3 * a], e1y = pos[3 * b + 1] - pos[3 * a + 1], e1z = pos[3 * b + 2] - pos[3 * a + 2];
    const e2x = pos[3 * c] - pos[3 * a], e2y = pos[3 * c + 1] - pos[3 * a + 1], e2z = pos[3 * c + 2] - pos[3 * a + 2];
    const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    const d = fx * (nrm[3 * a] + nrm[3 * b] + nrm[3 * c]) + fy * (nrm[3 * a + 1] + nrm[3 * b + 1] + nrm[3 * c + 1]) + fz * (nrm[3 * a + 2] + nrm[3 * b + 2] + nrm[3 * c + 2]);
    if (d < 0) { idx[i + 1] = c; idx[i + 2] = b; }
  }
}

// ── seeds and bubbles near the cut faces of a piece ──
function placeInclusions(planes, cutPlanes, out) {
  const { seeds, bubbles } = melonInclusions();
  const pos = out.pos, nrm = out.nrm, mat = out.mat;
  if (!cutPlanes.length) return 0;
  let count = 0;
  // where an inclusion sits in this piece: null if it belongs elsewhere or lies too deep to see
  const settle = (p, extent, near) => {
    let dmin = Infinity;
    for (const pl of cutPlanes) {
      const dp = pl[0] * p[0] + pl[1] * p[1] + pl[2] * p[2] - pl[3];
      if (dp > 0) return null;
      dmin = Math.min(dmin, -dp);
    }
    if (pieceSDFsharp(planes, p[0], p[1], p[2]) > 0) return null;
    if (dmin > near) return null;
    const q = p.slice();
    // the blade went through it: it stays on this side and settles just under the new face
    for (let it = 0; it < 3; it++) for (const pl of cutPlanes) {
      const e = extent(pl);
      const dp = pl[0] * q[0] + pl[1] * q[1] + pl[2] * q[2] - pl[3];
      const push = dp + e + SEED_FILM;
      if (push > 0) { q[0] -= pl[0] * push; q[1] -= pl[1] * push; q[2] -= pl[2] * push; }
    }
    // it must end up wholly inside the piece and in the flesh (not wedged into a corner)
    for (const pl of cutPlanes) if (pl[0] * q[0] + pl[1] * q[1] + pl[2] * q[2] - pl[3] + extent(pl) > 1e-4) return null;
    if (melonDepth(q[0], q[1], q[2]) < MELON.pith + 0.05) return null;
    return q;
  };
  const nt = 8, nph = 10;
  for (const sd of seeds) {
    const q = settle(sd.p, pl => seedExtent(sd, pl), 0.13);
    if (!q) continue;
    count++;
    const base = pos.length / 3;
    for (let i = 0; i <= nt; i++) {
      const t = Math.PI * i / nt, s = (1 - Math.cos(t)) / 2;
      const prof = Math.pow(Math.sin(t), 0.9) * (0.36 + 0.64 * Math.pow(s, 0.7));
      for (let j = 0; j < nph; j++) {
        const ph = 2 * Math.PI * j / nph;
        const lb = Math.cos(ph) * prof * sd.W / 2, lc = Math.sin(ph) * prof * sd.H / 2, la = (s - 0.5) * sd.L;
        for (let k = 0; k < 3; k++) {
          pos.push(q[k] + sd.a[k] * la + sd.b[k] * lb + sd.c[k] * lc);
        }
        const na = la / sd.L, nb = lb / sd.W, nc = lc / sd.H;
        let nn = [sd.a[0] * na + sd.b[0] * nb + sd.c[0] * nc * 2, sd.a[1] * na + sd.b[1] * nb + sd.c[1] * nc * 2, sd.a[2] * na + sd.b[2] * nb + sd.c[2] * nc * 2];
        const l = Math.hypot(...nn) || 1;
        nrm.push(nn[0] / l, nn[1] / l, nn[2] / l); mat.push(1);
      }
    }
    for (let i = 0; i < nt; i++) for (let j = 0; j < nph; j++) {
      const a = base + i * nph + j, b = base + i * nph + (j + 1) % nph, c = a + nph, d = b + nph;
      out.seeds.push(a, b, c, b, d, c);
    }
  }
  const bs = 5, bp = 8;
  for (const bu of bubbles) {
    const q = settle(bu.p, () => bu.r, 0.07);
    if (!q) continue;
    const base = pos.length / 3;
    for (let i = 0; i <= bs; i++) {
      const t = Math.PI * i / bs;
      for (let j = 0; j < bp; j++) {
        const ph = 2 * Math.PI * j / bp;
        const nx = Math.sin(t) * Math.cos(ph), ny = Math.cos(t), nz = Math.sin(t) * Math.sin(ph);
        pos.push(q[0] + nx * bu.r, q[1] + ny * bu.r, q[2] + nz * bu.r); nrm.push(nx, ny, nz); mat.push(2);
      }
    }
    for (let i = 0; i < bs; i++) for (let j = 0; j < bp; j++) {
      const a = base + i * bp + j, b = base + i * bp + (j + 1) % bp, c = a + bp, d = b + bp;
      out.bubbles.push(a, b, c, b, d, c);
    }
  }
  return count;
}

// ── a whole piece ──
// planes: [[nx, ny, nz, c], ...] (all half-spaces); cuts: the subset that are knife cuts (all of them, here)
function* buildPiece(planeList, S = null) {
  const planes = new Float64Array(planeList.length * 4);
  planeList.forEach((p, i) => planes.set(p, 4 * i));
  if (!S) { S = samplePiece(planes); yield; }
  const lattice = yield* buildLattice(planes, S);
  const out = { pos: [], nrm: [], mat: [], body: [], seeds: [], bubbles: [] };
  yield* surfaceNets(planes, S, out);
  const nSeeds = placeInclusions(planes, planeList, out);
  orientToNormals(out.pos, out.nrm, out.seeds, 0);
  orientToNormals(out.pos, out.nrm, out.bubbles, 0);
  yield;
  // embed every render vertex
  const nV = out.pos.length / 3;
  const skinIdx = new Uint32Array(nV * 4), skinW = new Float32Array(nV * 4);
  for (let v = 0; v < nV; v++) {
    const L = locate(lattice, out.pos[3 * v], out.pos[3 * v + 1], out.pos[3 * v + 2]);
    for (let j = 0; j < 4; j++) { skinIdx[4 * v + j] = lattice.tets[4 * L.t + j]; skinW[4 * v + j] = L.w[j]; }
    if ((v & 1023) === 1023) yield;
  }
  return {
    planes: planeList, planesF: planes, vol: S.vol, sim: lattice,
    render: {
      rest: new Float32Array(out.pos), nrm: new Float32Array(out.nrm), mat: new Float32Array(out.mat),
      body: new Uint32Array(out.body), seeds: new Uint32Array(out.seeds), bubbles: new Uint32Array(out.bubbles),
      skinIdx, skinW, nSeeds,
    },
  };
}

// run a generator to completion
function runGen(g) { let r; do { r = g.next(); } while (!r.done); return r.value; }
