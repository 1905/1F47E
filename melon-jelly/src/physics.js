// ─────────────────────────────────────────────────────────────
//  XPBD tetrahedral soft body
//  · co-rotational tet constraints → elasticity (each tet pulled toward its
//                                    best-fit rotated rest shape; recovers inversions)
//  · tet volume constraints        → near-incompressibility
//  · soft grab attachment, ground contact with friction
//  · relative-velocity damping along edges (internal viscosity)
//  Fixed step, fixed substeps, "small steps" XPBD (1 iteration / substep).
// ─────────────────────────────────────────────────────────────

export class SoftBody {
  constructor(mesh, opts = {}) {
    const { rest, tets, region } = mesh;
    this.comp = mesh.comp || new Uint16Array(rest.length / 3);
    this.subIndex = 0;
    this.nComp = mesh.nComp || 1;
    this.n = rest.length / 3;
    this.nT = tets.length / 4;
    this.tets = tets;
    this.rest = Float32Array.from(rest);
    this.x = new Float32Array(rest.length);
    this.prev = new Float32Array(rest.length);
    this.v = new Float32Array(rest.length);
    this.invMass = new Float32Array(this.n);
    this.mass = new Float32Array(this.n);
    this.restVol = new Float32Array(this.nT);
    this.region = region;
    this.density = 1.0;

    // masses from rest volumes
    let vol = 0;
    for (let t = 0; t < this.nT; t++) {
      const v = this.tetVol(this.rest, t);
      this.restVol[t] = v; vol += v;
      for (let k = 0; k < 4; k++) this.mass[tets[4 * t + k]] += v * this.density / 4;
    }
    this.totalRestVolume = vol;
    this.totalMass = 0;
    for (let i = 0; i < this.n; i++) { this.invMass[i] = 1 / this.mass[i]; this.totalMass += this.mass[i]; }

    // unique edges
    const set = new Map();
    const pairs = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
    for (let t = 0; t < this.nT; t++) for (const [a, b] of pairs) {
      let i = tets[4 * t + a], j = tets[4 * t + b];
      if (i > j) [i, j] = [j, i];
      set.set(i * 65536 + j, [i, j]);
    }
    this.nE = set.size;
    this.edges = new Uint32Array(this.nE * 2);
    this.restLen = new Float32Array(this.nE);
    let e = 0;
    for (const [i, j] of set.values()) {
      this.edges[2 * e] = i; this.edges[2 * e + 1] = j;
      this.restLen[e] = Math.hypot(rest[3 * i] - rest[3 * j], rest[3 * i + 1] - rest[3 * j + 1], rest[3 * i + 2] - rest[3 * j + 2]);
      e++;
    }
    // shuffle edge order a little (reduces Gauss–Seidel directional bias)
    for (let k = this.nE - 1; k > 0; k--) {
      const r = (k * 2654435761) % (k + 1);
      for (const arr of [this.edges]) { const a0 = arr[2 * k], a1 = arr[2 * k + 1]; arr[2 * k] = arr[2 * r]; arr[2 * k + 1] = arr[2 * r + 1]; arr[2 * r] = a0; arr[2 * r + 1] = a1; }
      const tmp = this.restLen[k]; this.restLen[k] = this.restLen[r]; this.restLen[r] = tmp;
    }

    // co-rotational tet elasticity: rest shape, inverse rest matrix, warm-started rotation
    this.tetQ = new Float32Array(this.nT * 12);     // rest positions relative to tet centroid
    this.tetDmInv = new Float32Array(this.nT * 9);
    this.tetRot = new Float32Array(this.nT * 4);    // quaternion (x, y, z, w)
    this.tetFirm = new Float32Array(this.nT);
    for (let t = 0; t < this.nT; t++) {
      const id = [tets[4 * t], tets[4 * t + 1], tets[4 * t + 2], tets[4 * t + 3]];
      let cx = 0, cy = 0, cz = 0, M = 0;
      for (const v of id) { const mv = this.mass[v]; M += mv; cx += rest[3 * v] * mv; cy += rest[3 * v + 1] * mv; cz += rest[3 * v + 2] * mv; }
      cx /= M; cy /= M; cz /= M;
      for (let k = 0; k < 4; k++) {
        this.tetQ[12 * t + 3 * k] = rest[3 * id[k]] - cx;
        this.tetQ[12 * t + 3 * k + 1] = rest[3 * id[k] + 1] - cy;
        this.tetQ[12 * t + 3 * k + 2] = rest[3 * id[k] + 2] - cz;
      }
      // Dm columns: X1-X0, X2-X0, X3-X0 → store inverse row-major
      const m = [];
      for (let r = 0; r < 3; r++) for (let c = 1; c < 4; c++) m.push(rest[3 * id[c] + r] - rest[3 * id[0] + r]);
      const inv = inv3(m);
      this.tetDmInv.set(inv, 9 * t);
      this.tetRot[4 * t + 3] = 1;
      let rg = 0; for (const v of id) rg += region[v];
      this.tetFirm[t] = rg >= 6 ? 0.3 : rg >= 3 ? 0.5 : rg >= 1 ? 0.75 : 1.0;
    }

    // parameters (tuned in sim units: metres-ish, seconds)
    this.gravity = -9.81;
    this.firmness = opts.firmness ?? 0.5;   // 0..1 UI value
    this.damping = opts.damping ?? 0.45;    // 0..1 UI value
    this.substeps = 10;
    this.stepDt = 1 / 60;
    this.friction = 0.55;
    this.floorY = 0;
    this.maxSpeed = 12;

    this.blade = null;
    // grab state
    this.grabIdx = new Int32Array(this.n);
    this.grabW = new Float32Array(this.n);
    this.grabOff = new Float32Array(this.n * 3);
    this.grabN = 0;
    this.grabTarget = new Float32Array(3);
    this.grabRot = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    this.grabbing = false;

    this.time = 0;
    this.reset(0);
  }

  tetVol(p, t) {
    const T = this.tets;
    const a = T[4 * t], b = T[4 * t + 1], c = T[4 * t + 2], d = T[4 * t + 3];
    const ax = p[3 * a], ay = p[3 * a + 1], az = p[3 * a + 2];
    const b0 = p[3 * b] - ax, b1 = p[3 * b + 1] - ay, b2 = p[3 * b + 2] - az;
    const c0 = p[3 * c] - ax, c1 = p[3 * c + 1] - ay, c2 = p[3 * c + 2] - az;
    const d0 = p[3 * d] - ax, d1 = p[3 * d + 1] - ay, d2 = p[3 * d + 2] - az;
    return (b0 * (c1 * d2 - c2 * d1) - b1 * (c0 * d2 - c2 * d0) + b2 * (c0 * d1 - c1 * d0)) / 6;
  }

  reset(drop = 0.35) {
    for (let i = 0; i < this.n; i++) {
      this.x[3 * i] = this.rest[3 * i];
      this.x[3 * i + 1] = this.rest[3 * i + 1] + drop;
      this.x[3 * i + 2] = this.rest[3 * i + 2];
    }
    this.prev.set(this.x);
    this.v.fill(0);
    this.endGrab();
  }

  // stiffness mapping: firmness 0..1 → edge compliance (log scale)
  shapeCompliance() { return Math.exp(Math.log(3.0) + (Math.log(0.05) - Math.log(3.0)) * this.firmness); }
  volCompliance() { return 1e-4 * (1 - 0.7 * this.firmness); }
  // damping 0..1 → rate (1/s) of relative-velocity decay along edges
  dampRate() { return 2 + 40 * this.damping * this.damping; }

  nudge(strength = 1) {
    // small hop with a twist — every particle gets v = v_lin + ω × (x − c)
    const c = this.centroid();
    const vy = 2.2 * strength, wx = 2.4 * strength, wz = -1.5 * strength, wy = 1.2 * strength;
    for (let i = 0; i < this.n; i++) {
      const rx = this.x[3 * i] - c[0], ry = this.x[3 * i + 1] - c[1], rz = this.x[3 * i + 2] - c[2];
      this.v[3 * i] += wy * rz - wz * ry;
      this.v[3 * i + 1] += vy + wz * rx - wx * rz;
      this.v[3 * i + 2] += wx * ry - wy * rx;
    }
  }

  centroid() {
    let x = 0, y = 0, z = 0, m = 0;
    for (let i = 0; i < this.n; i++) {
      const w = this.mass[i]; m += w;
      x += this.x[3 * i] * w; y += this.x[3 * i + 1] * w; z += this.x[3 * i + 2] * w;
    }
    return [x / m, y / m, z / m];
  }

  // ── grabbing ──
  beginGrab(hit, radius = 0.4) {
    this.grabN = 0;
    let nearest = -1, nd = Infinity;
    for (let i = 0; i < this.n; i++) {
      const d = Math.hypot(this.x[3 * i] - hit[0], this.x[3 * i + 1] - hit[1], this.x[3 * i + 2] - hit[2]);
      if (d < nd) { nd = d; nearest = i; }
    }
    const cg = nearest >= 0 ? this.comp[nearest] : 0;   // only the piece that was touched
    for (let i = 0; i < this.n; i++) {
      if (this.comp[i] !== cg) continue;
      const dx = this.x[3 * i] - hit[0], dy = this.x[3 * i + 1] - hit[1], dz = this.x[3 * i + 2] - hit[2];
      const d = Math.hypot(dx, dy, dz);
      if (d < radius) {
        const f = 1 - d / radius;
        const k = this.grabN++;
        this.grabIdx[k] = i; this.grabW[k] = f * f * (3 - 2 * f);
        this.grabOff[3 * k] = dx; this.grabOff[3 * k + 1] = dy; this.grabOff[3 * k + 2] = dz;
      }
    }
    if (this.grabN === 0 && nearest >= 0) {
      this.grabIdx[0] = nearest; this.grabW[0] = 1;
      this.grabOff[0] = this.x[3 * nearest] - hit[0]; this.grabOff[1] = this.x[3 * nearest + 1] - hit[1]; this.grabOff[2] = this.x[3 * nearest + 2] - hit[2];
      this.grabN = 1;
    }
    this.grabTarget.set(hit);
    this.grabStart = Float32Array.from(hit);
    this.grabRot.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    this.grabbing = true;
  }
  moveGrab(target, rot) {
    this.grabTarget.set(target);
    // bounded reach: a strong stretch, never an unbounded one
    const dx = target[0] - this.grabStart[0], dy = target[1] - this.grabStart[1], dz = target[2] - this.grabStart[2];
    const d = Math.hypot(dx, dy, dz), maxReach = 2.2;
    if (d > maxReach) { const k = maxReach / d; this.grabTarget[0] = this.grabStart[0] + dx * k; this.grabTarget[1] = this.grabStart[1] + dy * k; this.grabTarget[2] = this.grabStart[2] + dz * k; }
    if (rot) this.grabRot.set(rot);
    // never drive the held patch into the floor: lift the whole patch instead of crushing it
    const R = this.grabRot;
    let lowest = Infinity;
    for (let k = 0; k < this.grabN; k++) lowest = Math.min(lowest, R[3] * this.grabOff[3 * k] + R[4] * this.grabOff[3 * k + 1] + R[5] * this.grabOff[3 * k + 2]);
    if (Number.isFinite(lowest)) this.grabTarget[1] = Math.max(this.grabTarget[1], this.floorY + 0.004 - lowest);
  }
  endGrab() { this.grabbing = false; this.grabN = 0; }

  // ── simulation ──
  step() {
    const sub = this.substeps;
    const dt = this.stepDt / sub;
    for (let s = 0; s < sub; s++) this.substep(dt);
    this.time += this.stepDt;
    // settling: once the jelly is nearly still, bleed off the last residual jitter
    if (!this.grabbing) {
      const ke = this.kineticEnergy() / this.totalMass; // ≈ ½ v²
      if (ke < 2e-3) {
        const f = Math.max(0.86, 1 - 0.14 * (1 - ke / 2e-3));
        for (let i = 0; i < this.v.length; i++) this.v[i] *= f;
      }
    }
    // safety: any non-finite value → reset gently
    for (let i = 0; i < this.x.length; i += 97) if (!Number.isFinite(this.x[i])) { this.reset(0.2); break; }
  }

  substep(dt) {
    const { x, prev, v, invMass, n } = this;
    const g = this.gravity * dt;
    // light air drag; while held, the hand steadies the slice a little more
    const air = Math.exp(-(this.grabbing ? 2.5 : 0.08) * dt);
    for (let i = 0; i < n; i++) {
      const k = 3 * i;
      v[k + 1] += g;
      v[k] *= air; v[k + 1] *= air; v[k + 2] *= air;
      prev[k] = x[k]; prev[k + 1] = x[k + 1]; prev[k + 2] = x[k + 2];
      x[k] += v[k] * dt; x[k + 1] += v[k + 1] * dt; x[k + 2] += v[k + 2] * dt;
    }
    if (this.grabbing) this.solveGrab(dt);
    this.solveTets(dt);
    this.solveVolumes(dt);
    if (this.nComp > 1 && (this.subIndex++ & 1) === 0) this.collidePieces();
    if (this.blade && this.blade.mode) this.solveBlade();
    this.solveFloor();
    const inv = 1 / dt, vmax = this.maxSpeed;
    for (let i = 0; i < 3 * n; i += 3) {
      let vx = (x[i] - prev[i]) * inv, vy = (x[i + 1] - prev[i + 1]) * inv, vz = (x[i + 2] - prev[i + 2]) * inv;
      const sp = Math.hypot(vx, vy, vz);
      if (sp > vmax) { const f = vmax / sp; vx *= f; vy *= f; vz *= f; }
      v[i] = vx; v[i + 1] = vy; v[i + 2] = vz;
    }
    this.dampEdges(dt);
  }

  // The visible knife. Before the cut it presses a rounded groove under its edge (the jelly
  // squashes before it gives); after the cut it wedges the two new faces apart as it sinks.
  solveBlade() {
    const b = this.blade, x = this.x, comp = this.comp, n = this.n;
    const px = b.p[0], py = b.p[1], pz = b.p[2];
    const dx = b.d[0], dz = b.d[2], nx = b.n[0], nz = b.n[2];
    const press = b.mode === 'press';
    const W = press ? 0.12 : b.halfGap, WP = 0.12;
    for (let i = 0; i < n; i++) {
      const k = 3 * i;
      const rx = x[k] - px, rz = x[k + 2] - pz;
      const along = rx * dx + rz * dz;
      if (along < b.a0 || along > b.a1) continue;
      const h = x[k + 1] - py;
      if (h > b.top) continue;
      const z = rx * nx + rz * nz, az = Math.abs(z);
      if (!press && az < WP) {
        // the cut lips stay held down at the depth of the break-through while the blade passes
        const hmax = b.holdY + 0.1 * (az / WP) * (az / WP);
        if (x[k + 1] > hmax) x[k + 1] = hmax;
      }
      if (az >= W) continue;
      if (press) {
        const hmax = 0.1 * (az / W) * (az / W);
        if (h > hmax) x[k + 1] = py + hmax;
      } else if (h > -0.03) {
        let s = b.side ? b.side[comp[i]] : 0;
        if (!s) s = z >= 0 ? 1 : -1;
        // eased: a few millimetres per substep, so the faces are wedged apart rather than kicked
        const push = Math.max(-0.003, Math.min(0.003, s * W - z));
        x[k] += nx * push; x[k + 2] += nz * push;
      }
    }
  }

  solveGrab(dt) {
    const { x, invMass } = this;
    const a = 2e-6 / (dt * dt);
    const R = this.grabRot, T = this.grabTarget;
    for (let k = 0; k < this.grabN; k++) {
      const i = this.grabIdx[k], w = invMass[i];
      const ox = this.grabOff[3 * k], oy = this.grabOff[3 * k + 1], oz = this.grabOff[3 * k + 2];
      const tx = T[0] + R[0] * ox + R[1] * oy + R[2] * oz;
      const ty = Math.max(T[1] + R[3] * ox + R[4] * oy + R[5] * oz, this.floorY + 0.005);
      const tz = T[2] + R[6] * ox + R[7] * oy + R[8] * oz;
      let f = this.grabW[k] * w / (w + a);
      // pressing down near the table: yield instead of crushing the jelly underneath
      if (ty < x[3 * i + 1] && ty < 0.45) f *= Math.max(0.12, ty / 0.45);
      x[3 * i] += (tx - x[3 * i]) * f;
      x[3 * i + 1] += (ty - x[3 * i + 1]) * f;
      x[3 * i + 2] += (tz - x[3 * i + 2]) * f;
    }
  }

  // Per-tet co-rotational shape matching: find the rotation that best maps the rest tet onto the
  // current one (Müller et al. 2016, warm-started quaternion), then pull the four corners toward the
  // rotated rest shape with XPBD compliance. Inverted tets are always pushed back to a proper shape.
  solveTets(dt) {
    const { x, tets, tetQ, tetRot: Q, tetFirm, mass } = this;
    const base = this.shapeCompliance() / (dt * dt);
    for (let t = 0; t < this.nT; t++) {
      const a = 3 * tets[4 * t], b = 3 * tets[4 * t + 1], c = 3 * tets[4 * t + 2], d = 3 * tets[4 * t + 3];
      const ma = mass[a / 3], mb = mass[b / 3], mc = mass[c / 3], md = mass[d / 3];
      const M = ma + mb + mc + md;
      const cx = (x[a] * ma + x[b] * mb + x[c] * mc + x[d] * md) / M;
      const cy = (x[a + 1] * ma + x[b + 1] * mb + x[c + 1] * mc + x[d + 1] * md) / M;
      const cz = (x[a + 2] * ma + x[b + 2] * mb + x[c + 2] * mc + x[d + 2] * md) / M;
      const T = 12 * t;
      // A = Σ m p qᵀ (mass-weighted covariance of current vs rest, both about their centroids)
      let f00 = 0, f01 = 0, f02 = 0, f10 = 0, f11 = 0, f12 = 0, f20 = 0, f21 = 0, f22 = 0;
      {
        let px = (x[a] - cx) * ma, py = (x[a + 1] - cy) * ma, pz = (x[a + 2] - cz) * ma;
        let q0 = tetQ[T], q1 = tetQ[T + 1], q2 = tetQ[T + 2];
        f00 += px * q0; f01 += px * q1; f02 += px * q2; f10 += py * q0; f11 += py * q1; f12 += py * q2; f20 += pz * q0; f21 += pz * q1; f22 += pz * q2;
        px = (x[b] - cx) * mb; py = (x[b + 1] - cy) * mb; pz = (x[b + 2] - cz) * mb; q0 = tetQ[T + 3]; q1 = tetQ[T + 4]; q2 = tetQ[T + 5];
        f00 += px * q0; f01 += px * q1; f02 += px * q2; f10 += py * q0; f11 += py * q1; f12 += py * q2; f20 += pz * q0; f21 += pz * q1; f22 += pz * q2;
        px = (x[c] - cx) * mc; py = (x[c + 1] - cy) * mc; pz = (x[c + 2] - cz) * mc; q0 = tetQ[T + 6]; q1 = tetQ[T + 7]; q2 = tetQ[T + 8];
        f00 += px * q0; f01 += px * q1; f02 += px * q2; f10 += py * q0; f11 += py * q1; f12 += py * q2; f20 += pz * q0; f21 += pz * q1; f22 += pz * q2;
        px = (x[d] - cx) * md; py = (x[d + 1] - cy) * md; pz = (x[d + 2] - cz) * md; q0 = tetQ[T + 9]; q1 = tetQ[T + 10]; q2 = tetQ[T + 11];
        f00 += px * q0; f01 += px * q1; f02 += px * q2; f10 += py * q0; f11 += py * q1; f12 += py * q2; f20 += pz * q0; f21 += pz * q1; f22 += pz * q2;
      }
      let qx = Q[4 * t], qy = Q[4 * t + 1], qz = Q[4 * t + 2], qw = Q[4 * t + 3];
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
        // small-angle quaternion step (renormalised below); large jumps are clamped
        const sc = w > 1 ? 0.5 / w : 0.5;
        const ax = wx * sc, ay = wy * sc, az = wz * sc, cs = 1;
        const nx = cs * qx + ax * qw + ay * qz - az * qy;
        const ny = cs * qy - ax * qz + ay * qw + az * qx;
        const nz = cs * qz + ax * qy - ay * qx + az * qw;
        const nw = cs * qw - ax * qx - ay * qy - az * qz;
        const nl = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
        qx = nx * nl; qy = ny * nl; qz = nz * nl; qw = nw * nl;
      }
      r00 = 1 - 2 * (qy * qy + qz * qz); r01 = 2 * (qx * qy - qw * qz); r02 = 2 * (qx * qz + qw * qy);
      r10 = 2 * (qx * qy + qw * qz); r11 = 1 - 2 * (qx * qx + qz * qz); r12 = 2 * (qy * qz - qw * qx);
      r20 = 2 * (qx * qz - qw * qy); r21 = 2 * (qy * qz + qw * qx); r22 = 1 - 2 * (qx * qx + qy * qy);
      Q[4 * t] = qx; Q[4 * t + 1] = qy; Q[4 * t + 2] = qz; Q[4 * t + 3] = qw;
      // the same fraction for all four corners keeps linear and angular momentum intact
      const f = 1 / (1 + base * tetFirm[t] * M * 0.25);
      let q0 = tetQ[T], q1 = tetQ[T + 1], q2 = tetQ[T + 2];
      x[a] += (cx + r00 * q0 + r01 * q1 + r02 * q2 - x[a]) * f; x[a + 1] += (cy + r10 * q0 + r11 * q1 + r12 * q2 - x[a + 1]) * f; x[a + 2] += (cz + r20 * q0 + r21 * q1 + r22 * q2 - x[a + 2]) * f;
      q0 = tetQ[T + 3]; q1 = tetQ[T + 4]; q2 = tetQ[T + 5];
      x[b] += (cx + r00 * q0 + r01 * q1 + r02 * q2 - x[b]) * f; x[b + 1] += (cy + r10 * q0 + r11 * q1 + r12 * q2 - x[b + 1]) * f; x[b + 2] += (cz + r20 * q0 + r21 * q1 + r22 * q2 - x[b + 2]) * f;
      q0 = tetQ[T + 6]; q1 = tetQ[T + 7]; q2 = tetQ[T + 8];
      x[c] += (cx + r00 * q0 + r01 * q1 + r02 * q2 - x[c]) * f; x[c + 1] += (cy + r10 * q0 + r11 * q1 + r12 * q2 - x[c + 1]) * f; x[c + 2] += (cz + r20 * q0 + r21 * q1 + r22 * q2 - x[c + 2]) * f;
      q0 = tetQ[T + 9]; q1 = tetQ[T + 10]; q2 = tetQ[T + 11];
      x[d] += (cx + r00 * q0 + r01 * q1 + r02 * q2 - x[d]) * f; x[d + 1] += (cy + r10 * q0 + r11 * q1 + r12 * q2 - x[d + 1]) * f; x[d + 2] += (cz + r20 * q0 + r21 * q1 + r22 * q2 - x[d + 2]) * f;
    }
  }

  solveVolumes(dt) {
    const { x, invMass, tets, restVol } = this;
    const alpha0 = this.volCompliance() / (dt * dt);
    for (let t = 0; t < this.nT; t++) {
      const a = tets[4 * t], b = tets[4 * t + 1], c = tets[4 * t + 2], d = tets[4 * t + 3];
      const A = 3 * a, B = 3 * b, Cc = 3 * c, D = 3 * d;
      // gradients (Müller): g_a = (d-b)×(c-b), g_b = (c-a)×(d-a), g_c = (d-a)×(b-a), g_d = (b-a)×(c-a)
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
      const wa = invMass[a], wb = invMass[b], wc = invMass[c], wd = invMass[d];
      const wsum = wa * (gax * gax + gay * gay + gaz * gaz) + wb * (gbx * gbx + gby * gby + gbz * gbz)
                 + wc * (gcx * gcx + gcy * gcy + gcz * gcz) + wd * (gdx * gdx + gdy * gdy + gdz * gdz);
      if (wsum < 1e-12) continue;
      const r0 = restVol[t];
      // anti-inversion: elements far below rest volume get a rigid (compliance-free) correction
      const alpha = V < 0.25 * r0 ? 0 : alpha0;
      const C = 6 * (V - r0);
      let s = -C / (wsum + alpha);
      x[A] += gax * s * wa; x[A + 1] += gay * s * wa; x[A + 2] += gaz * s * wa;
      x[B] += gbx * s * wb; x[B + 1] += gby * s * wb; x[B + 2] += gbz * s * wb;
      x[Cc] += gcx * s * wc; x[Cc + 1] += gcy * s * wc; x[Cc + 2] += gcz * s * wc;
      x[D] += gdx * s * wd; x[D + 1] += gdy * s * wd; x[D + 2] += gdz * s * wd;
    }
  }

  // pieces push each other apart: particle spheres of different pieces may not overlap.
  // Only pairs of pieces whose bounding boxes touch are examined, and only the particles
  // inside the shared region — so pieces lying apart cost almost nothing.
  collidePieces() {
    const { x, invMass, comp, n, nComp } = this;
    const D = 0.13;
    if (!this.cBox || this.cBox.length !== nComp * 6) { this.cBox = new Float32Array(nComp * 6); this.cListA = new Int32Array(n); this.cListB = new Int32Array(n); }
    const box = this.cBox;
    for (let c = 0; c < nComp; c++) { box[6 * c] = box[6 * c + 1] = box[6 * c + 2] = Infinity; box[6 * c + 3] = box[6 * c + 4] = box[6 * c + 5] = -Infinity; }
    for (let p = 0; p < n; p++) {
      const o = 6 * comp[p];
      for (let k = 0; k < 3; k++) { const v = x[3 * p + k]; if (v < box[o + k]) box[o + k] = v; if (v > box[o + 3 + k]) box[o + 3 + k] = v; }
    }
    const LA = this.cListA, LB = this.cListB;
    for (let A = 0; A < nComp; A++) for (let B = A + 1; B < nComp; B++) {
      const lo = [0, 0, 0], hi = [0, 0, 0];
      let overlap = true;
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.max(box[6 * A + k], box[6 * B + k]) - D; hi[k] = Math.min(box[6 * A + 3 + k], box[6 * B + 3 + k]) + D;
        if (lo[k] > hi[k]) { overlap = false; break; }
      }
      if (!overlap) continue;
      let na = 0, nb = 0;
      for (let p = 0; p < n; p++) {
        const c = comp[p];
        if (c !== A && c !== B) continue;
        const px = x[3 * p], py = x[3 * p + 1], pz = x[3 * p + 2];
        if (px < lo[0] || px > hi[0] || py < lo[1] || py > hi[1] || pz < lo[2] || pz > hi[2]) continue;
        if (c === A) LA[na++] = p; else LB[nb++] = p;
      }
      for (let i = 0; i < na; i++) {
        const p = LA[i];
        for (let j = 0; j < nb; j++) {
          const q = LB[j];
          const dx = x[3 * q] - x[3 * p], dy = x[3 * q + 1] - x[3 * p + 1], dz = x[3 * q + 2] - x[3 * p + 2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= D * D || d2 < 1e-12) continue;
          const d = Math.sqrt(d2), wp = invMass[p], wq = invMass[q];
          // gentle: a few millimetres per pass, so freshly cut faces ease apart instead of popping
          const push = Math.min(D - d, 0.006) / (d * (wp + wq));
          x[3 * p] -= dx * push * wp; x[3 * p + 1] -= dy * push * wp; x[3 * p + 2] -= dz * push * wp;
          x[3 * q] += dx * push * wq; x[3 * q + 1] += dy * push * wq; x[3 * q + 2] += dz * push * wq;
        }
      }
    }
  }

  // best-fit rigid frame (rest → world) of one piece: centroids and a rotation matrix (row-major)
  pieceFrame(c) {
    const { x, rest, mass, comp, n } = this;
    let M = 0; const cw = [0, 0, 0], cr = [0, 0, 0];
    for (let i = 0; i < n; i++) if (comp[i] === c) { const m = mass[i]; M += m; for (let k = 0; k < 3; k++) { cw[k] += x[3 * i + k] * m; cr[k] += rest[3 * i + k] * m; } }
    for (let k = 0; k < 3; k++) { cw[k] /= M; cr[k] /= M; }
    const A = new Float64Array(9);
    for (let i = 0; i < n; i++) if (comp[i] === c) {
      const m = mass[i];
      for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) A[3 * r + k] += m * (x[3 * i + r] - cw[r]) * (rest[3 * i + k] - cr[k]);
    }
    // Müller et al. rotation extraction, iterated from identity
    let qx = 0, qy = 0, qz = 0, qw = 1;
    const R = new Float64Array(9);
    for (let it = 0; it < 40; it++) {
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
      const h = Math.min(w, 2) / 2, sn = Math.sin(h) / w, cs = Math.cos(h);
      const ax = wx * sn, ay = wy * sn, az = wz * sn;
      const nx = cs * qx + ax * qw + ay * qz - az * qy, ny = cs * qy - ax * qz + ay * qw + az * qx;
      const nz = cs * qz + ax * qy - ay * qx + az * qw, nw = cs * qw - ax * qx - ay * qy - az * qz;
      const l = Math.hypot(nx, ny, nz, nw); qx = nx / l; qy = ny / l; qz = nz / l; qw = nw / l;
    }
    return { cw, cr, R };
  }

  solveFloor() {
    const { x, prev, n } = this;
    const fy = this.floorY, mu = this.friction;
    for (let i = 0; i < n; i++) {
      const k = 3 * i;
      const pen = fy - x[k + 1];
      if (pen <= 0) continue;
      x[k + 1] = fy;
      // Coulomb-style positional friction
      const dx = x[k] - prev[k], dz = x[k + 2] - prev[k + 2];
      const dl = Math.hypot(dx, dz);
      if (dl < 1e-12) continue;
      // static friction for micro-slip, kinetic friction otherwise (never locks in large strain)
      const f = dl < mu * pen ? 1 : mu * pen / dl;
      x[k] -= dx * f; x[k + 2] -= dz * f;
    }
  }

  dampEdges(dt) {
    const { x, v, invMass, edges } = this;
    const k = 1 - Math.exp(-this.dampRate() * dt);
    for (let e = 0; e < this.nE; e++) {
      const i = edges[2 * e], j = edges[2 * e + 1];
      const I = 3 * i, J = 3 * j;
      let nx = x[J] - x[I], ny = x[J + 1] - x[I + 1], nz = x[J + 2] - x[I + 2];
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (l < 1e-9) continue;
      nx /= l; ny /= l; nz /= l;
      const rv = (v[J] - v[I]) * nx + (v[J + 1] - v[I + 1]) * ny + (v[J + 2] - v[I + 2]) * nz;
      const wi = invMass[i], wj = invMass[j], ws = wi + wj;
      const imp = rv * k / ws;
      v[I] += nx * imp * wi; v[I + 1] += ny * imp * wi; v[I + 2] += nz * imp * wi;
      v[J] -= nx * imp * wj; v[J + 1] -= ny * imp * wj; v[J + 2] -= nz * imp * wj;
    }
  }

  // ── diagnostics ──
  volumeRatio() {
    let s = 0;
    for (let t = 0; t < this.nT; t++) s += this.tetVol(this.x, t);
    return s / this.totalRestVolume;
  }
  minVolumeRatio() {
    let m = Infinity;
    for (let t = 0; t < this.nT; t++) m = Math.min(m, this.tetVol(this.x, t) / this.restVol[t]);
    return m;
  }
  kineticEnergy() {
    let e = 0;
    for (let i = 0; i < this.n; i++) {
      const k = 3 * i;
      e += 0.5 * this.mass[i] * (this.v[k] ** 2 + this.v[k + 1] ** 2 + this.v[k + 2] ** 2);
    }
    return e;
  }
  // mean deviation from rest shape after best rigid alignment is expensive; use edge strain instead
  meanStrain() {
    let s = 0;
    const { x, edges, restLen } = this;
    for (let e = 0; e < this.nE; e++) {
      const i = 3 * edges[2 * e], j = 3 * edges[2 * e + 1];
      s += Math.abs(Math.hypot(x[i] - x[j], x[i + 1] - x[j + 1], x[i + 2] - x[j + 2]) / restLen[e] - 1);
    }
    return s / this.nE;
  }
  minY() { let m = Infinity; for (let i = 1; i < this.x.length; i += 3) m = Math.min(m, this.x[i]); return m; }
}

export function inv3(m) { // row-major 3x3
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C, k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}
