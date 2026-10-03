// ===== shaders.js =====
// ─────────────────────────────────────────────────────────────
//  WGSL
// ─────────────────────────────────────────────────────────────

const WGSL_COMMON = /* wgsl */`
struct U {
  viewProj: mat4x4f,
  view: mat4x4f,
  invViewProj: mat4x4f,
  lightVP: mat4x4f,
  topVP: mat4x4f,
  camPos: vec4f,     // xyz
  camFwd: vec4f,
  keyDir: vec4f,     // xyz toward light, w = intensity
  screen: vec4f,     // w, h, 1/w, 1/h
  flesh: vec4f,      // transmission tint of the flesh
  fleshDeep: vec4f,  // scattering albedo of the flesh
  pale: vec4f,
  skin: vec4f,
  stripe: vec4f,
  seed: vec4f,
  melon: vec4f,      // A, B, C, centre height
  bands: vec4f,      // skin depth, pith depth, belly flattening, belly softness
  misc: vec4f,       // exposure, meshAlpha, time, unused
  bg: vec4f,
  shadowTint: vec4f,
  spot: vec4f,       // field spot colour
};

const PI = 3.14159265;

fn hash3(p: vec3f) -> f32 {
  var q = fract(p * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
fn vnoise(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  let a = mix(mix(hash3(i + vec3f(0,0,0)), hash3(i + vec3f(1,0,0)), w.x), mix(hash3(i + vec3f(0,1,0)), hash3(i + vec3f(1,1,0)), w.x), w.y);
  let b = mix(mix(hash3(i + vec3f(0,0,1)), hash3(i + vec3f(1,0,1)), w.x), mix(hash3(i + vec3f(0,1,1)), hash3(i + vec3f(1,1,1)), w.x), w.y);
  return mix(a, b, w.z);
}
fn fbm(p: vec3f) -> f32 {
  return 0.55 * vnoise(p) + 0.3 * vnoise(p * 2.13 + 7.1) + 0.15 * vnoise(p * 4.37 + 3.3);
}
fn smax(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return max(a, b) + h * h * k * 0.25;
}
// the melon's signed distance in its rest frame (same formula as the CPU side)
fn sdMelon(p: vec3f) -> f32 {
  let q = vec3f(p.x, p.y - u.melon.w, p.z);
  let r = u.melon.xyz;
  let k0 = length(q / r);
  let k1 = max(length(q / (r * r)), 1e-6);
  let e = k0 * (k0 - 1.0) / k1;
  let b = -(q.y + r.y - u.bands.z);
  return smax(e, b, u.bands.w);
}

// rounded rectangle softbox seen along direction d
fn softbox(d: vec3f, c: vec3f, up: vec3f, size: vec2f, blur: f32) -> f32 {
  let cd = dot(d, c);
  if (cd <= 0.0) { return 0.0; }
  let t1 = normalize(cross(up, c));
  let t2 = cross(c, t1);
  let uv = vec2f(dot(d, t1), dot(d, t2)) / cd;
  let q = abs(uv) - size;
  let sd = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - 0.04;
  return 1.0 - smoothstep(-blur, blur, sd);
}

// procedural photo studio: pale paper sweep, overhead softbox, back-left strip light, cool fill card
fn studioEnv(d: vec3f, rough: f32, bg: vec3f) -> vec3f {
  let b = 0.012 + rough * 0.55;
  let y = d.y;
  var col = mix(bg * 0.62, bg * 1.05, smoothstep(-0.35, 0.25, y));
  col += bg * 0.55 * (1.0 - smoothstep(0.0, 0.3, abs(y + 0.08)));
  col = mix(col, bg * 0.8, smoothstep(0.3, 1.0, y));
  col += vec3f(1.0, 0.985, 0.96) * 3.2 * softbox(d, normalize(vec3f(0.05, 1.0, -0.15)), vec3f(0.0, 0.0, 1.0), vec2f(0.55, 0.32), b);
  col += vec3f(1.0, 0.98, 0.95) * 3.0 * softbox(d, normalize(vec3f(-0.42, 0.34, -0.8)), vec3f(0.0, 1.0, 0.0), vec2f(0.7, 0.06), b);
  col += vec3f(1.0, 0.97, 0.93) * 4.0 * softbox(d, normalize(vec3f(-0.8, 0.38, -0.2)), vec3f(0.0, 1.0, 0.0), vec2f(0.08, 0.55), b);
  col += vec3f(0.92, 0.96, 1.0) * 1.2 * softbox(d, normalize(vec3f(0.85, 0.3, 0.55)), vec3f(0.0, 1.0, 0.0), vec2f(0.45, 0.5), b * 1.3);
  return col;
}

fn ggx(N: vec3f, V: vec3f, L: vec3f, rough: f32) -> f32 {
  let H = normalize(V + L);
  let a = max(rough * rough, 0.002);
  let a2 = a * a;
  let NdH = max(dot(N, H), 0.0);
  let NdL = max(dot(N, L), 0.0);
  let NdV = max(dot(N, V), 1e-3);
  let dd = NdH * NdH * (a2 - 1.0) + 1.0;
  let D = a2 / (PI * dd * dd);
  let k = a * 0.5;
  let G = (NdL / (NdL * (1.0 - k) + k)) * (NdV / (NdV * (1.0 - k) + k));
  return D * G / max(4.0 * NdL * NdV, 1e-3) * NdL;
}

fn linearDepth(p: vec3f) -> f32 { return dot(p - u.camPos.xyz, u.camFwd.xyz); }

// ── the rind: skin colour, stripes, field spot, stem scar and blossom end ──
struct Rind { col: vec3f, rough: f32, stripe: f32 };
fn rindAt(Q: vec3f, depth: f32) -> Rind {
  var o: Rind;
  let q = vec3f(Q.x, Q.y - u.melon.w, Q.z);
  let r = u.melon.xyz;
  let cs = normalize(q.yz / r.yz + vec2f(1e-5, 0.0));      // angle around the long axis, as a point on a circle
  let th = atan2(cs.y, cs.x);
  let ax = q.x / r.x;                                       // -1 blossom end … +1 stem end
  // irregular dark stripes running pole to pole, seamless all the way round
  let warp = fbm(vec3f(cs * 1.3, ax * 1.1 + 4.0)) * 6.5 + fbm(vec3f(cs * 4.2, ax * 3.4 + 9.0)) * 1.7;
  let sf = sin(th * 11.0 + warp);
  let jag = fbm(vec3f(cs * 14.0, ax * 9.0 + 2.0)) - 0.5;
  var stripe = smoothstep(-0.05, 0.35, sf + jag * 0.9);
  // stripes blur together toward the poles
  stripe = mix(stripe, 0.55, smoothstep(0.82, 0.98, abs(ax)));
  let speck = smoothstep(0.66, 0.82, vnoise(vec3f(cs * 70.0, ax * 60.0)));
  var col = mix(u.skin.rgb, u.stripe.rgb, clamp(stripe, 0.0, 1.0));
  col = mix(col, u.skin.rgb * 1.7 + vec3f(0.02, 0.03, 0.0), speck * 0.35 * (1.0 - stripe));
  // field spot: where the melon lay on the ground, a pale yellow patch on the belly
  let belly = smoothstep(-0.55, -0.82, q.y / r.y);
  let sp = length(vec2f((ax - 0.08) / 0.62, q.z / r.z / 0.5)) + (fbm(vec3f(cs * 3.0, ax * 3.0)) - 0.5) * 0.45;
  let spot = belly * (1.0 - smoothstep(0.55, 0.9, sp));
  col = mix(col, u.spot.rgb * (0.85 + 0.3 * vnoise(vec3f(cs * 30.0, ax * 25.0))), spot * 0.92);
  stripe *= 1.0 - spot;
  // stem scar (+x) and blossom end (−x): small corky discs at the poles
  let rp = length(q.yz);
  let stem = (1.0 - smoothstep(0.055, 0.075, rp)) * step(0.0, q.x);
  let stemRing = smoothstep(0.035, 0.05, rp) * (1.0 - smoothstep(0.07, 0.09, rp)) * step(0.0, q.x);
  let cork = vec3f(0.16, 0.12, 0.06) * (0.7 + 0.6 * vnoise(Q * 160.0));
  col = mix(col, cork, stem);
  col = mix(col, col * 0.55, stemRing * 0.7);
  let bl = (1.0 - smoothstep(0.03, 0.042, rp)) * step(q.x, 0.0);
  let blRing = smoothstep(0.04, 0.05, rp) * (1.0 - smoothstep(0.06, 0.085, rp)) * step(q.x, 0.0);
  col = mix(col, vec3f(0.3, 0.26, 0.14) * (0.8 + 0.4 * vnoise(Q * 200.0)), bl);
  col = mix(col, col * 0.6, blRing * 0.6);
  o.col = col;
  o.rough = mix(0.15 + stripe * 0.04, 0.42, max(stem, bl));
  o.stripe = stripe;
  return o;
}
`;

const WGSL_DEPTH = /* wgsl */`
@group(0) @binding(0) var<uniform> m: mat4x4f;
@vertex fn vs(@location(0) p: vec3f) -> @builtin(position) vec4f { return m * vec4f(p, 1.0); }
`;

// ── key-light shadow map, coloured by what the light crosses first ──
const WGSL_SHADOW = WGSL_COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u: U;
struct VIn { @location(0) p: vec3f, @location(1) n: vec3f, @location(2) rest: vec3f, @location(3) mat: f32 };
struct SOut { @builtin(position) pos: vec4f, @location(0) rest: vec3f, @location(1) mat: f32 };
@vertex fn vs(v: VIn) -> SOut {
  var o: SOut; o.pos = u.lightVP * vec4f(v.p, 1.0); o.rest = v.rest; o.mat = v.mat; return o;
}
@fragment fn fs(i: SOut) -> @location(0) vec4f {
  if (i.mat > 0.5) {
    if (i.mat > 1.5 && i.mat < 2.5) { discard; }   // bubbles are only air
    return vec4f(0.0, 0.0, 0.0, 1.0);               // seeds and steel
  }
  let depth = -sdMelon(i.rest);
  // how much light a sheet of this tissue lets through, and in which colour
  let rind = vec3f(0.02, 0.05, 0.02);
  let pith = vec3f(0.62, 0.66, 0.5);
  let flesh = mix(vec3f(1.0), u.flesh.rgb, 0.8) * 0.8;
  var t = flesh;
  t = mix(pith, t, smoothstep(u.bands.y - 0.03, u.bands.y + 0.03, depth));
  t = mix(rind, t, smoothstep(u.bands.x - 0.01, u.bands.x + 0.01, depth));
  return vec4f(t, 1.0);
}
`;

// ── scene: background / floor with soft shadows, then seeds, bubbles and the knife ──
const WGSL_SCENE = WGSL_COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var heightMap: texture_depth_2d;
@group(0) @binding(3) var cmp: sampler_comparison;
// render quality: soft-shadow taps and contact-occlusion rings (set per pipeline)
override SHADOW_TAPS: i32 = 16;
override AO_RINGS: i32 = 3;
@group(0) @binding(4) var shadowCol: texture_2d<f32>;
@group(0) @binding(5) var lin: sampler;

struct FSOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vsFull(@builtin(vertex_index) i: u32) -> FSOut {
  var o: FSOut;
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  o.pos = vec4f(p, 0.0, 1.0); o.ndc = p; return o;
}

var<private> POISSON: array<vec2f, 16> = array<vec2f, 16>(
  vec2f(-0.94201624, -0.39906216), vec2f(0.94558609, -0.76890725), vec2f(-0.094184101, -0.92938870), vec2f(0.34495938, 0.29387760),
  vec2f(-0.91588581, 0.45771432), vec2f(-0.81544232, -0.87912464), vec2f(-0.38277543, 0.27676845), vec2f(0.97484398, 0.75648379),
  vec2f(0.44323325, -0.97511554), vec2f(0.53742981, -0.47373420), vec2f(-0.26496911, -0.41893023), vec2f(0.79197514, 0.19090188),
  vec2f(-0.24188840, 0.99706507), vec2f(-0.81409955, 0.91437590), vec2f(0.19984126, 0.78641367), vec2f(0.14383161, -0.14100790));

struct Shadow { lit: f32, tint: vec3f };
fn keyShadow(P: vec3f) -> Shadow {
  var o: Shadow; o.lit = 1.0; o.tint = vec3f(1.0);
  let lp = u.lightVP * vec4f(P, 1.0);
  let uv = vec2f(lp.x * 0.5 + 0.5, 0.5 - lp.y * 0.5);
  let z = lp.z;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return o; }
  // blocker search → penumbra size (PCSS-lite)
  let dims = vec2f(textureDimensions(shadowMap));
  var blk = 0.0; var nb = 0.0;
  for (var i = 0; i < SHADOW_TAPS; i++) {
    let s = uv + POISSON[i] * 0.016;
    let d = textureLoad(shadowMap, vec2i(clamp(s, vec2f(0.0), vec2f(0.999)) * dims), 0);
    if (d < z - 0.002) { blk += d; nb += 1.0; }
  }
  if (nb < 0.5) { return o; }
  blk /= nb;
  let pen = clamp((z - blk) * 0.32, 0.002, 0.016);
  var sum = 0.0;
  // a random rotation per pixel only pays off with many taps; with few it is just noise
  let rot = select(0.6, hash3(P * 91.7) * 6.2831, SHADOW_TAPS >= 8);
  let cs = vec2f(cos(rot), sin(rot));
  var tint = vec3f(0.0);
  for (var i = 0; i < SHADOW_TAPS; i++) {
    let q = POISSON[i];
    let r = vec2f(q.x * cs.x - q.y * cs.y, q.x * cs.y + q.y * cs.x);
    sum += textureSampleCompareLevel(shadowMap, cmp, uv + r * pen, z - 0.0015);
    tint += textureSampleLevel(shadowCol, lin, uv + r * pen * 1.5, 0.0).rgb;
  }
  o.lit = sum / f32(SHADOW_TAPS);
  o.tint = tint / 16.0;
  return o;
}

fn contactAO(P: vec3f) -> f32 {
  let tp = u.topVP * vec4f(P, 1.0);
  let uv = vec2f(tp.x * 0.5 + 0.5, 0.5 - tp.y * 0.5);
  let dims = vec2f(textureDimensions(heightMap));
  var occ = 0.0;
  // the height map's depth encodes y linearly over [-1, 4]
  for (var ring = 0; ring < AO_RINGS; ring++) {
    let rad = 0.004 + f32(ring) * 0.009;
    for (var i = 0; i < 8; i++) {
      let a = f32(i) * 0.785398 + f32(ring) * 0.39;
      let s = uv + vec2f(cos(a), sin(a)) * rad;
      if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) { continue; }
      let d = textureLoad(heightMap, vec2i(s * dims), 0);
      let h = d * 5.0 - 1.0;
      if (d < 0.9999) {
        let dist = f32(ring) * 0.12 + 0.05;
        occ += (1.0 - smoothstep(0.0, 0.35 + dist, h)) * (1.0 - f32(ring) * 0.2);
      }
    }
  }
  return clamp(occ / max(f32(AO_RINGS) * 16.0 / 3.0, 1.0), 0.0, 1.0);
}

struct BgOut { @location(0) c: vec4f };
@fragment fn fsBackground(i: FSOut) -> BgOut {
  let a = u.invViewProj * vec4f(i.ndc, 0.0, 1.0);
  let b = u.invViewProj * vec4f(i.ndc, 1.0, 1.0);
  let ro = a.xyz / a.w;
  let rd = normalize(b.xyz / b.w - ro);
  var col = u.bg.rgb;
  var dep = 1000.0;
  col *= 1.0 - 0.08 * smoothstep(0.0, 0.6, rd.y);
  if (rd.y < -1e-4) {
    let t = -ro.y / rd.y;
    let P = ro + rd * t;
    dep = linearDepth(P);
    let sh = keyShadow(P);
    let ao = contactAO(P);
    // jelly casts a shadow tinted by whatever the light crossed first; contact occlusion stays neutral
    // ambient keeps the shadow open; light that got through the jelly adds its colour back
    let shade = u.shadowTint.rgb + sh.tint * (vec3f(1.0) - u.shadowTint.rgb) * 0.85;
    let shadowCol = mix(vec3f(1.0), shade, 1.0 - sh.lit);
    var fl = u.bg.rgb * (0.9 + 0.1 * clamp(1.0 - length(P.xz) * 0.08, 0.0, 1.0));
    fl *= shadowCol;
    fl *= 1.0 - ao * 0.82;
    let fade = smoothstep(9.0, 30.0, t);
    col = mix(fl, col, fade);
  }
  var o: BgOut; o.c = vec4f(col, dep); return o;
}

struct VIn { @location(0) p: vec3f, @location(1) n: vec3f, @location(2) rest: vec3f, @location(3) mat: f32 };
struct VOut { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) rest: vec3f, @location(3) mat: f32 };
@vertex fn vsMesh(v: VIn) -> VOut {
  var o: VOut;
  o.pos = u.viewProj * vec4f(v.p, 1.0);
  o.wp = v.p; o.n = v.n; o.rest = v.rest; o.mat = v.mat;
  return o;
}

@fragment fn fsProps(i: VOut) -> BgOut {
  let N = normalize(i.n);
  let V = normalize(u.camPos.xyz - i.wp);
  let NdV = max(dot(N, V), 1e-3);
  let L = u.keyDir.xyz;
  var col: vec3f;
  if (i.mat < 1.5) {
    // seed: dark, lacquered, a faint warm brown where it thins out
    let fres = 0.05 + 0.95 * pow(1.0 - NdV, 5.0);
    let n1 = vnoise(i.rest * 180.0);
    var base = u.seed.rgb * (0.8 + 0.4 * n1);
    base += vec3f(0.08, 0.03, 0.012) * pow(1.0 - NdV, 2.0);
    let dif = max(dot(N, L), 0.0) * 0.5 + 0.35;
    let env = studioEnv(reflect(-V, N), 0.22, u.bg.rgb);
    col = base * dif + min(env, vec3f(0.5)) * fres * 0.06;
  } else if (i.mat > 2.8 && i.mat < 4.5) {
    // knife steel: product-shot gradient across the blade, brushed along its length,
    // a lighter satin bevel at the edge and a polished bolster
    let bevel = 1.0 - smoothstep(3.05, 3.4, i.mat);
    let bolster = smoothstep(3.55, 3.65, i.mat);
    let brush = vnoise(vec3f(i.rest.x * 3.0, i.rest.y * 260.0, i.rest.z * 40.0));
    let rough = mix(mix(0.12 + 0.06 * brush, 0.22, bevel), 0.06, bolster);
    let F0 = vec3f(0.56, 0.57, 0.585);
    let fres = F0 + (vec3f(1.0) - F0) * pow(1.0 - NdV, 5.0);
    let R = reflect(-V, N);
    let hz = R.y * 0.8 + (i.rest.y / 0.63 - 0.45) * 1.1 + 0.28 + (brush - 0.5) * 0.06;
    let sweep = smoothstep(-0.35, 0.45, hz);
    var env = mix(vec3f(0.045, 0.047, 0.05), vec3f(0.5, 0.51, 0.53), sweep);
    env += max(studioEnv(R, rough, u.bg.rgb) - u.bg.rgb * 1.15, vec3f(0.0)) * 0.9;
    env *= 0.92 + 0.16 * brush;
    let spec = ggx(N, V, L, max(rough, 0.1)) * u.keyDir.w;
    col = env * fres + fres * spec * 0.5 + vec3f(0.02) * max(dot(N, L), 0.0);
    col = mix(col, col * 0.85 + vec3f(0.12, 0.122, 0.125), bevel * 0.7);
    col = min(col, vec3f(6.0));
  } else if (i.mat > 4.5) {
    // handle: dark walnut, straight grain, satin oil finish and three steel rivets
    let p = clamp((-i.rest.x - 0.07) / 0.84, 0.0, 1.0);
    let cy = 0.56 - 0.028 * p * p;
    var rivet = 0.0;
    for (var k = 0; k < 3; k++) {
      let rx = -0.24 - f32(k) * 0.25;
      let dd = length(vec2f(i.rest.x - rx, i.rest.y - cy));
      rivet = max(rivet, 1.0 - smoothstep(0.017, 0.021, dd));
    }
    rivet *= smoothstep(0.03, 0.045, abs(i.rest.z));
    let g = fbm(vec3f(i.rest.x * 2.2, i.rest.y * 38.0 + vnoise(i.rest * 9.0) * 2.0, i.rest.z * 38.0));
    let wood = mix(vec3f(0.028, 0.014, 0.008), vec3f(0.085, 0.045, 0.024), smoothstep(0.3, 0.75, g));
    let dif = max(dot(N, L), 0.0) * 0.8 + 0.3;
    let fr = 0.04 + 0.96 * pow(1.0 - NdV, 5.0);
    col = wood * dif + studioEnv(reflect(-V, N), 0.35, u.bg.rgb) * fr * 0.35 + vec3f(ggx(N, V, L, 0.35)) * 0.08 * u.keyDir.w;
    col = mix(col, studioEnv(reflect(-V, N), 0.1, u.bg.rgb) * 0.7 + vec3f(ggx(N, V, L, 0.12)) * 0.4, rivet);
  } else {
    // air bubble: a lighter pocket with a faint rim and one pin-point highlight
    let rim = pow(1.0 - NdV, 2.0);
    col = mix(vec3f(0.9, 0.84, 0.82), vec3f(0.62, 0.55, 0.55), rim) + vec3f(ggx(N, V, L, 0.08)) * 0.5;
  }
  var o: BgOut; o.c = vec4f(col, linearDepth(i.wp)); return o;
}
`;

// ── nearest back faces → linear depth (view-ray thickness) ──
const WGSL_BACK = WGSL_COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u: U;
struct VIn { @location(0) p: vec3f };
struct VOut { @builtin(position) pos: vec4f, @location(0) wp: vec3f };
@vertex fn vs(v: VIn) -> VOut { var o: VOut; o.pos = u.viewProj * vec4f(v.p, 1.0); o.wp = v.p; return o; }
@fragment fn fs(i: VOut) -> @location(0) vec4f { return vec4f(linearDepth(i.wp), 0.0, 0.0, 1.0); }
`;

// ── main: copy the scene, then the jelly itself, then the optional mesh overlay ──
const WGSL_MAIN = WGSL_COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sceneTex: texture_2d<f32>;
@group(0) @binding(2) var backTex: texture_2d<f32>;
@group(0) @binding(3) var lin: sampler;
// render quality: refraction taps (the last one is the centre)
override REFR_TAPS: i32 = 7;

@vertex fn vsFull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return vec4f(p, 0.0, 1.0);
}
@fragment fn fsCopy(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  return vec4f(textureLoad(sceneTex, vec2i(fc.xy), 0).rgb, 1.0);
}

struct VIn { @location(0) p: vec3f, @location(1) n: vec3f, @location(2) rest: vec3f, @location(3) mat: f32 };
struct VOut { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) rest: vec3f };
@vertex fn vsJelly(v: VIn) -> VOut {
  var o: VOut;
  o.pos = u.viewProj * vec4f(v.p, 1.0);
  o.wp = v.p; o.n = v.n; o.rest = v.rest;
  return o;
}

fn toUV(p: vec3f) -> vec2f {
  let c = u.viewProj * vec4f(p, 1.0);
  let n = c.xy / c.w;
  return vec2f(n.x * 0.5 + 0.5, 0.5 - n.y * 0.5);
}

@fragment fn fsJelly(i: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  var N = normalize(i.n);
  if (!ff) { N = -N; }
  let P = i.wp;
  let V = normalize(u.camPos.xyz - P);
  let L = u.keyDir.xyz;
  let key = u.keyDir.w;
  let NdV = max(dot(N, V), 1e-3);

  // ── material bands from rest-space depth under the skin (they deform with the body) ──
  let Q = i.rest;
  let q = vec3f(Q.x, Q.y - u.melon.w, Q.z);
  let r = u.melon.xyz;
  let cs = normalize(q.yz / r.yz + vec2f(1e-5, 0.0));
  let ax = q.x / r.x;
  let wob = fbm(vec3f(cs * 3.0, ax * 2.5 + 1.7)) - 0.5;
  let depth = -sdMelon(Q) + wob * 0.012;
  let skinW = 1.0 - smoothstep(u.bands.x - 0.006, u.bands.x + 0.008, depth);
  let paleEdge = u.bands.y + wob * 0.05;
  let paleW = (1.0 - smoothstep(paleEdge - 0.03, paleEdge + 0.04, depth)) * (1.0 - skinW);
  let fleshW = 1.0 - skinW - paleW;
  let rd = rindAt(Q, depth);
  // a cut through the rind shows a lighter green inner skin band
  let skinCol = mix(rd.col, mix(u.skin.rgb, u.pale.rgb, 0.35), smoothstep(0.012, 0.04, depth) * 0.6);

  // ── thickness along the view ray, to the nearest back face ──
  let uv = i.pos.xy * u.screen.zw;
  let pix = vec2i(i.pos.xy);
  let fz = linearDepth(P);
  let bz = textureLoad(backTex, pix, 0).r;
  let sz = textureLoad(sceneTex, pix, 0).a;
  let cosv = max(dot(-V, u.camFwd.xyz), 0.35);
  let thickBack = select(0.0, clamp((bz - fz) / cosv, 0.0, 4.0), bz > fz);
  let thick = min(thickBack, max(sz - fz, 0.0) / cosv);

  // crystalline grain radiating from the heart of the melon
  let rr = length(q.yz / r.yz);
  // fibres: fast across the angle, slow along the radius, so they fan out from the heart
  let fibre = fbm(vec3f(cs * 26.0, rr * 2.6 + ax * 7.0));
  let grain = fbm(vec3f(cs * rr * 14.0, ax * 8.0));
  let grain2 = vnoise(Q * 48.0);
  let dens = 1.0 + (grain - 0.5) * 0.5 + (fibre - 0.5) * 0.5 + (grain2 - 0.5) * 0.2;

  // ── absorption / scattering per material ──
  let fleshT = clamp(u.flesh.rgb, vec3f(0.002), vec3f(0.999));
  let sigF = -log(fleshT) * 2.2 * dens;
  let paleT = clamp(u.pale.rgb, vec3f(0.01), vec3f(0.999));
  let sigP = -log(paleT) * 2.0 + vec3f(0.6);
  let sigS = -log(clamp(u.skin.rgb, vec3f(0.002), vec3f(0.99))) * 3.5 + vec3f(2.0);
  let sigma = sigF * fleshW + sigP * paleW + sigS * skinW;
  let scatK = 1.2 * fleshW + 4.5 * paleW + 26.0 * skinW;
  let rough = mix(mix(0.09, 0.18, paleW), rd.rough, skinW);

  // ── refraction: bend the view ray into the jelly and look where it leaves ──
  // what lies straight behind: a seed just under the face is seen sharp, the far side blurred
  let behindZ = max(textureLoad(sceneTex, pix, 0).a - fz, 0.0) / cosv;
  let reach = min(thickBack, behindZ);
  let ior = 1.42;
  let Rr = refract(-V, N, 1.0 / ior);
  let exitP = P + Rr * min(reach, 1.2) * 0.5;
  var ruv = toUV(exitP);
  ruv = mix(uv, ruv, 0.85);
  let blurR = (0.0004 + 0.006 * min(reach, 1.0)) * (0.6 + scatK * 0.02);
  var transmitted = vec3f(0.0);
  var pathL = 0.0;
  for (var k = 0; k < REFR_TAPS; k++) {
    let a = f32(k) * 0.8976 + 0.3;
    let o = select(vec2f(cos(a), sin(a)) * blurR, vec2f(0.0), k == REFR_TAPS - 1);
    let s = textureSampleLevel(sceneTex, lin, clamp(ruv + o, vec2f(0.001), vec2f(0.999)), 0.0);
    // each tap is absorbed over its own path: to a seed, a bubble, or out through the back
    let pl = clamp(min(thickBack, max(s.a - fz, 0.0) / cosv + 0.02), 0.0, 4.0);
    transmitted += s.rgb * exp(-sigma * pl);
    pathL += pl;
  }
  transmitted /= f32(REFR_TAPS); pathL /= f32(REFR_TAPS);
  let scat = 1.0 - exp(-scatK * pathL * 0.5 - scatK * 0.02);

  // ── light arriving inside the body ──
  let NdL = dot(N, L);
  let wrap = clamp((NdL + 0.6) / 1.6, 0.0, 1.0);
  let amb = u.bg.rgb * mix(0.3, 0.75, N.y * 0.5 + 0.5);
  // the flesh brightens toward the rind
  let nearPale = 1.0 - smoothstep(u.bands.y + 0.02, u.bands.y + 0.7, depth);
  let fleshAlb = mix(u.fleshDeep.rgb, u.flesh.rgb, nearPale * 0.75) * (0.8 + 0.28 * fibre + 0.14 * grain);
  let albedo = fleshAlb * fleshW + u.pale.rgb * 0.72 * paleW + skinCol * skinW;
  let inner = albedo * (amb + vec3f(1.0, 0.97, 0.92) * key * 0.45 * wrap);

  // thin edges glow when the key light is behind them
  let back = pow(clamp(dot(V, -L), 0.0, 1.0), 3.0) * 1.4 + 0.25;
  let thinK = exp(-sigma * (pathL * 0.6 + 0.05));
  let glowTint = u.flesh.rgb * fleshW + vec3f(0.9, 0.95, 0.78) * paleW + skinCol * 0.5 * skinW;
  let glow = glowTint * thinK * back * key * 0.42 * (1.0 - skinW * 0.8) * clamp(1.0 - NdL * 0.6, 0.0, 1.0);

  var body = transmitted * (1.0 - scat) + inner * scat + glow;

  // sugar glints in the flesh
  let R = reflect(-V, N);
  let cell = floor(Q * 80.0);
  let spark = step(0.975, hash3(cell)) * pow(max(dot(R, L), 0.0), 30.0) * fleshW;
  body += vec3f(1.0, 0.86, 0.82) * spark * 0.35;

  // ── surface: Fresnel reflection of the studio + key highlight ──
  let F0 = mix(0.034, 0.045, skinW);
  let F = F0 + (1.0 - F0) * pow(1.0 - NdV, 5.0);
  let env = studioEnv(R, rough, u.bg.rgb);
  let spec = ggx(N, V, L, rough) * key * vec3f(1.0, 0.97, 0.93);
  let col = body * (1.0 - F) + env * F + spec * mix(0.9, 1.1, skinW) * (F0 / 0.04);
  return vec4f(col, 1.0);
}

// ── mesh overlay ──
struct LOut { @builtin(position) pos: vec4f, @location(0) d: f32 };
@vertex fn vsLine(@location(0) p: vec3f) -> LOut {
  var o: LOut; o.pos = u.viewProj * vec4f(p, 1.0); o.d = linearDepth(p); return o;
}
@fragment fn fsLine(i: LOut) -> @location(0) vec4f {
  let a = u.misc.y * mix(0.9, 0.35, clamp((i.d - 6.0) * 0.3, 0.0, 1.0));
  return vec4f(vec3f(0.04, 0.05, 0.06) * a, a);
}
`;

// ── post: exposure, Khronos PBR Neutral tone mapping, sRGB, dither ──
const WGSL_POST = WGSL_COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var hdr: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return vec4f(p, 0.0, 1.0);
}
fn neutral(c0: vec3f) -> vec3f {
  let startC = 0.8 - 0.04;
  let desat = 0.15;
  let x = min(c0.r, min(c0.g, c0.b));
  let off = select(0.04, x - 6.25 * x * x, x < 0.08);
  var c = c0 - off;
  let peak = max(c.r, max(c.g, c.b));
  if (peak < startC) { return c; }
  let d = 1.0 - startC;
  let np = 1.0 - d * d / (peak + d - startC);
  c *= np / peak;
  let g = 1.0 - 1.0 / (desat * (peak - np) + 1.0);
  return mix(c, vec3f(np), g);
}
fn oetf(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  var c = textureLoad(hdr, vec2i(fc.xy), 0).rgb * u.misc.x;
  c = neutral(max(c, vec3f(0.0)));
  var s = oetf(clamp(c, vec3f(0.0), vec3f(1.0)));
  s += (hash3(vec3f(fc.xy, 1.0)) - 0.5) / 255.0;
  return vec4f(s, 1.0);
}
`;
