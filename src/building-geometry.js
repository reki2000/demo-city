// building-geometry.js — フットプリント多角形を押し出した建物ジオメトリを
// タイル単位でマージする。ファサードのバリエーションごとに分けて返す
// （テクスチャの RepeatWrapping で窓グリッドを正しく繰り返すため）。
// 戻り値: [geoVariant0, geoVariant1, geoVariant2, geoVariant3]（空の場合は null）
import * as THREE from './vendor/three.module.js';

export const PALETTE = [0xb8bcc2, 0x9aa3ad, 0xcac2b4, 0x8d99a6, 0xb59d7a, 0x7f8b99, 0xd8d3c8, 0x9aa0a4];
export const VARIANTS = 4;
export const GF_H = 4.2;            // 1階帯の高さ(m)
export const GROUND_VARIANTS = 3;   // 店舗 / ロビー / 住宅入口
export const PB_H = 1.3;            // 上端パラペット帯の高さ(m)
export const TRIM_INDEX = VARIANTS + GROUND_VARIANTS; // 縁（パラペット+角柱）用バケット
export const PROPS_INDEX = TRIM_INDEX + 1;            // 屋上構造物用バケット

export function signedArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const j = (i + 2) % pts.length;
    s += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return s / 2;
}

export function variantOf(s) { // 建物ごとに決定的にファサード種を選ぶ
  let hh = (Math.round(s.pts[0] * 2) * 374761393 ^ Math.round(s.pts[1] * 2) * 668265263) >>> 0;
  return ((hh ^ (hh >> 13)) >>> 0) % VARIANTS;
}
export function groundVariantOf(s) { // 1階帯の種別: 高層は店舗/ロビー、小さい建物は住宅入口中心
  let hh = (Math.round(s.pts[0] * 2) * 974634521 ^ Math.round(s.pts[1] * 2) * 396443801) >>> 0;
  hh = (hh ^ (hh >> 13)) >>> 0;
  const H = s.h - (s.y0 || 0);
  if (H >= 40) return hh % 2;
  if (H < 12) return hh % 4 === 0 ? 0 : 2; // 小さい建物: たまに小店舗、基本は住宅入口
  return hh % GROUND_VARIANTS;
}

export function buildTileGeometry(shapes) {
  const buckets = Array.from({ length: PROPS_INDEX + 1 }, () => ({ pos: [], col: [], uv: [] }));
  const base = new THREE.Color(), roofC = new THREE.Color();
  for (const s of shapes) {
    if (s.prop) { // 屋上構造物: y0..h の単純な押し出し
      const P = buckets[PROPS_INDEX];
      base.setHex(PALETTE[s.c] ?? 0x9aa0a4);
      const pp = (x, y, z, u, v) => { P.pos.push(x, y, z); P.col.push(base.r, base.g, base.b); P.uv.push(u, v); };
      const rp = signedArea(s.pts) > 0 ? [...Array(s.pts.length / 2).keys()].map(i => [s.pts[(s.pts.length / 2 - 1 - i) * 2], s.pts[(s.pts.length / 2 - 1 - i) * 2 + 1]]).flat() : s.pts;
      const pn = rp.length / 2;
      for (let i = 0; i < pn; i++) {
        const j = (i + 1) % pn;
        const ax = rp[i * 2], az = rp[i * 2 + 1], bx = rp[j * 2], bz = rp[j * 2 + 1];
        pp(ax, s.y0, az, i * 0.3, 0); pp(bx, s.y0, bz, (i + 1) * 0.3, 0); pp(ax, s.h, az, i * 0.3, (s.h - s.y0) / 3);
        pp(bx, s.y0, bz, (i + 1) * 0.3, 0); pp(bx, s.h, bz, (i + 1) * 0.3, (s.h - s.y0) / 3); pp(ax, s.h, az, i * 0.3, (s.h - s.y0) / 3);
      }
      for (let i = 1; i < pn - 1; i++) { // 蓋（扇形三角分割で十分: 凸形状前提、法線+Y向きに反転）
        pp(rp[0], s.h, rp[1], 0, 0); pp(rp[(i + 1) * 2], s.h, rp[(i + 1) * 2 + 1], 0.6, 0.3); pp(rp[i * 2], s.h, rp[i * 2 + 1], 0.3, 0.3);
      }
      continue;
    }
    const B = buckets[variantOf(s)];
    const push = (x, y, z, c, u, v) => { B.pos.push(x, y, z); B.col.push(c.r, c.g, c.b); B.uv.push(u, v); };
    const rev = [];
    for (let i = s.pts.length - 2; i >= 0; i -= 2) rev.push(s.pts[i], s.pts[i + 1]);
    // 側面は signedArea<0 の向き、屋根の三角分割は逆向きが正（実測で確認済み）
    const pts = signedArea(s.pts) > 0 ? rev : s.pts;
    const roofPts = signedArea(s.pts) > 0 ? s.pts : rev;
    const n = pts.length / 2;
    base.setHex(PALETTE[s.c] ?? PALETTE[0]).multiplyScalar(1.22); // テクスチャと乗算するので少し明るめに
    roofC.copy(base).multiplyScalar(1.18);
    // 屋根: 耳切り三角分割
    const contour = [];
    for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(roofPts[i * 2], roofPts[i * 2 + 1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    // triangulateShape は (x, y=z) 平面で CCW を返す → 世界では法線が -Y になるので頂点順を反転して +Y にする
    for (const t of tris) for (const vi of [t[0], t[2], t[1]]) {
      push(contour[vi].x, s.h, contour[vi].y, roofC, 0.5, 0.975); // 屋根はテクスチャ上部の無地帯をサンプル
    }
    // 側面: 土台 yB(=s.y0, 地形に埋めた分だけ地面より下) から屋上 s.h まで。
    // 1階帯(yB..yB+GF_H)は店舗・入口テクスチャ、上層はファサード（窓行は帯境界で
    // 途切れないよう v は土台からの連続値）。uは辺の累積長/7m
    const yB = s.y0 || 0, H = s.h - yB;
    const G = buckets[VARIANTS + groundVariantOf(s)];
    const gpush = (x, y, z, u, v) => { G.pos.push(x, y, z); G.col.push(base.r, base.g, base.b); G.uv.push(u, v); };
    let uAcc = 0;
    const gh = Math.min(GF_H, H), vGF = GF_H / 3.2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[j * 2], bz = pts[j * 2 + 1];
      const len = Math.hypot(bx - ax, bz - az), u0 = uAcc / 7, u1 = (uAcc + len) / 7;
      uAcc += len;
      // 1階帯: v は帯テクスチャ全体に 0..(gh/GF_H)
      gpush(ax, yB, az, u0, 0); gpush(bx, yB, bz, u1, 0); gpush(ax, yB + gh, az, u0, gh / GF_H);
      gpush(bx, yB, bz, u1, 0); gpush(bx, yB + gh, bz, u1, gh / GF_H); gpush(ax, yB + gh, az, u0, gh / GF_H);
      // 上層（上端はパラペット帯を縁として分ける）
      if (H > GF_H) {
        const topF = H > GF_H + 2.6 ? s.h - PB_H : s.h;
        push(ax, yB + GF_H, az, base, u0, vGF); push(bx, yB + GF_H, bz, base, u1, vGF); push(ax, topF, az, base, u0, (topF - yB) / 3.2);
        push(bx, yB + GF_H, bz, base, u1, vGF); push(bx, topF, bz, base, u1, (topF - yB) / 3.2); push(ax, topF, az, base, u0, (topF - yB) / 3.2);
        if (topF < s.h) {
          const T = buckets[TRIM_INDEX];
          const tp = (x, y, z, u, v) => { T.pos.push(x, y, z); T.col.push(base.r, base.g, base.b); T.uv.push(u, v); };
          tp(ax, topF, az, u0 * 7 / 3, 0); tp(bx, topF, bz, u1 * 7 / 3, 0); tp(ax, s.h, az, u0 * 7 / 3, 1);
          tp(bx, topF, bz, u1 * 7 / 3, 0); tp(bx, s.h, bz, u1 * 7 / 3, 1); tp(ax, s.h, az, u0 * 7 / 3, 1);
        }
      }
    }
    // 角の縁: 各頂点に細い柱（ダイヤ断面）を立て、壁のフィールドと分ける
    {
      const T = buckets[TRIM_INDEX];
      const tp = (x, y, z, u, v) => { T.pos.push(x, y, z); T.col.push(base.r, base.g, base.b); T.uv.push(u, v); };
      const half = 0.38;
      for (let i = 0; i < n; i++) {
        const px = pts[((i - 1 + n) % n) * 2], pz = pts[((i - 1 + n) % n) * 2 + 1];
        const vx = pts[i * 2], vz = pts[i * 2 + 1];
        const nx2 = pts[((i + 1) % n) * 2], nz2 = pts[((i + 1) % n) * 2 + 1];
        const e1x = px - vx, e1z = pz - vz, e2x = nx2 - vx, e2z = nz2 - vz;
        const l1 = Math.hypot(e1x, e1z), l2 = Math.hypot(e2x, e2z);
        if (l1 < 2.5 || l2 < 2.5) continue;
        let ux = -(e1x / l1 + e2x / l2), uz = -(e1z / l1 + e2z / l2);
        const ul = Math.hypot(ux, uz); if (ul < 0.2) continue; ux /= ul; uz /= ul;
        const wx = -uz, wz = ux;
        const c = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => [vx + (ux * a + wx * b) * half, vz + (uz * a + wz * b) * half]);
        for (let k = 0; k < 4; k++) {
          const A = c[k], B = c[(k + 1) % 4];
          tp(A[0], yB, A[1], k * 0.25, 0); tp(B[0], yB, B[1], (k + 1) * 0.25, 0); tp(A[0], s.h, A[1], k * 0.25, H / 4);
          tp(B[0], yB, B[1], (k + 1) * 0.25, 0); tp(B[0], s.h, B[1], (k + 1) * 0.25, H / 4); tp(A[0], s.h, A[1], k * 0.25, H / 4);
        }
        tp(c[0][0], s.h, c[0][1], 0, 0); tp(c[1][0], s.h, c[1][1], 0.25, 0); tp(c[2][0], s.h, c[2][1], 0.25, 0.25);
        tp(c[0][0], s.h, c[0][1], 0, 0); tp(c[2][0], s.h, c[2][1], 0.25, 0.25); tp(c[3][0], s.h, c[3][1], 0, 0.25);
      }
    }
  }
  return buckets.map(B => {
    if (!B.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(B.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
    g.computeVertexNormals();
    return g;
  });
}
