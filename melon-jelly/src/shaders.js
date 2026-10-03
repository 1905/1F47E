// ─────────────────────────────────────────────────────────────
//  WGSL
// ─────────────────────────────────────────────────────────────

export const WGSL_COMMON = /* wgsl */`
struct U {
  viewProj: mat4x4f,
  view: mat4x4f,
  invViewProj: mat4x4f,
  lightVP: mat4x4f,
  topVP: mat4x4f,
  camPos: vec4f,     // xyz, w = time
  camFwd: vec4f,
  keyDir: vec4f,     // xyz toward light, w = intensity
  screen: vec4f,     // w, h, 1/w, 1/h
  flesh: vec4f,      // transmission tint of the flesh
  fleshDeep: vec4f,  // scattering albedo of the flesh
  pale: vec4f,
  skin: vec4f,
  stripe: vec4f,
  seed: vec4f,
  shape: vec4f,      // T, Ro, skinDepth, paleDepth
  misc: vec4f,       // exposure, meshAlpha, floorY, unused
  bg: vec4f,
  shadowTint: vec4f,
};

const PI = 3.14159265;

fn hash3(p: vec3f) -> f32 {
  var q = fract(p * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
fn vnoise(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(mix(hash3(i + vec3f(0,0,0)), hash3(i + vec3f(1,0,0)), u.x), mix(hash3(i + vec3f(0,1,0)), hash3(i + vec3f(1,1,0)), u.x), u.y);
  let b = mix(mix(hash3(i + vec3f(0,0,1)), hash3(i + vec3f(1,0,1)), u.x), mix(hash3(i + vec3f(0,1,1)), hash3(i + vec3f(1,1,1)), u.x), u.y);
  return mix(a, b, u.z);
}
fn fbm(p: vec3f) -> f32 {
  return 0.55 * vnoise(p) + 0.3 * vnoise(p * 2.13 + 7.1) + 0.15 * vnoise(p * 4.37 + 3.3);
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

// procedural photo studio: pale cyclorama, overhead softbox, back-left strip, front-right fill card
fn studioEnv(d: vec3f, rough: f32, bg: vec3f) -> vec3f {
  let b = 0.012 + rough * 0.55;
  let y = d.y;
  var col = mix(bg * 0.62, bg * 1.05, smoothstep(-0.35, 0.25, y));
  // the bright paper sweep near the horizon gives vertical walls something to reflect
  col += bg * 0.55 * (1.0 - smoothstep(0.0, 0.3, abs(y + 0.08)));
  col = mix(col, bg * 0.8, smoothstep(0.3, 1.0, y));
  col += vec3f(1.0, 0.985, 0.96) * 3.2 * softbox(d, normalize(vec3f(0.05, 1.0, -0.15)), vec3f(0.0, 0.0, 1.0), vec2f(0.55, 0.32), b);
  col += vec3f(1.0, 0.98, 0.95) * 3.0 * softbox(d, normalize(vec3f(-0.42, 0.34, -0.8)), vec3f(0.0, 1.0, 0.0), vec2f(0.7, 0.06), b);
  col += vec3f(1.0, 0.97, 0.93) * 4.0 * softbox(d, normalize(vec3f(-0.8, 0.38, -0.2)), vec3f(0.0, 1.0, 0.0), vec2f(0.08, 0.55), b);
  col += vec3f(0.95, 0.97, 1.0) * 1.2 * softbox(d, normalize(vec3f(0.85, 0.3, 0.55)), vec3f(0.0, 1.0, 0.0), vec2f(0.45, 0.5), b * 1.3);
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
`;

export const WGSL_DEPTH = /* wgsl */`
@group(0) @binding(0) var<uniform> m: mat4x4f;
@vertex fn vs(@location(0) p: vec3f) -> @builtin(position) vec4f { return m * vec4f(p, 1.0); }
`;

// ── scene: background / floor with soft shadows, then seeds + bubbles ──
export const WGSL_SCENE = WGSL_COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var heightMap: texture_depth_2d;
@group(0) @binding(3) var cmp: sampler_comparison;

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

fn keyShadow(P: vec3f) -> f32 {
  let lp = u.lightVP * vec4f(P, 1.0);
  let uv = vec2f(lp.x * 0.5 + 0.5, 0.5 - lp.y * 0.5);
  let z = lp.z;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }
  // blocker search → penumbra size (PCSS-lite)
  let dims = vec2f(textureDimensions(shadowMap));
  var blk = 0.0; var nb = 0.0;
  for (var i = 0; i < 16; i++) {
    let s = uv + POISSON[i] * 0.02;
    let d = textureLoad(shadowMap, vec2i(clamp(s, vec2f(0.0), vec2f(0.999)) * dims), 0);
    if (d < z - 0.002) { blk += d; nb += 1.0; }
  }
  if (nb < 0.5) { return 1.0; }
  blk /= nb;
  let pen = clamp((z - blk) * 0.45, 0.003, 0.022);
  var sum = 0.0;
  let rot = hash3(P * 91.7) * 6.2831;
  let cs = vec2f(cos(rot), sin(rot));
  for (var i = 0; i < 16; i++) {
    let o = POISSON[i];
    let r = vec2f(o.x * cs.x - o.y * cs.y, o.x * cs.y + o.y * cs.x);
    sum += textureSampleCompareLevel(shadowMap, cmp, uv + r * pen, z - 0.0015);
  }
  return sum / 16.0;
}

fn contactAO(P: vec3f) -> f32 {
  let tp = u.topVP * vec4f(P, 1.0);
  let uv = vec2f(tp.x * 0.5 + 0.5, 0.5 - tp.y * 0.5);
  let dims = vec2f(textureDimensions(heightMap));
  var occ = 0.0;
  // heightmap depth encodes y linearly over [-1, 4]
  for (var ring = 0; ring < 3; ring++) {
    let rad = 0.012 + f32(ring) * 0.028;
    for (var i = 0; i < 8; i++) {
      let a = f32(i) * 0.785398 + f32(ring) * 0.39;
      let s = uv + vec2f(cos(a), sin(a)) * rad;
      if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) { continue; }
      let d = textureLoad(heightMap, vec2i(s * dims), 0);
      let h = d * 5.0 - 1.0;
      if (d < 0.9999) {
        let dist = f32(ring) * 0.028 * 5.2 + 0.05;
        occ += (1.0 - smoothstep(0.0, 0.55 + dist, h)) * (1.0 - f32(ring) * 0.22);
      }
    }
  }
  return clamp(occ / 16.0, 0.0, 1.0);
}

struct BgOut { @location(0) c: vec4f };
@fragment fn fsBackground(i: FSOut) -> BgOut {
  let a = u.invViewProj * vec4f(i.ndc, 0.0, 1.0);
  let b = u.invViewProj * vec4f(i.ndc, 1.0, 1.0);
  let ro = a.xyz / a.w;
  let rd = normalize(b.xyz / b.w - ro);
  var col = u.bg.rgb;
  var dep = 1000.0;
  // slight falloff above the horizon, like a paper sweep lit from above
  col *= 1.0 - 0.08 * smoothstep(0.0, 0.6, rd.y);
  if (rd.y < -1e-4) {
    let t = (u.misc.z - ro.y) / rd.y;
    let P = ro + rd * t;
    dep = linearDepth(P);
    let sh = keyShadow(P);
    let ao = contactAO(P);
    // translucent jelly casts a tinted shadow; contact occlusion stays neutral
    let shadowCol = mix(vec3f(1.0), u.shadowTint.rgb, 1.0 - sh);
    var fl = u.bg.rgb * (0.9 + 0.1 * clamp(1.0 - length(P.xz - vec2f(0.0, 0.8)) * 0.12, 0.0, 1.0));
    fl *= shadowCol;
    fl *= 1.0 - ao * 0.72;
    let fade = smoothstep(7.0, 22.0, t);
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
    // seed: dark, lacquered, faint warm brown where it thins out
    let fres = 0.05 + 0.95 * pow(1.0 - NdV, 5.0);
    let n1 = vnoise(i.rest * 90.0);
    var base = u.seed.rgb * (0.8 + 0.4 * n1);
    let rim = pow(1.0 - NdV, 2.0);
    base += vec3f(0.09, 0.035, 0.015) * rim;
    let dif = max(dot(N, L), 0.0) * 0.5 + 0.35;
    let env = studioEnv(reflect(-V, N), 0.22, u.bg.rgb);
    // seeds sit just under the jelly skin, so the jelly supplies the gloss; keep the seed itself matte-dark
    col = base * dif + min(env, vec3f(0.5)) * fres * 0.06;
  } else if (i.mat > 2.8 && i.mat < 4.5) {
    // knife steel: a product-shot gradient (dark board below, bright sweep above) across the blade,
    // brushed along its length, a lighter satin bevel at the edge and a polished bolster
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
    // the studio's softboxes still show up as crisp streaks
    env += max(studioEnv(R, rough, u.bg.rgb) - u.bg.rgb * 1.15, vec3f(0.0)) * 0.9;
    env *= 0.92 + 0.16 * brush;
    let spec = ggx(N, V, L, max(rough, 0.1)) * u.keyDir.w;
    col = env * fres + fres * spec * 0.5 + vec3f(0.02) * max(dot(N, L), 0.0);
    col = mix(col, col * 0.85 + vec3f(0.12, 0.122, 0.125), bevel * 0.7);
    col = min(col, vec3f(6.0));
  } else if (i.mat > 4.5) {
    // handle: dark walnut, straight grain along the handle, a satin oil finish and three steel rivets
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
    let envW = studioEnv(reflect(-V, N), 0.35, u.bg.rgb);
    col = wood * dif + envW * fr * 0.35 + vec3f(ggx(N, V, L, 0.35)) * 0.08 * u.keyDir.w;
    let envR = studioEnv(reflect(-V, N), 0.1, u.bg.rgb);
    col = mix(col, envR * 0.7 + vec3f(ggx(N, V, L, 0.12)) * 0.4, rivet);
  } else {
    // air bubble: bright rim, clear core, one crisp highlight
    // soft and low-contrast: a lighter pocket with a faint rim and one pin-point highlight
    let rim = pow(1.0 - NdV, 2.0);
    col = mix(vec3f(0.9, 0.84, 0.82), vec3f(0.62, 0.55, 0.55), rim) + vec3f(ggx(N, V, L, 0.08)) * 0.5;
  }
  var o: BgOut; o.c = vec4f(col, linearDepth(i.wp)); return o;
}
`;

// ── back faces → linear depth (for view-ray thickness) ──
export const WGSL_BACK = WGSL_COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u: U;
struct VIn { @location(0) p: vec3f };
struct VOut { @builtin(position) pos: vec4f, @location(0) wp: vec3f };
@vertex fn vs(v: VIn) -> VOut { var o: VOut; o.pos = u.viewProj * vec4f(v.p, 1.0); o.wp = v.p; return o; }
@fragment fn fs(i: VOut) -> @location(0) vec4f { return vec4f(linearDepth(i.wp), 0.0, 0.0, 1.0); }
`;

// ── main: copy the scene, then the jelly itself, then the optional mesh overlay ──
export const WGSL_MAIN = WGSL_COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sceneTex: texture_2d<f32>;
@group(0) @binding(2) var backTex: texture_2d<f32>;
@group(0) @binding(3) var lin: sampler;

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

  // ── material regions from rest-space coordinates (they deform with the body) ──
  let Q = i.rest;
  let T = u.shape.x; let Ro = u.shape.y;
  let r = length(Q.xz);
  let th = atan2(Q.x, Q.z);
  let wob = (fbm(vec3f(th * 9.0, Q.y * 3.0, 1.7)) - 0.5);
  let depth = Ro - r + wob * 0.018;
  let skinW = 1.0 - smoothstep(u.shape.z - 0.008, u.shape.z + 0.01, depth);
  let paleEdge = u.shape.w + wob * 0.035;
  let paleW = (1.0 - smoothstep(paleEdge - 0.035, paleEdge + 0.035, depth)) * (1.0 - skinW);
  let fleshW = 1.0 - skinW - paleW;

  // irregular stripes running across the rind, pole to pole
  let sn = fbm(vec3f(th * 5.0, Q.y * 2.2, 3.0));
  let stripeF = sin(th * 34.0 + sn * 7.0 + fbm(vec3f(th * 22.0, Q.y * 7.0, 9.0)) * 2.5);
  let stripe = smoothstep(-0.05, 0.35, stripeF) * smoothstep(0.1, 0.02, depth);
  let speck = smoothstep(0.62, 0.8, vnoise(vec3f(th * 160.0, Q.y * 40.0, 2.0)));
  var skinCol = mix(u.skin.rgb, u.stripe.rgb, clamp(stripe + speck * 0.35, 0.0, 1.0));
  // the cut face shows a lighter green inner skin band
  skinCol = mix(skinCol, mix(u.skin.rgb, u.pale.rgb, 0.35), smoothstep(0.02, 0.07, depth) * 0.6);

  // ── thickness along the view ray ──
  let uv = i.pos.xy * u.screen.zw;
  let pix = vec2i(i.pos.xy);
  let fz = linearDepth(P);
  let bz = textureLoad(backTex, pix, 0).r;
  let sz = textureLoad(sceneTex, pix, 0).a;
  let cosv = max(dot(-V, u.camFwd.xyz), 0.35);
  let thick = clamp((min(bz, sz) - fz) / cosv, 0.0, 3.0);
  let thickBack = clamp((bz - fz) / cosv, 0.0, 3.0);

  // internal texture: soft crystalline grain radiating from the heart of the melon
  let grain = fbm(vec3f(r * 26.0, th * 18.0, Q.y * 14.0));
  let grain2 = vnoise(Q * 55.0);
  let dens = 1.0 + (grain - 0.5) * 0.5 + (grain2 - 0.5) * 0.18;

  // ── absorption / scattering coefficients per material ──
  let fleshT = clamp(u.flesh.rgb, vec3f(0.002), vec3f(0.999));
  let sigF = -log(fleshT) * 3.4 * dens;
  let paleT = clamp(u.pale.rgb, vec3f(0.01), vec3f(0.999));
  let sigP = -log(paleT) * 2.0 + vec3f(0.5);
  let sigS = -log(clamp(u.skin.rgb, vec3f(0.002), vec3f(0.99))) * 3.5 + vec3f(2.0);
  let sigma = sigF * fleshW + sigP * paleW + sigS * skinW;
  let scatK = 1.7 * fleshW + 4.5 * paleW + 26.0 * skinW;
  let rough = mix(mix(0.1, 0.2, paleW), 0.14 + stripe * 0.04, skinW);

  // ── refraction: bend the view ray into the jelly, find where it leaves ──
  let ior = 1.42;
  let Rr = refract(-V, N, 1.0 / ior);
  let exitP = P + Rr * min(thickBack, 0.9) * 0.55;
  var ruv = toUV(exitP);
  ruv = mix(uv, ruv, 0.85);
  // a little diffusion inside the candy blurs what lies behind
  let blurR = (0.001 + 0.007 * min(thick, 1.0)) * (0.6 + scatK * 0.02);
  // each tap is absorbed over its own path length (to a seed, a bubble or out through the back)
  var behind = vec3f(0.0);
  var transmitted = vec3f(0.0);
  var pathL = 0.0;
  for (var k = 0; k < 7; k++) {
    let a = f32(k) * 0.8976 + 0.3;
    let o = select(vec2f(cos(a), sin(a)) * blurR, vec2f(0.0), k == 6);
    let s = textureSampleLevel(sceneTex, lin, clamp(ruv + o, vec2f(0.001), vec2f(0.999)), 0.0);
    let pl = clamp(min(thickBack, max(s.a - fz, 0.0) / cosv + 0.03), 0.0, 3.0);
    behind += s.rgb;
    transmitted += s.rgb * exp(-sigma * pl);
    pathL += pl;
  }
  behind /= 7.0; transmitted /= 7.0; pathL /= 7.0;
  let scat = 1.0 - exp(-scatK * pathL * 0.5 - scatK * 0.02);

  // ── light arriving inside the body ──
  let NdL = dot(N, L);
  let wrap = clamp((NdL + 0.6) / 1.6, 0.0, 1.0);
  let amb = u.bg.rgb * mix(0.3, 0.75, N.y * 0.5 + 0.5);
  // flesh brightens toward the rind, as in a real melon
  let nearPale = 1.0 - smoothstep(u.shape.w, u.shape.w + 0.3, depth);
  let fleshAlb = mix(u.fleshDeep.rgb, u.flesh.rgb * 0.9, nearPale * 0.45);
  let albedo = fleshAlb * fleshW + u.pale.rgb * 0.7 * paleW + skinCol * skinW;
  let inner = albedo * (amb + vec3f(1.0, 0.97, 0.92) * key * 0.45 * wrap);

  // thin edges glow when the key light is behind them
  let back = pow(clamp(dot(V, -L), 0.0, 1.0), 3.0) * 1.4 + 0.25;
  let thinK = exp(-sigma * (pathL * 0.6 + 0.05));
  let glowTint = u.flesh.rgb * fleshW + vec3f(0.9, 0.95, 0.78) * paleW + skinCol * 0.6 * skinW;
  let glow = glowTint * thinK * back * key * 0.42 * (1.0 - skinW * 0.7) * clamp(1.0 - NdL * 0.6, 0.0, 1.0);

  // ── assemble body color ──
  var body = transmitted * (1.0 - scat) + inner * scat + glow;

  // tiny sub-surface glints in the flesh (sugar crystals)
  let R = reflect(-V, N);
  let cell = floor(Q * vec3f(70.0, 70.0, 70.0));
  let spark = step(0.985, hash3(cell)) * pow(max(dot(R, L), 0.0), 40.0) * fleshW;
  body += vec3f(1.0, 0.85, 0.8) * spark * 0.2;

  // ── surface: Fresnel reflection of the studio + key highlight ──
  let F0 = mix(0.034, 0.045, skinW);
  let F = F0 + (1.0 - F0) * pow(1.0 - NdV, 5.0);
  let env = studioEnv(R, rough, u.bg.rgb);
  let spec = ggx(N, V, L, rough) * key * vec3f(1.0, 0.97, 0.93);
  var col = body * (1.0 - F) + env * F + spec * mix(0.9, 1.1, skinW) * (F0 / 0.04);

  return vec4f(col, 1.0);
}

// ── mesh overlay ──
struct LOut { @builtin(position) pos: vec4f, @location(0) d: f32 };
@vertex fn vsLine(@location(0) p: vec3f) -> LOut {
  var o: LOut; o.pos = u.viewProj * vec4f(p, 1.0); o.d = linearDepth(p); return o;
}
@fragment fn fsLine(i: LOut) -> @location(0) vec4f {
  let a = u.misc.y * mix(0.9, 0.35, clamp((i.d - 5.0) * 0.5, 0.0, 1.0));
  return vec4f(vec3f(0.04, 0.05, 0.06) * a, a);
}
`;

// ── post: exposure, Khronos PBR Neutral tone mapping, sRGB, dither ──
export const WGSL_POST = WGSL_COMMON + /* wgsl */`
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
