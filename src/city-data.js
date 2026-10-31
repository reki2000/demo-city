// city-data.js — PLATEAU LOD1 の「MVT押し出し」と同じデータ形を返す層。
// 建物 = フットプリント多角形 + 高さ。これが元データの形状そのもので、
// 実データ化するときは generateTile() の中身を MVT fetch + デコードに差し替える。
// 戻り値は圧縮保持用に量子化する: 頂点は0.5m量子化の平面配列で保持する。
//   shapes: [{ pts:[x,z,...](世界座標), h, c, x,z,w,d(AABB) }]
//   中心部のタイルは OSM 実建物の輪郭 (footprints.js)、外側は手続き生成の矩形。
import { FOOTPRINTS } from './footprints.js';
import { ROADS } from './roads.js';
import { ROOFTOPS } from './rooftops.js';
import { PROADS, PROADS_AUX } from './proads.js';
import { pointInPolygon } from './swing.js';
import { terrainH } from './terrain-h.js';

// PLATEAU地形に建物を載せる: y0 = 輪郭内の最低標高 − 1.5m（坂でも土台が浮かないよう埋める）、
// h は「重心の標高 + 建物高さ」= 屋根の絶対Y に変換する（以降 h は天端、y0 は土台）。
export function applyTerrain(shapes, stage) {
  for (const s of shapes) {
    if (s.prop) continue;
    const cx = s.x + s.w / 2, cz = s.z + s.d / 2;
    const gc = terrainH(stage, cx, cz);
    let gmin = gc;
    for (const [px, pz] of [[s.x, s.z], [s.x + s.w, s.z], [s.x, s.z + s.d], [s.x + s.w, s.z + s.d]]) gmin = Math.min(gmin, terrainH(stage, px, pz));
    s.y0 = Math.round((gmin - 1.5) * 2) / 2;
    s.h = Math.round((gc + s.h) * 2) / 2;
    s.ground = gc;
  }
  return shapes;
}

export const TILE = 300; // 1タイル 300m 四方

function hash2(x, z) {
  let h = (x * 374761393 + z * 668265263) | 0;
  h = (h ^ (h >> 13)) | 0; h = Math.imul(h, 1274126177);
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

export function rectShape(x, z, w, d, h, c) {
  return { pts: [x, z, x + w, z, x + w, z + d, x, z + d], h, c, x, z, w, d };
}
export function ellipsePts(cx, cz, rx, rz, seg = 22) {
  const p = [];
  for (let i = 0; i < seg; i++) { const a = i / seg * Math.PI * 2; p.push(Math.round((cx + Math.cos(a) * rx) * 2) / 2, Math.round((cz + Math.sin(a) * rz) * 2) / 2); }
  return p;
}
export function shapeFromPts(pts, h, c) {
  let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
  for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); z0 = Math.min(z0, pts[i + 1]); z1 = Math.max(z1, pts[i + 1]); }
  return { pts, h, c, x: x0, z: z0, w: x1 - x0, d: z1 - z0 };
}
function landmarkShape(lm) { return lm.pts ? shapeFromPts(lm.pts, lm.h, 6) : rectShape(lm.x - lm.w / 2, lm.z - lm.d / 2, lm.w, lm.d, lm.h, 6); }
function shapeFromFlat(flat) { // [x0,z0,x1,z1,...,h,c] → shape（AABBを計算）
  const pts = flat.slice(0, -2);
  let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
  for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); z0 = Math.min(z0, pts[i + 1]); z1 = Math.max(z1, pts[i + 1]); }
  return { pts, h: flat[flat.length - 2], c: flat[flat.length - 1], x: x0, z: z0, w: x1 - x0, d: z1 - z0 };
}
function tileBytes(shapes) { let n = 0; for (const s of shapes) n += s.pts.length * 2 + 8; return n; } // Int16量子化相当の概算

// ステージ定義: core = 建物密度の中心, landmarks = 実在ランドマーク（単位m, 高さは実値/概算）
export const STAGES = {
  shinjuku: {
    core: { x: 0, z: 0 },
    landmarks: [
      { name: '東京都庁', x: -260, z: -140, w: 90, d: 70, h: 243 },
      { name: 'NTTドコモタワー', x: 520, z: 620, w: 55, d: 55, h: 240 },
      { name: '新宿センタービル', x: -140, z: 60, w: 60, d: 55, h: 223 },
      { name: 'モード学園ビル', x: -60, z: 300, w: 45, d: 40, h: 204 },
      { name: '新宿三井ビル', x: -320, z: 40, w: 65, d: 50, h: 225 },
      { name: '住友ビル', x: -210, z: -40, w: 60, d: 60, h: 200 },
      { name: 'パークタワー', x: -420, z: 260, w: 55, d: 55, h: 235 },
      { name: '新宿駅', x: 60, z: 420, w: 130, d: 60, h: 38 },
      { name: '歌舞伎町タワー', x: 430, z: -260, w: 50, d: 45, h: 225 },
      { name: 'ルミネ・バスタ', x: 90, z: 500, w: 80, d: 50, h: 75 },
    ],
  },
  kasuga: {
    core: { x: 0, z: 100 },
    landmarks: [
      { name: '春日駅', x: 0, z: 0, w: 90, d: 55, h: 25 },
      { name: '後楽園駅', x: -131, z: 154, w: 70, d: 45, h: 20 },
      { name: '文京シビックセンター', x: -60, z: 127, w: 55, d: 45, h: 142 },
      { name: '東京ドームホテル', x: -170, z: 245, w: 50, d: 40, h: 155 },
      { name: 'ラクーア', x: -105, z: 310, w: 80, d: 60, h: 58 },
      { name: '東京ドーム', x: -101, z: 398, w: 150, d: 110, h: 56, pts: ellipsePts(-101, 398, 80, 58) },
      { name: '水道橋駅', x: 135, z: 711, w: 80, d: 40, h: 18 },
      { name: '文京ガーデンゲートタワー', x: -231, z: -268, w: 45, d: 40, h: 110 },
    ],
  },
};
export const LANDMARKS = STAGES.shinjuku.landmarks;

function landmarksIn(st, cx, cz) {
  return st.landmarks.filter(lm => lm.x >= cx && lm.x < cx + TILE && lm.z >= cz && lm.z < cz + TILE);
}

// 屋上構造物: 塔屋（ペントハウス）・室外機ボックス・貯水タンクを屋根の内側に置く。
// 構造物も shape として返す（h=天端, y0=屋根面）ので、描画も当たり判定も本体と同じ経路。
function polyArea(pts) { let a = 0; for (let i = 0; i < pts.length; i += 2) { const j = (i + 2) % pts.length; a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1]; } return Math.abs(a) / 2; }
export function addRooftopProps(shapes, realCentroids = []) {
  const extra = [];
  for (const s of shapes) {
    if (s.prop || s.c === 6 || s.h - (s.y0 || 0) < 11) continue;
    if (realCentroids.some(([px, pz]) => pointInPolygon(px, pz, s.pts))) continue; // 実物がある建物には創作を置かない
    const area = polyArea(s.pts);
    if (area < 90) continue;
    const cx = s.x + s.w / 2, cz = s.z + s.d / 2;
    const h1 = hash2(Math.round(cx * 2), Math.round(cz * 2)), h2 = hash2(Math.round(cz * 2), Math.round(cx * 2));
    const cornersIn = (bx, bz, hw, hd) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([a, b]) => pointInPolygon(bx + a * hw, bz + b * hd, s.pts));
    const tryBox = (bx, bz, bw, bd, ph) => {
      if (!cornersIn(bx, bz, bw / 2, bd / 2)) return false;
      extra.push({ pts: rectShape(bx - bw / 2, bz - bd / 2, bw, bd, 0, 7).pts, h: s.h + ph, y0: s.h, c: 7, prop: true, x: bx - bw / 2, z: bz - bd / 2, w: bw, d: bd });
      return true;
    };
    if (area >= 220) { // 塔屋
      const pw = Math.min(8, s.w * 0.42), pd = Math.min(7, s.d * 0.42), ph = 2.6 + h1 * 1.2;
      if (!tryBox(cx + (h1 - 0.5) * s.w * 0.3, cz + (h2 - 0.5) * s.d * 0.3, pw, pd, ph)) tryBox(cx, cz, pw, pd, ph);
    }
    const nH = area >= 150 ? 1 + Math.floor(h2 * 3) : 1; // 室外機
    for (let i = 0; i < nH; i++) {
      const fx = ((h1 * 7 + i * 0.37) % 1 - 0.5) * 0.6, fz = ((h2 * 5 + i * 0.53) % 1 - 0.5) * 0.6;
      tryBox(cx + fx * s.w, cz + fz * s.d, 1.6 + h1 * 1.4, 1.6 + h2 * 1.2, 1.1 + h2 * 0.5);
    }
    if (s.h - (s.y0 || 0) <= 45 && h1 < 0.3 && area >= 130) { // 貯水タンク（八角柱）
      const tx = cx + (h2 - 0.5) * s.w * 0.4, tz = cz + (h1 - 0.5) * s.d * 0.4, r = 1.7 + h2 * 0.5;
      if (cornersIn(tx, tz, r * 0.8, r * 0.8)) { const sh = shapeFromPts(ellipsePts(tx, tz, r, r, 8), s.h + 2.4 + h1, 7); sh.y0 = s.h; sh.prop = true; extra.push(sh); }
    }
  }
  shapes.push(...extra);
  return shapes;
}

// タイル(tx,tz)の建物を生成する。実運用では fetch(`tiles/${tx}_${tz}.mvt`) の置き換え点。
export function generateTile(tx, tz, stage = 'shinjuku') {
  const st = STAGES[stage] || STAGES.shinjuku;
  const cx = tx * TILE, cz = tz * TILE;
  const landmarks = landmarksIn(st, cx, cz);
  const roads = (ROADS[stage] || {})[tx + ',' + tz] || [];
  const proads = (PROADS[stage] || {})[tx + ',' + tz] || null;
  const proadsAux = (PROADS_AUX[stage] || {})[tx + ',' + tz] || null;
  const fp = (FOOTPRINTS[stage] || {})[tx + ',' + tz];
  if (fp && fp.length) { // 実建物の輪郭があるタイル
    const shapes = fp.map(shapeFromFlat);
    for (const lm of landmarks) shapes.push(landmarkShape(lm));
    const count = shapes.length;
    applyTerrain(shapes, stage); // 以後 s.h は屋根の絶対Y、s.y0 は土台
    // PLATEAU LOD2 の実在の屋上構造物（flat の top/base は地表基準の相対値 →
    // 親ビルの屋根（絶対Y）の上に「屋根からの高さ」分だけ載せる）
    const realProps = ((ROOFTOPS[stage] || {})[`${tx},${tz}`] || []).map(flat => {
      const top = flat[flat.length - 2], base = flat[flat.length - 1];
      const sh = shapeFromPts(flat.slice(0, -2), top, 7);
      const pcx = sh.x + sh.w / 2, pcz = sh.z + sh.d / 2;
      let best = null;
      for (const s of shapes) { if (!s.prop && pointInPolygon(pcx, pcz, s.pts) && (!best || Math.abs((s.h - (s.ground || 0)) - base) < Math.abs((best.h - (best.ground || 0)) - base))) best = s; }
      sh.y0 = best ? best.h : base; sh.prop = true;
      sh.h = sh.y0 + Math.max(0.3, top - base);
      return sh;
    }).filter(p => p.h > p.y0 + 0.2);
    shapes.push(...realProps);
    const realC = realProps.map(p => [p.x + p.w / 2, p.z + p.d / 2]);
    addRooftopProps(shapes, realC);
    return { tx, tz, shapes, landmarks, roads, proads, proadsAux, count, bytes: tileBytes(shapes), real: true };
  }
  // 手続き生成（矩形フットプリント）
  const rand = rng((tx * 73856093) ^ (tz * 19349663) ^ (stage === 'kasuga' ? 0x51ab3 : 0x9e3779b9));
  const shapes = [];
  const block = 75, road = 14;
  for (let bx = 0; bx < 4; bx++) for (let bz = 0; bz < 4; bz++) {
    const ox = cx + bx * block, oz = cz + bz * block;
    const distC = Math.hypot(ox + block / 2 - st.core.x, oz + block / 2 - st.core.z);
    const core = Math.exp(-distC / 1100); // 中心ほど高い・密
    const n = rand() < 0.25 + core * 0.6 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const w = 16 + rand() * 26, d = 16 + rand() * 26;
      const x = ox + road + rand() * Math.max(4, block - road - w - 4);
      const z = oz + road + rand() * Math.max(4, block - road - d - 4);
      const h = Math.round((10 + Math.pow(rand(), 1.8) * (28 + core * 150)) * 2) / 2;
      shapes.push(rectShape(x, z, w, d, h, Math.floor(rand() * 6)));
    }
  }
  for (const lm of landmarks) shapes.push(landmarkShape(lm));
  const count = shapes.length;
  applyTerrain(shapes, stage);
  addRooftopProps(shapes);
  return { tx, tz, shapes, landmarks, roads, proads, proadsAux, count, bytes: tileBytes(shapes), real: false };
}

export function buildingAt(tile, i) { return tile.shapes[i]; }
export { hash2 };
