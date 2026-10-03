// ===== sdf.js =====
// ─────────────────────────────────────────────────────────────
//  The melon as a signed distance field, pieces as the melon clipped
//  by cut half-spaces, and the seeds and bubbles that grew inside it.
//  Rest frame: +x along the melon (stem end at +x), +y up, belly at y≈0.
//  1 unit = 10 cm.
// ─────────────────────────────────────────────────────────────

const MELON = {
  A: 1.6,        // half length (x)
  B: 1.0,        // half height (y)
  C: 1.06,       // half width (z)
  cy: 0.9,       // centre height
  belly: 0.12,   // how much of the belly is flattened
  bellyK: 0.26,  // softness of the flattening
  skin: 0.045,   // dark green skin band depth
  pith: 0.16,    // skin + pale pith band depth
  cutK: 0.05,    // rounding of fresh cut edges
  gap: 0.004,    // half the kerf left by the blade
};

// seeded PRNG so the specimen is identical on each load
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Results of the gradient-returning SDF calls: [d, gx, gy, gz]
const SG = new Float64Array(4);

// polynomial smooth maximum; returns the value and leaves the weight of `a` in SMAX_W
let SMAX_W = 1;
function smax(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  if (a >= b) { SMAX_W = 1 - h * 0.5; return a + h * h * k * 0.25; }
  SMAX_W = h * 0.5; return b + h * h * k * 0.25;
}

// melon SDF with an approximate unit gradient (written to SG)
function melonSDF(x, y, z) {
  const { A, B, C, cy } = MELON;
  const qy = y - cy;
  const px = x / A, py = qy / B, pz = z / C;
  const k0 = Math.sqrt(px * px + py * py + pz * pz);
  const rx = x / (A * A), ry = qy / (B * B), rz = z / (C * C);
  const k1 = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1e-9;
  const e = k0 * (k0 - 1) / k1;
  let gx = rx / k1, gy = ry / k1, gz = rz / k1;
  const b = -(qy + B - MELON.belly);
  const d = smax(e, b, MELON.bellyK);
  const w = SMAX_W;
  gx *= w; gy = gy * w - (1 - w); gz *= w;
  const l = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
  SG[0] = d; SG[1] = gx / l; SG[2] = gy / l; SG[3] = gz / l;
  return d;
}
// depth under the skin (positive inside), no gradient
function melonDepth(x, y, z) {
  const { A, B, C, cy } = MELON;
  const qy = y - cy;
  const px = x / A, py = qy / B, pz = z / C;
  const k0 = Math.sqrt(px * px + py * py + pz * pz);
  const rx = x / (A * A), ry = qy / (B * B), rz = z / (C * C);
  const k1 = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1e-9;
  return -smax(k0 * (k0 - 1) / k1, -(qy + B - MELON.belly), MELON.bellyK);
}

// a piece: the melon clipped by planes {n, c} (kept side n·p ≤ c), fresh edges rounded
// planes is a flat Float64Array [nx, ny, nz, c, ...]
function pieceSDF(planes, x, y, z) {
  let d = melonSDF(x, y, z);
  let gx = SG[1], gy = SG[2], gz = SG[3];
  for (let i = 0; i < planes.length; i += 4) {
    const nx = planes[i], ny = planes[i + 1], nz = planes[i + 2];
    const p = nx * x + ny * y + nz * z - planes[i + 3];
    d = smax(d, p, MELON.cutK);
    const w = SMAX_W;
    gx = gx * w + nx * (1 - w); gy = gy * w + ny * (1 - w); gz = gz * w + nz * (1 - w);
  }
  const l = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
  SG[0] = d; SG[1] = gx / l; SG[2] = gy / l; SG[3] = gz / l;
  return d;
}
// the same without rounding or gradient, for quick inside tests
function pieceSDFsharp(planes, x, y, z) {
  let d = -melonDepth(x, y, z);
  for (let i = 0; i < planes.length; i += 4) d = Math.max(d, planes[i] * x + planes[i + 1] * y + planes[i + 2] * z - planes[i + 3]);
  return d;
}

const MELON_BOX = { x0: -MELON.A - 0.06, x1: MELON.A + 0.06, y0: -0.04, y1: MELON.cy + MELON.B + 0.06, z0: -MELON.C - 0.06, z1: MELON.C + 0.06 };

// ── seeds: teardrops in a three-lobed ring at about two thirds of the radius ──
// each seed: centre, long axis a (radial, wide end outward), width axis b, thickness axis c, sizes
let SEEDS = null, BUBBLES = null;
function melonInclusions() {
  if (SEEDS) return { seeds: SEEDS, bubbles: BUBBLES };
  const { A, B, C, cy } = MELON;
  const R = rng(10);
  SEEDS = [];
  let guard = 0;
  while (SEEDS.length < 700 && guard++ < 20000) {
    // along the melon, denser where the cross-section is larger
    const x = (R() * 2 - 1) * A * 0.84;
    const s2 = 1 - (x / A) ** 2;
    if (R() > s2) continue;
    const s = Math.sqrt(s2);
    // three lobes: the seed ring bulges toward three directions, seeds crowd into the lobes
    let th = R() * Math.PI * 2;
    th += 0.18 * Math.sin(3 * th + 0.5);
    const lobe = Math.cos(3 * th + 0.5);
    const rf = 0.62 + 0.085 * lobe + (R() - 0.5) * 0.07 + (R() < 0.5 ? 0.025 : -0.025);
    const cyx = Math.sin(th), czx = Math.cos(th);
    const y = cy + B * s * rf * cyx, z = C * s * rf * czx;
    if (melonDepth(x, y, z) < MELON.pith + 0.1) continue;
    // radial direction in the cross-section (outward), tipped a little toward the ends
    let a = [x / A * 0.35, cyx / B, czx / C];
    let l = Math.hypot(...a); a = a.map(v => v / l);
    // thickness mostly along the melon's axis, so a round slice shows the seeds' faces
    let c = [1, (R() - 0.5) * 0.3, (R() - 0.5) * 0.3];
    const ca = c[0] * a[0] + c[1] * a[1] + c[2] * a[2];
    c = [c[0] - ca * a[0], c[1] - ca * a[1], c[2] - ca * a[2]];
    l = Math.hypot(...c); c = c.map(v => v / l);
    const b = [a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]];
    const k = 0.85 + R() * 0.3;
    SEEDS.push({ p: [x, y, z], a, b, c, L: 0.105 * k, W: 0.066 * k, H: 0.026 * k });
  }
  BUBBLES = [];
  guard = 0;
  while (BUBBLES.length < 420 && guard++ < 20000) {
    const x = (R() * 2 - 1) * A, y = cy + (R() * 2 - 1) * B, z = (R() * 2 - 1) * C;
    if (melonDepth(x, y, z) < MELON.pith + 0.06) continue;
    BUBBLES.push({ p: [x, y, z], r: 0.003 + R() * R() * 0.011 });
  }
  return { seeds: SEEDS, bubbles: BUBBLES };
}

// half extent of a seed along a unit direction n
function seedExtent(sd, n) {
  return Math.abs(n[0] * sd.a[0] + n[1] * sd.a[1] + n[2] * sd.a[2]) * sd.L * 0.5
       + Math.abs(n[0] * sd.b[0] + n[1] * sd.b[1] + n[2] * sd.b[2]) * sd.W * 0.5
       + Math.abs(n[0] * sd.c[0] + n[1] * sd.c[1] + n[2] * sd.c[2]) * sd.H * 0.5;
}

// symmetric 3x3 eigen decomposition (Jacobi); m row-major, returns { values, vectors (columns, row-major 3x3) }
function eigSym3(m) {
  const a = Float64Array.from(m), v = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    if (off < 1e-14) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = a[3 * p + q];
      if (Math.abs(apq) < 1e-15) continue;
      const app = a[3 * p + p], aqq = a[3 * q + q];
      const th = 0.5 * Math.atan2(2 * apq, aqq - app);
      const c = Math.cos(th), s = Math.sin(th);
      for (let k = 0; k < 3; k++) {
        const akp = a[3 * k + p], akq = a[3 * k + q];
        a[3 * k + p] = c * akp - s * akq; a[3 * k + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[3 * p + k], aqk = a[3 * q + k];
        a[3 * p + k] = c * apk - s * aqk; a[3 * q + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[3 * k + p], vkq = v[3 * k + q];
        v[3 * k + p] = c * vkp - s * vkq; v[3 * k + q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [a[0], a[4], a[8]], vectors: v };
}

// coarse volume sampling of a piece: inside points, volume, mean, principal frame
function samplePiece(planes, h = 0.06, budget = null) {
  const { x0, x1, y0, y1, z0, z1 } = MELON_BOX;
  const pts = [];
  for (let x = x0 + h / 2; x < x1; x += h) for (let y = y0 + h / 2; y < y1; y += h) for (let z = z0 + h / 2; z < z1; z += h) {
    if (pieceSDFsharp(planes, x, y, z) < 0) pts.push(x, y, z);
  }
  const n = pts.length / 3;
  const vol = n * h * h * h;
  const mean = [0, 0, 0];
  for (let i = 0; i < pts.length; i += 3) { mean[0] += pts[i]; mean[1] += pts[i + 1]; mean[2] += pts[i + 2]; }
  if (n) for (let k = 0; k < 3; k++) mean[k] /= n;
  const cov = new Float64Array(9);
  for (let i = 0; i < pts.length; i += 3) {
    const d = [pts[i] - mean[0], pts[i + 1] - mean[1], pts[i + 2] - mean[2]];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[3 * r + c] += d[r] * d[c];
  }
  return { pts, n, vol, mean, cov, h };
}
