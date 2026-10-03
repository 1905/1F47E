// ===== physics.js =====
// ─────────────────────────────────────────────────────────────
//  XPBD soft bodies, one per piece, solved together:
//  · 8-node co-rotational shape matching per lattice cell (warm-started
//    rotation, strain stiffening), rind cells firmer than flesh
//  · tet volume constraints → near-incompressibility
//  · edge damping, plus damping of each piece's deformation relative to
//    its rigid motion (never the fall or tumble), rolling resistance
//  · floor contact with Coulomb friction, piece-to-piece contact against
//    each other's exact SDF in a best-fit frame, sleeping pieces as walls
//  Fixed 60 Hz step, 6 substeps, one iteration per substep.
// ─────────────────────────────────────────────────────────────

class Body {
  constructor(piece) {
    const L = piece.sim;
    this.piece = piece;
    this.planesF = piece.planesF;
    this.L = L;
    this.n = L.n;
    this.rest = L.rest;
    this.x = Float32Array.from(L.rest);
    this.prev = Float32Array.from(L.rest);
    this.v = new Float32Array(L.n * 3);
    this.mass = L.mass;
    this.invMass = new Float32Array(L.n);
    this.totalMass = 0;
    for (let i = 0; i < L.n; i++) { this.invMass[i] = 1 / L.mass[i]; this.totalMass += L.mass[i]; }
    this.restVolume = 0;
    for (let t = 0; t < L.nT; t++) this.restVolume += L.restVol[t];
    this.cellRot = new Float32Array(L.nC * 4);
    for (let c = 0; c < L.nC; c++) this.cellRot[4 * c + 3] = 1;
    this.restLen = new Float32Array(L.edges.length / 2);
    for (let e = 0; e < this.restLen.length; e++) {
      const i = L.edges[2 * e], j = L.edges[2 * e + 1];
      this.restLen[e] = Math.hypot(L.rest[3 * i] - L.rest[3 * j], L.rest[3 * i + 1] - L.rest[3 * j + 1], L.rest[3 * i + 2] - L.rest[3 * j + 2]);
    }
    // rest centroid (mass weighted)
    this.cr = [0, 0, 0];
    for (let i = 0; i < L.n; i++) for (let k = 0; k < 3; k++) this.cr[k] += L.rest[3 * i + k] * L.mass[i];
    for (let k = 0; k < 3; k++) this.cr[k] /= this.totalMass;
    // best-fit frame (rest → world), warm-started
    this.fq = [0, 0, 0, 1];
    this.R = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    this.cw = this.cr.slice();
    this.box = new Float32Array(6);
    this.asleep = false; this.calm = 0;
    this.onFloor = 0;
    this.side = 0;     // which way the blade pushes this piece (after a cut)
    this.contacts = [];  // this substep's piece contacts: particle offset, normal
  }
  centroid() {
    const { x, mass, n } = this; let X = 0, Y = 0, Z = 0;
    for (let i = 0; i < n; i++) { const m = mass[i]; X += x[3 * i] * m; Y += x[3 * i + 1] * m; Z += x[3 * i + 2] * m; }
    return [X / this.totalMass, Y / this.totalMass, Z / this.totalMass];
  }
  // best rigid frame of the body, Müller et al. rotation extraction (warm-started)
  updateFrame(iters = 3) {
    const { x, rest, mass, n, cr } = this;
    const cw = this.centroid(); this.cw = cw;
    const A = new Float64Array(9);
    for (let i = 0; i < n; i++) {
      const m = mass[i];
      const px = (x[3 * i] - cw[0]) * m, py = (x[3 * i + 1] - cw[1]) * m, pz = (x[3 * i + 2] - cw[2]) * m;
      const qx = rest[3 * i] - cr[0], qy = rest[3 * i + 1] - cr[1], qz = rest[3 * i + 2] - cr[2];
      A[0] += px * qx; A[1] += px * qy; A[2] += px * qz;
      A[3] += py * qx; A[4] += py * qy; A[5] += py * qz;
      A[6] += pz * qx; A[7] += pz * qy; A[8] += pz * qz;
    }
    let [qx, qy, qz, qw] = this.fq;
    const R = this.R;
    for (let it = 0; it < iters; it++) {
      R[0] = 1 - 2 * (qy * qy + qz * qz); R[1] = 2 * (qx * qy - qw * qz); R[2] = 2 * (qx * qz + qw * qy);
      R[3] = 2 * (qx * qy + qw * qz); R[4] = 1 - 2 * (qx * qx + qz * qz); R[5] = 2 * (qy * qz - qw * qx);
      R[6] = 2 * (qx * qz - qw * qy); R[7] = 2 * (qy * qz + qw * qx); R[8] = 1 - 2 * (qx * qx + qy * qy);
      let ox = 0, oy = 0, oz = 0, den = 0;
      for (let col = 0; col < 3; col++) {
        const rx = R[col], ry = R[3 + col], rz = R[6 + col], ax = A[col], ay = A[3 + col], az = A[6 + col];
        ox += ry * az - rz * ay; oy += rz * ax - rx * az; oz += rx * ay - ry * ax; den += rx * ax + ry * ay + rz * az;
      }
      const s = 1 / (Math.abs(den) + 1e-12);
      const wx = ox * s, wy = oy * s, wz = oz * s, w = Math.hypot(wx, wy, wz);
      if (w < 1e-9) break;
      const hh = Math.min(w, 2) / 2, sn = Math.sin(hh) / w, cs = Math.cos(hh);
      const ax = wx * sn, ay = wy * sn, az = wz * sn;
      const nx = cs * qx + ax * qw + ay * qz - az * qy, ny = cs * qy - ax * qz + ay * qw + az * qx;
      const nz = cs * qz + ax * qy - ay * qx + az * qw, nw = cs * qw - ax * qx - ay * qy - az * qz;
      const l = Math.hypot(nx, ny, nz, nw); qx = nx / l; qy = ny / l; qz = nz / l; qw = nw / l;
    }
    R[0] = 1 - 2 * (qy * qy + qz * qz); R[1] = 2 * (qx * qy - qw * qz); R[2] = 2 * (qx * qz + qw * qy);
    R[3] = 2 * (qx * qy + qw * qz); R[4] = 1 - 2 * (qx * qx + qz * qz); R[5] = 2 * (qy * qz - qw * qx);
    R[6] = 2 * (qx * qz - qw * qy); R[7] = 2 * (qy * qz + qw * qx); R[8] = 1 - 2 * (qx * qx + qy * qy);
    this.fq = [qx, qy, qz, qw];
  }
  updateBox() {
    const b = this.box, x = this.x;
    b[0] = b[1] = b[2] = Infinity; b[3] = b[4] = b[5] = -Infinity;
    for (let i = 0; i < x.length; i += 3) for (let k = 0; k < 3; k++) { const v = x[i + k]; if (v < b[k]) b[k] = v; if (v > b[3 + k]) b[3 + k] = v; }
  }
  kinetic() {
    let e = 0; const v = this.v;
    for (let i = 0; i < this.n; i++) e += 0.5 * this.mass[i] * (v[3 * i] ** 2 + v[3 * i + 1] ** 2 + v[3 * i + 2] ** 2);
    return e;
  }
  volume() {
    const L = this.L, x = this.x; let s = 0;
    for (let t = 0; t < L.nT; t++) s += tetVol(x, L.tets[4 * t], L.tets[4 * t + 1], L.tets[4 * t + 2], L.tets[4 * t + 3]);
    return s;
  }
  wake() { this.asleep = false; this.calm = 0; }
}

class World {
  constructor(bodies, opts = {}) {
    this.bodies = bodies;
    this.gravity = -9.81;
    this.firmness = opts.firmness ?? 0.45;
    this.damping = opts.damping ?? 0.45;
    this.substeps = 6;
    this.stepDt = 1 / 60;
    this.friction = 0.6;
    this.maxSpeed = 14;
    this.blade = null;
    this.grab = null;   // { body, idx, w, off, n, target, start, rot }
    this.subIndex = 0;
    this.time = 0;
  }
  // firmness 0..1 → fraction of the way to the goal shape per substep (log scale)
  shapeK() { return Math.exp(Math.log(0.05) + (Math.log(0.55) - Math.log(0.05)) * this.firmness); }
  volCompliance() { return 2e-5 * (1 - 0.7 * this.firmness); }
  // damping 0..1 → rates (1/s)
  deformDamp() { return 1.5 + 28 * this.damping * this.damping; }
  edgeDamp() { return 0.5 + 10 * this.damping * this.damping; }

  totalMass() { let m = 0; for (const b of this.bodies) m += b.totalMass; return m; }
  restVolume() { let v = 0; for (const b of this.bodies) v += b.restVolume; return v; }
  volume() { let v = 0; for (const b of this.bodies) v += b.volume(); return v; }
  kinetic() { let e = 0; for (const b of this.bodies) e += b.kinetic(); return e; }
  particleCount() { let n = 0; for (const b of this.bodies) n += b.n; return n; }
  cellCount() { let n = 0; for (const b of this.bodies) n += b.L.nC; return n; }

  reset(drop = 0.3) {
    for (const b of this.bodies) {
      for (let i = 0; i < b.n; i++) { b.x[3 * i] = b.rest[3 * i]; b.x[3 * i + 1] = b.rest[3 * i + 1] + drop; b.x[3 * i + 2] = b.rest[3 * i + 2]; }
      b.prev.set(b.x); b.v.fill(0); b.cellRot.fill(0);
      for (let c = 0; c < b.L.nC; c++) b.cellRot[4 * c + 3] = 1;
      b.fq = [0, 0, 0, 1]; b.wake();
    }
    this.endGrab();
  }

  nudge(strength = 1) {
    for (const b of this.bodies) {
      b.wake();
      const c = b.centroid();
      const vy = 2.6 * strength, wx = 1.6 * strength, wz = -1.1 * strength, wy = 0.9 * strength;
      for (let i = 0; i < b.n; i++) {
        const rx = b.x[3 * i] - c[0], ry = b.x[3 * i + 1] - c[1], rz = b.x[3 * i + 2] - c[2];
        b.v[3 * i] += wy * rz - wz * ry;
        b.v[3 * i + 1] += vy + wz * rx - wx * rz;
        b.v[3 * i + 2] += wx * ry - wy * rx;
      }
    }
  }

  // ── grabbing: a soft patch attachment on the touched body ──
  beginGrab(body, hit, radius = 0.42) {
    body.wake();
    const g = { body, idx: [], w: [], off: [], target: Float32Array.from(hit), start: Float32Array.from(hit), rot: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) };
    let nearest = -1, nd = Infinity;
    for (let i = 0; i < body.n; i++) {
      const dx = body.x[3 * i] - hit[0], dy = body.x[3 * i + 1] - hit[1], dz = body.x[3 * i + 2] - hit[2];
      const d = Math.hypot(dx, dy, dz);
      if (d < nd) { nd = d; nearest = i; }
      if (d < radius) { const f = 1 - d / radius; g.idx.push(i); g.w.push(f * f * (3 - 2 * f)); g.off.push(dx, dy, dz); }
    }
    if (!g.idx.length && nearest >= 0) {
      g.idx.push(nearest); g.w.push(1);
      g.off.push(body.x[3 * nearest] - hit[0], body.x[3 * nearest + 1] - hit[1], body.x[3 * nearest + 2] - hit[2]);
    }
    this.grab = g;
  }
  moveGrab(target, rot) {
    const g = this.grab; if (!g) return;
    g.target.set(target);
    const dx = target[0] - g.start[0], dy = target[1] - g.start[1], dz = target[2] - g.start[2];
    const d = Math.hypot(dx, dy, dz), maxReach = 7;
    if (d > maxReach) { const k = maxReach / d; g.target[0] = g.start[0] + dx * k; g.target[1] = g.start[1] + dy * k; g.target[2] = g.start[2] + dz * k; }
    if (rot) g.rot.set(rot);
    // never drive the held patch into the table: lift the patch instead of crushing it
    const R = g.rot; let lowest = Infinity;
    for (let k = 0; k < g.idx.length; k++) lowest = Math.min(lowest, R[3] * g.off[3 * k] + R[4] * g.off[3 * k + 1] + R[5] * g.off[3 * k + 2]);
    if (Number.isFinite(lowest)) g.target[1] = Math.max(g.target[1], 0.004 - lowest);
    g.body.wake();
  }
  endGrab() { this.grab = null; }

  step() {
    const dt = this.stepDt / this.substeps;
    for (const b of this.bodies) if (!b.asleep) { b.onFloor = 0; b.touching = 0; }
    for (let s = 0; s < this.substeps; s++) this.substep(dt, s);
    // velocity damping once per step: along edges, and of deformation relative to rigid motion
    for (const b of this.bodies) if (!b.asleep) { this.dampEdges(b, this.stepDt); this.dampDeformation(b, this.stepDt); }
    this.time += this.stepDt;
    this.sleepCheck();
    for (const b of this.bodies) for (let i = 0; i < b.x.length; i += 61) if (!Number.isFinite(b.x[i])) { this.reset(0.2); return; }
  }

  substep(dt, s = 0) {
    const g = this.gravity * dt;
    const awake = this.bodies.filter(b => !b.asleep);
    for (const b of awake) {
      const { x, prev, v, n } = b;
      const air = Math.exp(-((this.grab && this.grab.body === b) ? 2.0 : 0.06) * dt);
      for (let i = 0; i < 3 * n; i += 3) {
        v[i + 1] += g;
        v[i] *= air; v[i + 1] *= air; v[i + 2] *= air;
        prev[i] = x[i]; prev[i + 1] = x[i + 1]; prev[i + 2] = x[i + 2];
        x[i] += v[i] * dt; x[i + 1] += v[i + 1] * dt; x[i + 2] += v[i + 2] * dt;
      }
    }
    if (this.grab && !this.grab.body.asleep) this.solveGrab(dt);
    for (const b of awake) { this.solveCells(b); this.solveVolumes(b, dt); }
    if (this.bodies.length > 1) this.collide();
    if (this.blade && this.blade.mode) this.solveBlade();
    for (const b of awake) this.solveFloor(b);
    const inv = 1 / dt, vmax = this.maxSpeed;
    for (const b of awake) {
      const { x, prev, v } = b;
      for (let i = 0; i < x.length; i += 3) {
        let vx = (x[i] - prev[i]) * inv, vy = (x[i + 1] - prev[i + 1]) * inv, vz = (x[i + 2] - prev[i + 2]) * inv;
        const sp = Math.hypot(vx, vy, vz);
        if (sp > vmax) { const f = vmax / sp; vx *= f; vy *= f; vz *= f; }
        v[i] = vx; v[i + 1] = vy; v[i + 2] = vz;
      }
      // contacts push overlapping jelly apart without throwing it: separating speed is capped,
      // and sliding along the other face is slowed
      const C = b.contacts;
      for (let c = 0; c < C.length; c += 4) {
        const k = C[c], nx = C[c + 1], ny = C[c + 2], nz = C[c + 3];
        const vn = v[k] * nx + v[k + 1] * ny + v[k + 2] * nz;
        const cut = vn > 0.08 ? vn - 0.08 : 0;
        let tx = v[k] - vn * nx, ty = v[k + 1] - vn * ny, tz = v[k + 2] - vn * nz;
        v[k] -= cut * nx + tx * 0.3; v[k + 1] -= cut * ny + ty * 0.3; v[k + 2] -= cut * nz + tz * 0.3;
      }
      C.length = 0;
    }
  }

  solveGrab(dt) {
    const g = this.grab, b = g.body, x = b.x;
    const a = 3e-6 / (dt * dt), R = g.rot, T = g.target;
    for (let k = 0; k < g.idx.length; k++) {
      const i = g.idx[k], w = b.invMass[i];
      const ox = g.off[3 * k], oy = g.off[3 * k + 1], oz = g.off[3 * k + 2];
      const tx = T[0] + R[0] * ox + R[1] * oy + R[2] * oz;
      const ty = Math.max(T[1] + R[3] * ox + R[4] * oy + R[5] * oz, 0.005);
      const tz = T[2] + R[6] * ox + R[7] * oy + R[8] * oz;
      let f = g.w[k] * w / (w + a);
      if (ty < x[3 * i + 1] && ty < 0.5) f *= Math.max(0.12, ty / 0.5);
      x[3 * i] += (tx - x[3 * i]) * f; x[3 * i + 1] += (ty - x[3 * i + 1]) * f; x[3 * i + 2] += (tz - x[3 * i + 2]) * f;
    }
  }

  // 8-node shape matching per cell: best-fit rotation (warm started), goal = c + R q,
  // stiffening with strain; the same fraction for all corners keeps momentum intact
  solveCells(b) {
    const { x, mass } = b, L = b.L, nodes = L.cellNodes, Qs = L.cellQ, Q = b.cellRot, firm = L.cellFirm;
    const kBase = this.shapeK();
    const ms = this._ms || (this._ms = new Float64Array(8)), id = this._id || (this._id = new Int32Array(8));
    for (let c = 0; c < L.nC; c++) {
      let M = 0, cx = 0, cy = 0, cz = 0;
      for (let q = 0; q < 8; q++) {
        const v = nodes[8 * c + q], m = mass[v]; id[q] = 3 * v; ms[q] = m; M += m;
        cx += x[3 * v] * m; cy += x[3 * v + 1] * m; cz += x[3 * v + 2] * m;
      }
      cx /= M; cy /= M; cz /= M;
      const T = 24 * c;
      let f00 = 0, f01 = 0, f02 = 0, f10 = 0, f11 = 0, f12 = 0, f20 = 0, f21 = 0, f22 = 0, qq = 0;
      for (let q = 0; q < 8; q++) {
        const o = id[q], m = ms[q];
        const ax = (x[o] - cx) * m, ay = (x[o + 1] - cy) * m, az = (x[o + 2] - cz) * m;
        const q0 = Qs[T + 3 * q], q1 = Qs[T + 3 * q + 1], q2 = Qs[T + 3 * q + 2];
        f00 += ax * q0; f01 += ax * q1; f02 += ax * q2; f10 += ay * q0; f11 += ay * q1; f12 += ay * q2; f20 += az * q0; f21 += az * q1; f22 += az * q2;
        qq += m * (q0 * q0 + q1 * q1 + q2 * q2);
      }
      let qx = Q[4 * c], qy = Q[4 * c + 1], qz = Q[4 * c + 2], qw = Q[4 * c + 3];
      let r00, r01, r02, r10, r11, r12, r20, r21, r22;
      for (let it = 0; it < 2; it++) {
        r00 = 1 - 2 * (qy * qy + qz * qz); r01 = 2 * (qx * qy - qw * qz); r02 = 2 * (qx * qz + qw * qy);
        r10 = 2 * (qx * qy + qw * qz); r11 = 1 - 2 * (qx * qx + qz * qz); r12 = 2 * (qy * qz - qw * qx);
        r20 = 2 * (qx * qz - qw * qy); r21 = 2 * (qy * qz + qw * qx); r22 = 1 - 2 * (qx * qx + qy * qy);
        const ox = (r10 * f20 - r20 * f10) + (r11 * f21 - r21 * f11) + (r12 * f22 - r22 * f12);
        const oy = (r20 * f00 - r00 * f20) + (r21 * f01 - r01 * f21) + (r22 * f02 - r02 * f22);
        const oz = (r00 * f10 - r10 * f00) + (r01 * f11 - r11 * f01) + (r02 * f12 - r12 * f02);
        const den = Math.abs(r00 * f00 + r10 * f10 + r20 * f20 + r01 * f01 + r11 * f11 + r21 * f21 + r02 * f02 + r12 * f12 + r22 * f22) + 1e-12;
        const wx = ox / den, wy = oy / den, wz = oz / den;
        const w = Math.sqrt(wx * wx + wy * wy + wz * wz);
        if (w < 1e-6) break;
        const sc = w > 1 ? 0.5 / w : 0.5;
        const ax = wx * sc, ay = wy * sc, az = wz * sc;
        const nx = qx + ax * qw + ay * qz - az * qy, ny = qy - ax * qz + ay * qw + az * qx;
        const nz = qz + ax * qy - ay * qx + az * qw, nw = qw - ax * qx - ay * qy - az * qz;
        const nl = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
        qx = nx * nl; qy = ny * nl; qz = nz * nl; qw = nw * nl;
      }
      r00 = 1 - 2 * (qy * qy + qz * qz); r01 = 2 * (qx * qy - qw * qz); r02 = 2 * (qx * qz + qw * qy);
      r10 = 2 * (qx * qy + qw * qz); r11 = 1 - 2 * (qx * qx + qz * qz); r12 = 2 * (qy * qz - qw * qx);
      r20 = 2 * (qx * qz - qw * qy); r21 = 2 * (qy * qz + qw * qx); r22 = 1 - 2 * (qx * qx + qy * qy);
      Q[4 * c] = qx; Q[4 * c + 1] = qy; Q[4 * c + 2] = qz; Q[4 * c + 3] = qw;
      // strain: mass-weighted squared distance from the rotated rest shape, relative to the cell's size
      let err = 0;
      for (let q = 0; q < 8; q++) {
        const o = id[q];
        const q0 = Qs[T + 3 * q], q1 = Qs[T + 3 * q + 1], q2 = Qs[T + 3 * q + 2];
        const gx = cx + r00 * q0 + r01 * q1 + r02 * q2 - x[o], gy = cy + r10 * q0 + r11 * q1 + r12 * q2 - x[o + 1], gz = cz + r20 * q0 + r21 * q1 + r22 * q2 - x[o + 2];
        err += ms[q] * (gx * gx + gy * gy + gz * gz);
      }
      const strain = err / (qq + 1e-12);
      const f = Math.min(0.9, kBase * firm[c] * (1 + 10 * strain));
      for (let q = 0; q < 8; q++) {
        const o = id[q];
        const q0 = Qs[T + 3 * q], q1 = Qs[T + 3 * q + 1], q2 = Qs[T + 3 * q + 2];
        x[o] += (cx + r00 * q0 + r01 * q1 + r02 * q2 - x[o]) * f;
        x[o + 1] += (cy + r10 * q0 + r11 * q1 + r12 * q2 - x[o + 1]) * f;
        x[o + 2] += (cz + r20 * q0 + r21 * q1 + r22 * q2 - x[o + 2]) * f;
      }
    }
  }

  solveVolumes(b, dt) {
    const { x, invMass } = b, L = b.L, tets = L.tets, restVol = L.restVol;
    const alpha0 = this.volCompliance() / (dt * dt);
    for (let t = 0; t < L.nT; t++) {
      const r0 = restVol[t];
      if (r0 <= 0) continue;
      const a = tets[4 * t], bb = tets[4 * t + 1], c = tets[4 * t + 2], d = tets[4 * t + 3];
      const A = 3 * a, B = 3 * bb, Cc = 3 * c, D = 3 * d;
      const bax = x[B] - x[A], bay = x[B + 1] - x[A + 1], baz = x[B + 2] - x[A + 2];
      const cax = x[Cc] - x[A], cay = x[Cc + 1] - x[A + 1], caz = x[Cc + 2] - x[A + 2];
      const dax = x[D] - x[A], day = x[D + 1] - x[A + 1], daz = x[D + 2] - x[A + 2];
      const dbx = x[D] - x[B], dby = x[D + 1] - x[B + 1], dbz = x[D + 2] - x[B + 2];
      const cbx = x[Cc] - x[B], cby = x[Cc + 1] - x[B + 1], cbz = x[Cc + 2] - x[B + 2];
      const gax = dby * cbz - dbz * cby, gay = dbz * cbx - dbx * cbz, gaz = dbx * cby - dby * cbx;
      const gbx = cay * daz - caz * day, gby = caz * dax - cax * daz, gbz = cax * day - cay * dax;
      const gcx = day * baz - daz * bay, gcy = daz * bax - dax * baz, gcz = dax * bay - day * bax;
      const gdx = bay * caz - baz * cay, gdy = baz * cax - bax * caz, gdz = bax * cay - bay * cax;
      const V = (dax * gdx + day * gdy + daz * gdz) / 6;
      const wa = invMass[a], wb = invMass[bb], wc = invMass[c], wd = invMass[d];
      const wsum = wa * (gax * gax + gay * gay + gaz * gaz) + wb * (gbx * gbx + gby * gby + gbz * gbz)
                 + wc * (gcx * gcx + gcy * gcy + gcz * gcz) + wd * (gdx * gdx + gdy * gdy + gdz * gdz);
      if (wsum < 1e-14) continue;
      const alpha = V < 0.25 * r0 ? 0 : alpha0;
      const s = -6 * (V - r0) / (wsum + alpha);
      x[A] += gax * s * wa; x[A + 1] += gay * s * wa; x[A + 2] += gaz * s * wa;
      x[B] += gbx * s * wb; x[B + 1] += gby * s * wb; x[B + 2] += gbz * s * wb;
      x[Cc] += gcx * s * wc; x[Cc + 1] += gcy * s * wc; x[Cc + 2] += gcz * s * wc;
      x[D] += gdx * s * wd; x[D + 1] += gdy * s * wd; x[D + 2] += gdz * s * wd;
    }
  }

  solveFloor(b) {
    const { x, prev, n } = b, mu = this.friction;
    let contacts = 0;
    for (let i = 0; i < n; i++) {
      const k = 3 * i, pen = -x[k + 1];
      if (pen <= 0) continue;
      contacts++;
      x[k + 1] = 0;
      const dx = x[k] - prev[k], dz = x[k + 2] - prev[k + 2], dl = Math.hypot(dx, dz);
      if (dl < 1e-12) continue;
      const f = dl < mu * pen ? 1 : mu * pen / dl;
      x[k] -= dx * f; x[k + 2] -= dz * f;
    }
    if (contacts) b.onFloor++;
  }

  // Piece-to-piece contact. Each surface particle of one piece is carried into the other
  // piece's rest frame through its best-fit rigid frame and tested against that piece's
  // exact SDF; overlapping particles are pushed back out along the SDF gradient.
  collide() {
    const bodies = this.bodies, m = 0.014;
    for (const b of bodies) if (!b.asleep) { b.updateFrame(2); b.updateBox(); }
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
      const A = bodies[i], B = bodies[j];
      if (A.asleep && B.asleep) continue;
      const a = A.box, bb = B.box;
      if (a[0] > bb[3] + m || bb[0] > a[3] + m || a[1] > bb[4] + m || bb[1] > a[4] + m || a[2] > bb[5] + m || bb[2] > a[5] + m) continue;
      if (!A.asleep) this.pushOut(A, B, m);
      if (!B.asleep) this.pushOut(B, A, m);
    }
  }
  pushOut(P, Q, m) {
    const x = P.x, S = P.L.surface, R = Q.R, cw = Q.cw, cr = Q.cr, box = Q.box, pl = Q.planesF;
    const share = Q.asleep ? 1 : 0.5;
    for (let s = 0; s < S.length; s++) {
      const k = 3 * S[s];
      const px = x[k], py = x[k + 1], pz = x[k + 2];
      if (px < box[0] - m || px > box[3] + m || py < box[1] - m || py > box[4] + m || pz < box[2] - m || pz > box[5] + m) continue;
      const dx = px - cw[0], dy = py - cw[1], dz = pz - cw[2];
      const rx = R[0] * dx + R[3] * dy + R[6] * dz + cr[0];
      const ry = R[1] * dx + R[4] * dy + R[7] * dz + cr[1];
      const rz = R[2] * dx + R[5] * dy + R[8] * dz + cr[2];
      const d = pieceSDF(pl, rx, ry, rz);
      if (d >= m) continue;
      const nx = R[0] * SG[1] + R[1] * SG[2] + R[2] * SG[3];
      const ny = R[3] * SG[1] + R[4] * SG[2] + R[5] * SG[3];
      const nz = R[6] * SG[1] + R[7] * SG[2] + R[8] * SG[3];
      const push = Math.min(m - d, 0.02) * share;
      x[k] += nx * push; x[k + 1] += ny * push; x[k + 2] += nz * push;
      P.contacts.push(k, nx, ny, nz); P.touching = 1;
      if (Q.asleep) {
        const sp = Math.hypot(P.v[k], P.v[k + 1], P.v[k + 2]);
        if (sp > 0.8) Q.wake();
      }
    }
  }

  // The visible knife. Before the cut it presses a rounded groove under its edge; after the
  // cut it holds the lips down and wedges the two new faces apart as it sinks.
  solveBlade() {
    const b = this.blade;
    const px = b.p[0], py = b.p[1], pz = b.p[2], dx = b.d[0], dz = b.d[2], nx = b.n[0], nz = b.n[2];
    const press = b.mode === 'press';
    const W = press ? b.grooveW : b.halfGap, WP = b.grooveW;
    for (const body of this.bodies) {
      if (body.asleep) continue;
      const x = body.x;
      for (let i = 0; i < body.n; i++) {
        const k = 3 * i, rx = x[k] - px, rz = x[k + 2] - pz;
        const along = rx * dx + rz * dz;
        if (along < b.a0 || along > b.a1) continue;
        const h = x[k + 1] - py;
        if (h > b.top) continue;
        const z = rx * nx + rz * nz, az = Math.abs(z);
        if (!press && az < WP) {
          const hmax = b.holdY + b.grooveD * (az / WP) * (az / WP);
          if (x[k + 1] > hmax) x[k + 1] = hmax;
        }
        if (az >= W) continue;
        if (press) {
          const hmax = b.grooveD * (az / W) * (az / W);
          if (h > hmax) x[k + 1] = py + hmax;
        } else if (h > -0.03) {
          let s = body.side || (z >= 0 ? 1 : -1);
          const push = Math.max(-0.004, Math.min(0.004, s * W - z));
          x[k] += nx * push; x[k + 2] += nz * push;
        }
      }
    }
  }

  dampEdges(b, dt) {
    const { x, v, invMass } = b, edges = b.L.edges;
    const k = 1 - Math.exp(-this.edgeDamp() * dt);
    for (let e = 0; e < edges.length; e += 2) {
      const i = edges[e], j = edges[e + 1], I = 3 * i, J = 3 * j;
      let nx = x[J] - x[I], ny = x[J + 1] - x[I + 1], nz = x[J + 2] - x[I + 2];
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (l < 1e-9) continue;
      nx /= l; ny /= l; nz /= l;
      const rv = (v[J] - v[I]) * nx + (v[J + 1] - v[I + 1]) * ny + (v[J + 2] - v[I + 2]) * nz;
      const wi = invMass[i], wj = invMass[j], imp = rv * k / (wi + wj);
      v[I] += nx * imp * wi; v[I + 1] += ny * imp * wi; v[I + 2] += nz * imp * wi;
      v[J] -= nx * imp * wj; v[J + 1] -= ny * imp * wj; v[J + 2] -= nz * imp * wj;
    }
  }

  // damp each particle toward the body's rigid motion (v_cm + ω × r): wobble dies, tumbling doesn't;
  // on the table, a little rolling resistance slows the rigid spin as well
  dampDeformation(b, dt) {
    const { x, v, mass, n } = b;
    let M = 0, cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0;
    for (let i = 0; i < n; i++) {
      const m = mass[i], k = 3 * i; M += m;
      cx += x[k] * m; cy += x[k + 1] * m; cz += x[k + 2] * m;
      vx += v[k] * m; vy += v[k + 1] * m; vz += v[k + 2] * m;
    }
    cx /= M; cy /= M; cz /= M; vx /= M; vy /= M; vz /= M;
    let Lx = 0, Ly = 0, Lz = 0, I00 = 0, I01 = 0, I02 = 0, I11 = 0, I12 = 0, I22 = 0;
    for (let i = 0; i < n; i++) {
      const m = mass[i], k = 3 * i;
      const rx = x[k] - cx, ry = x[k + 1] - cy, rz = x[k + 2] - cz;
      const ux = v[k] - vx, uy = v[k + 1] - vy, uz = v[k + 2] - vz;
      Lx += m * (ry * uz - rz * uy); Ly += m * (rz * ux - rx * uz); Lz += m * (rx * uy - ry * ux);
      const r2 = rx * rx + ry * ry + rz * rz;
      I00 += m * (r2 - rx * rx); I11 += m * (r2 - ry * ry); I22 += m * (r2 - rz * rz);
      I01 -= m * rx * ry; I02 -= m * rx * rz; I12 -= m * ry * rz;
    }
    const inv = inv3sym(I00, I01, I02, I11, I12, I22);
    if (!inv) return;
    let wx = inv[0] * Lx + inv[1] * Ly + inv[2] * Lz;
    let wy = inv[3] * Lx + inv[4] * Ly + inv[5] * Lz;
    let wz = inv[6] * Lx + inv[7] * Ly + inv[8] * Lz;
    const kd = 1 - Math.exp(-this.deformDamp() * dt);
    // rolling resistance: the rigid spin of a body resting on the table decays
    const roll = b.onFloor ? 1 - Math.exp(-4.5 * dt) : 0;
    for (let i = 0; i < n; i++) {
      const k = 3 * i;
      const rx = x[k] - cx, ry = x[k + 1] - cy, rz = x[k + 2] - cz;
      const gx = vx + wy * rz - wz * ry, gy = vy + wz * rx - wx * rz, gz = vz + wx * ry - wy * rx;
      v[k] += (gx - v[k]) * kd; v[k + 1] += (gy - v[k + 1]) * kd; v[k + 2] += (gz - v[k + 2]) * kd;
      if (roll) {
        v[k] -= (wy * rz - wz * ry) * roll; v[k + 1] -= (wz * rx - wx * rz) * roll; v[k + 2] -= (wx * ry - wy * rx) * roll;
      }
    }
  }

  sleepCheck() {
    for (const b of this.bodies) {
      if (b.asleep) continue;
      const held = this.grab && this.grab.body === b;
      const bladeNear = this.blade && this.blade.mode;
      let vmax = 0; const v = b.v;
      for (let i = 0; i < v.length; i += 3) vmax = Math.max(vmax, v[i] * v[i] + v[i + 1] * v[i + 1] + v[i + 2] * v[i + 2]);
      if (!held && !bladeNear && vmax < 0.0036 && (b.onFloor || b.touching)) b.calm++; else b.calm = 0;
      // nearly still: bleed off the last jitter, then sleep
      if (b.calm > 10) for (let i = 0; i < v.length; i++) v[i] *= 0.8;
      if (b.calm > 45) { b.asleep = true; v.fill(0); b.prev.set(b.x); b.updateFrame(6); b.updateBox(); }
    }
  }
  wakeAll() { for (const b of this.bodies) b.wake(); }
}

function inv3sym(a, b, c, d, e, f) { // [[a b c][b d e][c e f]]
  const A = d * f - e * e, B = c * e - b * f, C = b * e - c * d;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) return null;
  const k = 1 / det;
  return [A * k, B * k, C * k, B * k, (a * f - c * c) * k, (b * c - a * e) * k, C * k, (b * c - a * e) * k, (a * d - b * b) * k];
}
