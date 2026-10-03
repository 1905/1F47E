// ===== knife.js =====
// ─────────────────────────────────────────────────────────────
//  The knife: a long nakiri-style blade, built at unit scale and posed at KNIFE.S
//  local frame: +x along the blade toward the tip, +y up, edge on y = 0,
//  blade face normals ±z. The handle runs along −x.
//  materials: 3.0 ground edge bevel · 3.45 blade flat · 3.7 bolster · 5 handle
// ─────────────────────────────────────────────────────────────

const KNIFE = {
  Lb: 1.72,        // blade length (model units)
  H: 0.63,        // blade height at the heel
  xr: 0.86,       // reference point on the edge that follows the cut (blade middle)
  handleLen: 0.84,
  S: 1.85,        // the model is posed at this scale: a 32 cm melon knife
};

function knifeHandleCentre(p) { return 0.56 - 0.028 * p * p; } // p ∈ [0,1] from bolster to butt

function buildKnifeMesh() {
  const { Lb, H } = KNIFE;
  const pos = [], mat = [], idx = [], hint = [];
  const add = (x, y, z, m) => { pos.push(x, y, z); mat.push(m); return pos.length / 3 - 1; };
  // add a triangle, flipping its winding if needed so it faces along `out`
  const tri = (a, b, c, out) => {
    const P = i => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
    const A = P(a), B = P(b), C = P(c);
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) idx.push(a, c, b); else idx.push(a, b, c);
  };
  const quad = (a, b, c, d, out) => { tri(a, b, c, out); tri(a, c, d, out); };

  // ── blade ──
  // profile: straight edge with a small lift at the very front, flat spine that drops into a rounded nose
  const bottom = u => { const s = Math.max(0, (u - 0.86) / 0.14); return 0.06 * s * s; };
  const top = u => { const s = Math.max(0, (u - 0.72) / 0.28); return H * (1 - 0.05 * u) - H * 0.34 * Math.pow(s, 2.2); };
  // half thickness across the height: thin ground bevel, then a flat grind to the spine
  const half = (u, v) => {
    const taper = 1 - 0.45 * Math.max(0, (u - 0.7) / 0.3);
    const t = v < 0.2 ? 0.0009 + (0.0062 - 0.0009) * (v / 0.2) : 0.0062 + 0.0095 * Math.pow((v - 0.2) / 0.8, 0.9);
    return t * taper;
  };
  const vs = [0, 0.05, 0.11, 0.16, 0.2, 0.215, 0.3, 0.45, 0.6, 0.75, 0.88, 0.95, 1];
  const nu = 44;
  const us = []; for (let i = 0; i <= nu; i++) us.push(i / nu);
  const grid = { 1: [], [-1]: [] };
  for (const sg of [1, -1]) {
    for (let i = 0; i <= nu; i++) {
      const u = us[i], row = [];
      for (const v of vs) {
        const y = bottom(u) + (top(u) - bottom(u)) * v;
        row.push(add(u * Lb, y, sg * half(u, v), v <= 0.2 ? 3.0 : 3.45));
      }
      grid[sg].push(row);
    }
    for (let i = 0; i < nu; i++) for (let j = 0; j < vs.length - 1; j++)
      quad(grid[sg][i][j], grid[sg][i + 1][j], grid[sg][i + 1][j + 1], grid[sg][i][j + 1], [0, 0, sg]);
  }
  const J = vs.length - 1;
  // spine, edge, nose and heel strips (duplicated vertices so the creases stay sharp)
  const strip = (getA, getB, count, outFn, m) => {
    let pa = null, pb = null;
    for (let i = 0; i <= count; i++) {
      const A = getA(i), B = getB(i);
      const a = add(A[0], A[1], A[2], m), b = add(B[0], B[1], B[2], m);
      if (pa !== null) quad(pa, a, b, pb, outFn(i));
      pa = a; pb = b;
    }
  };
  const P = i => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
  strip(i => P(grid[1][i][J]), i => P(grid[-1][i][J]), nu, i => { const u = us[i]; return [-(top(Math.min(1, u + 0.01)) - top(u)) / (0.01 * Lb), 1, 0]; }, 3.45);
  strip(i => P(grid[1][i][0]), i => P(grid[-1][i][0]), nu, () => [0, -1, 0], 3.0);
  strip(j => P(grid[1][nu][j]), j => P(grid[-1][nu][j]), J, () => [1, 0, 0], 3.45);
  strip(j => P(grid[1][0][j]), j => P(grid[-1][0][j]), J, () => [-1, 0, 0], 3.45);

  // ── bolster: a short polished block between blade and handle ──
  const box = (x0, x1, y0, y1, z0, z1, m) => {
    const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const faces = [[0, 1, 2, 3, [0, 0, -1]], [4, 5, 6, 7, [0, 0, 1]], [0, 1, 5, 4, [0, -1, 0]], [3, 2, 6, 7, [0, 1, 0]], [0, 3, 7, 4, [-1, 0, 0]], [1, 2, 6, 5, [1, 0, 0]]];
    for (const [a, b, cc, d, out] of faces) {
      const ia = add(...c[a], m), ib = add(...c[b], m), ic = add(...c[cc], m), id = add(...c[d], m);
      quad(ia, ib, ic, id, out);
    }
  };
  box(-0.07, 0.004, 0.45, H * 0.985, -0.026, 0.026, 3.7);

  // ── handle: slightly swelling oval section, dropping a touch toward the butt ──
  const L = KNIFE.handleLen, NR = 26, NT = 22, x0 = -0.07;
  const ring = [];
  const sec = p => ({ c: knifeHandleCentre(p), a: 0.08 * (1 + 0.1 * Math.sin(Math.PI * p) + 0.05 * p), b: 0.054 * (1 + 0.14 * Math.sin(Math.PI * p)) });
  for (let i = 0; i <= NR; i++) {
    const p = i / NR, x = x0 - p * L, s = sec(p), r = [];
    for (let k = 0; k < NT; k++) {
      const th = k / NT * Math.PI * 2;
      r.push(add(x, s.c + Math.sin(th) * s.a, Math.cos(th) * s.b, 5));
    }
    ring.push(r);
  }
  for (let i = 0; i < NR; i++) for (let k = 0; k < NT; k++) {
    const k2 = (k + 1) % NT;
    const a = ring[i][k], b = ring[i + 1][k], c = ring[i + 1][k2], d = ring[i][k2];
    const A = P(a); const cy = sec(i / NR).c;
    quad(a, b, c, d, [0, A[1] - cy, A[2]]);
  }
  // end caps (flat)
  for (const [p, dir] of [[0, 1], [1, -1]]) {
    const i = Math.round(p * NR), x = x0 - p * L, s = sec(p);
    const centre = add(x + dir * 0.004, s.c, 0, 5);
    const rim = ring[i].map(v => add(...P(v), 5));
    for (let k = 0; k < NT; k++) tri(centre, rim[k], rim[(k + 1) % NT], [dir, 0, 0]);
  }

  // smooth normals per vertex (creases come from the duplicated vertices)
  const nV = pos.length / 3, nrm = new Float32Array(nV * 3);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const A = P(a), B = P(b), C = P(c);
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const v of [a, b, c]) { nrm[3 * v] += n[0]; nrm[3 * v + 1] += n[1]; nrm[3 * v + 2] += n[2]; }
  }
  for (let v = 0; v < nV; v++) {
    const l = Math.hypot(nrm[3 * v], nrm[3 * v + 1], nrm[3 * v + 2]) || 1;
    nrm[3 * v] /= l; nrm[3 * v + 1] /= l; nrm[3 * v + 2] /= l;
  }
  return { rest: new Float32Array(pos), nrm, mat: new Float32Array(mat), index: new Uint32Array(idx) };
}
