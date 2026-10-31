import * as THREE from 'three';
import { TILE, generateTile, STAGES } from './city-data.js';
import { buildTileGeometry } from './building-geometry.js';
import { TileStreamer } from './tile-streamer.js';
import { stepSwing, pickAnchor, collideBuildings, stepClimb } from './swing.js';
import { LABELS_BY_STAGE } from './labels.js';
import { terrainH } from './terrain-h.js';
const groundAt = (x, z) => terrainH(stage, x, z); // 現在ステージの標高

// ステージ: 既定は春日駅前。?stage=shinjuku で新宿に切替可
let stage = new URLSearchParams(location.search).get('stage');
if (!STAGES[stage]) stage = 'kasuga';
const STAGE_START = { // agl = 地表からの高さ（開始Yは地形に合わせて決める）
  shinjuku: { x: 30, z: 640, agl: 50 },
  kasuga: { x: 20, z: 430, agl: 55 },
};
const startPos = id => { const s = STAGE_START[id]; return { x: s.x, y: terrainH(id, s.x, s.z) + s.agl, z: s.z }; };
const STAGE_NAME = { shinjuku: '舞台: 新宿', kasuga: '舞台: 春日駅前（文京区）' };

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
const maxAniso = renderer.capabilities.getMaxAnisotropy();
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.getElementById('app').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b5d9);
scene.fog = new THREE.Fog(0x87b5d9, 500, 1500);
const camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 0.5, 4000);
scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x54503f, 1.15));
const sun = new THREE.DirectionalLight(0xfff2d8, 2.0); sun.position.set(-300, 500, 200); scene.add(sun);

// ---------- building materials ----------
function facadeTextures() {
  // ファサード4種を個別テクスチャ(256x256)で用意: オフィス格子 / 横帯 / 住宅 / コンクリートパネル
  // 上部5%は無地帯（屋根面のサンプリング用）。窓は明暗バラつき付きで焼き込み、品質は
  // 解像度256 + 異方性フィルタで上げる
  const C = 256;
  let seed = 12345; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const mk = draw => {
    const c = document.createElement('canvas'); c.width = c.height = C;
    const g = c.getContext('2d');
    const win = (x, y, w, h, base) => { const v = (rnd() - 0.5) * 26; g.fillStyle = `rgb(${base[0] + v | 0},${base[1] + v | 0},${base[2] + v + 8 | 0})`; g.fillRect(x, y, w, h); };
    draw(g, win);
    g.fillStyle = '#cfd4d8'; g.fillRect(0, 0, C, 13); // 無地帯
    const gr = g.createLinearGradient(0, C * 0.8, 0, C); // 足元の汚れグラデ
    gr.addColorStop(0, 'rgba(40,40,40,0)'); gr.addColorStop(1, 'rgba(40,40,40,0.18)');
    g.fillStyle = gr; g.fillRect(0, 0, C, C);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAniso; return t;
  };
  return [
    mk((g, win) => { // オフィス格子: 細かいガラス窓
      g.fillStyle = '#c3c9cf'; g.fillRect(0, 0, C, C);
      for (let y = 20; y < C - 8; y += 11) for (let x = 6; x < C - 12; x += 15) win(x, y, 11, 7, [86, 104, 122]);
    }),
    mk((g, win) => { // 横帯: 連続窓 + スパンドレル
      g.fillStyle = '#a7adb5'; g.fillRect(0, 0, C, C);
      for (let y = 18; y < C; y += 26) { g.fillStyle = '#8f959d'; g.fillRect(0, y + 13, C, 13); for (let x = 4; x < C - 8; x += 22) win(x, y, 18, 12, [70, 88, 108]); }
    }),
    mk((g, win) => { // 住宅: 小窓 + バルコニー線
      g.fillStyle = '#d6cfc2'; g.fillRect(0, 0, C, C);
      for (let y = 22; y < C - 16; y += 32) { g.fillStyle = 'rgba(90,84,74,.55)'; g.fillRect(0, y + 15, C, 3); for (let x = 10; x < C - 20; x += 34) { win(x, y, 16, 14, [92, 100, 108]); g.strokeStyle = 'rgba(60,58,52,.6)'; g.strokeRect(x, y, 16, 14); } }
    }),
    mk((g, win) => { // コンクリートパネル: 疎な窓 + 目地
      g.fillStyle = '#beb9ae'; g.fillRect(0, 0, C, C);
      g.strokeStyle = 'rgba(80,78,72,.5)'; for (let x = 0; x <= C; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, C); g.stroke(); } for (let y = 0; y <= C; y += 64) { g.beginPath(); g.moveTo(0, y); g.lineTo(C, y); g.stroke(); }
      for (let y = 26; y < C - 20; y += 42) for (let x = 18; x < C - 24; x += 52) win(x, y, 22, 18, [84, 94, 106]);
    }),
  ];
}
function groundTextures() {
  // 1階帯テクスチャ3種 (256x160 = 7m x 4.2m の立面): 店舗 / オフィスロビー / 住宅入口
  // canvas の上が帯の上端 (v=1)。看板・ガラス・入口扉・植栽まで描き込む
  const W = 256, H = 160;
  const mk = draw => {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'); draw(g);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAniso; return t;
  };
  const R = (g, x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  return [
    mk(g => { // 店舗: 看板帯 + ガラス店頭 + 両開き扉
      R(g, 0, 0, W, H, '#5d5348');
      R(g, 0, 0, W, 42, '#33404d');
      const signs = ['#c8b458', '#b4552f', '#7d9bb5', '#d8d3c8', '#5f7d5a'];
      let sx = 6; let seed = 777; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      while (sx < W - 30) { const w = 26 + rnd() * 40; R(g, sx, 8, w, 26, signs[(rnd() * signs.length) | 0]); R(g, sx + 4, 17, w - 8, 4, 'rgba(30,30,30,.45)'); sx += w + 8; }
      R(g, 0, 42, W, 5, '#20262c');
      const glass = g.createLinearGradient(0, 47, 0, 146); glass.addColorStop(0, '#4d6a72'); glass.addColorStop(0.5, '#38525a'); glass.addColorStop(1, '#2c444b');
      R(g, 0, 47, W, 99, ''); g.fillStyle = glass; g.fillRect(0, 47, W, 99);
      for (let i = 0; i < 5; i++) R(g, 14 + i * 46, 74, 34, 3, 'rgba(232,196,130,.5)'); // 店内の棚・照明
      for (let x = 0; x <= W; x += 32) R(g, x, 47, 3, 99, '#1f2a2e');
      R(g, 108, 47, 44, 99, 'rgba(240,220,170,.28)'); // 扉まわりの明かり
      R(g, 126, 47, 3, 99, '#141c1f'); R(g, 118, 96, 8, 3, '#c8c8c8'); R(g, 134, 96, 8, 3, '#c8c8c8');
      R(g, 0, 146, W, 14, '#767672'); R(g, 0, 146, W, 2, '#5a5a58');
    }),
    mk(g => { // オフィスロビー: 全面ガラス + キャノピー + 植栽
      const glass = g.createLinearGradient(0, 0, 0, H); glass.addColorStop(0, '#8fa9b4'); glass.addColorStop(0.6, '#6d8a96'); glass.addColorStop(1, '#57707c');
      g.fillStyle = glass; g.fillRect(0, 0, W, H);
      for (let i = 0; i < 4; i++) R(g, 18 + i * 58, 16, 40, 7, 'rgba(255,244,200,.75)'); // 天井照明
      R(g, 20, 108, 60, 30, 'rgba(240,238,228,.35)'); R(g, 178, 108, 58, 30, 'rgba(240,238,228,.3)'); // ロビーの明るい床
      for (let x = 0; x <= W; x += 42) R(g, x, 0, 3, H, '#3d4c54');
      R(g, 0, 58, W, 3, '#3d4c54');
      R(g, 84, 34, 88, 9, '#2e3a41'); // キャノピー
      R(g, 126, 43, 4, 103, '#222c31');
      R(g, 0, 146, W, 14, '#6f7276');
      R(g, 6, 128, 30, 18, '#4a6741'); R(g, 220, 128, 30, 18, '#4a6741'); // 植栽
    }),
    mk(g => { // 住宅入口: 壁 + 玄関扉 + 集合ポスト + 表札
      R(g, 0, 0, W, H, '#a08e76');
      for (let y = 0; y < H; y += 8) R(g, 0, y, W, 1, 'rgba(80,66,50,.25)');
      R(g, 22, 52, 34, 42, '#5d6a72'); R(g, 200, 52, 34, 42, '#5d6a72'); // 小窓
      R(g, 22, 52, 34, 42, ''); g.strokeStyle = '#4a4238'; g.strokeRect(22, 52, 34, 42); g.strokeRect(200, 52, 34, 42);
      R(g, 96, 30, 64, 7, '#6e5f4c'); // 庇
      R(g, 104, 37, 48, 109, '#3c332a'); R(g, 109, 42, 38, 99, '#54432f'); // 玄関扉
      R(g, 141, 88, 3, 16, '#c8b458');
      R(g, 112, 14, 32, 10, '#e8e4da'); // 表札プレート
      R(g, 156, 52, 7, 12, '#2c2c30'); // インターホン
      for (let r = 0; r < 3; r++) for (let cx = 0; cx < 3; cx++) R(g, 14 + cx * 13, 106 + r * 13, 11, 11, '#7c7264'); // ポスト
      R(g, 0, 146, W, 14, '#7a766e');
      R(g, 176, 130, 26, 16, '#50683f'); R(g, 56, 132, 22, 14, '#50683f'); // 植栽
    }),
  ];
}
function trimTexture() {
  // 縁（パラペット帯・角柱）用: 明るい石材 + 細かい斑 + 上端の溝線
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); g.fillStyle = '#d6d0c0'; g.fillRect(0, 0, 128, 128);
  let seed = 999; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(${90 + rnd() * 60 | 0},${84 + rnd() * 54 | 0},${70 + rnd() * 44 | 0},.16)`; g.fillRect(rnd() * 128, rnd() * 128, 2, 2); }
  g.fillStyle = 'rgba(70,64,54,.55)'; g.fillRect(0, 6, 128, 3);
  g.fillStyle = 'rgba(70,64,54,.3)'; g.fillRect(0, 122, 128, 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAniso; return t;
}
const facadeMats = [...facadeTextures(), ...groundTextures(), trimTexture(), trimTexture()].map(t => new THREE.MeshLambertMaterial({ map: t, vertexColors: true }));
function groundTexture() {
  // 街区の地肌（道路はOSM実データで別描画するので、地面は無地寄り）
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'); g.fillStyle = '#83837d'; g.fillRect(0, 0, 256, 256);
  let seed = 4242; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 2600; i++) { g.fillStyle = `rgba(${60 + rnd() * 40 | 0},${60 + rnd() * 40 | 0},${56 + rnd() * 36 | 0},.14)`; g.fillRect(rnd() * 256, rnd() * 256, 2, 2); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// OSM道路: 区間ごとに歩道(広め・明)＋車道(暗)のリボンを地形に沿わせて敷く（長区間は分割して垂らす）
const roadMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }); // リボンの巻き方向が区間ごとに違うため両面
function roadsGeometry(segments, widen, lift, rgb) {
  const pos = [], col = [];
  const c = new THREE.Color(...rgb);
  const Y = (x, z) => groundAt(x, z) + lift;
  for (const [x0, z0, x1, z1, w] of segments) {
    const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz) || 1;
    const nx = -dz / L * (w / 2 + widen), nz = dx / L * (w / 2 + widen);
    const n = Math.max(1, Math.ceil(L / 15));
    for (let k = 0; k < n; k++) {
      const ax = x0 + dx * k / n, az = z0 + dz * k / n, ex = x0 + dx * (k + 1) / n, ez = z0 + dz * (k + 1) / n;
      const a = [ax + nx, az + nz], b = [ax - nx, az - nz], d = [ex - nx, ez - nz], e = [ex + nx, ez + nz];
      pos.push(a[0], Y(...a), a[1], b[0], Y(...b), b[1], e[0], Y(...e), e[1], b[0], Y(...b), b[1], d[0], Y(...d), d[1], e[0], Y(...e), e[1]);
      for (let i = 0; i < 6; i++) col.push(c.r, c.g, c.b);
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
// PLATEAU道路面ポリゴン: 辺を分割してから三角形分割し、地形に沿わせて敷く（法線+Yになるよう頂点順を反転）
function roadsPolyGeometry(polys, lift, rgb) {
  const pos = [], col = [];
  const c = new THREE.Color(...rgb);
  for (const flat of polys) {
    const contour = [];
    for (let i = 0; i < flat.length; i += 2) {
      const ax = flat[i], az = flat[i + 1], bx = flat[(i + 2) % flat.length], bz = flat[(i + 3) % flat.length];
      contour.push(new THREE.Vector2(ax, az));
      const L = Math.hypot(bx - ax, bz - az), n = Math.floor(L / 12);
      for (let k = 1; k <= n; k++) contour.push(new THREE.Vector2(ax + (bx - ax) * k / (n + 1), az + (bz - az) * k / (n + 1)));
    }
    if (contour.length < 3) continue;
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch { continue; }
    for (const t of tris) {
      for (const vi of [t[0], t[2], t[1]]) { const vx = contour[vi].x, vz = contour[vi].y; pos.push(vx, groundAt(vx, vz) + lift, vz); col.push(c.r, c.g, c.b); }
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
// 地形メッシュ: タイル範囲を 15m 格子で標高サンプリング（隣タイルと端の高さが一致するので継ぎ目なし）
function terrainGeometry(tile) {
  const step = 15, n = TILE / step;
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const lx = i * step, lz = j * step;
    pos.push(lx, groundAt(tile.tx * TILE + lx, tile.tz * TILE + lz), lz);
    uv.push(i / n, j / n);
    if (i < n && j < n) { const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
const groundMat = new THREE.MeshLambertMaterial({ map: groundTexture(), vertexColors: false });

function makeLabel(text, bg = 'rgba(10,20,30,.55)', worldW = 90) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 96;
  const g = c.getContext('2d'); g.font = 'bold 44px sans-serif'; g.textAlign = 'center';
  g.fillStyle = bg; const w = g.measureText(text).width + 36;
  g.fillRect(256 - w / 2, 14, w, 62); g.fillStyle = '#fff'; g.fillText(text, 256, 60);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false }));
  s.scale.set(worldW, worldW * 96 / 512, 1); return s;
}

// ---------- tile expansion (L2: GPU geometry) ----------
function expandTile(tile) {
  const group = new THREE.Group();
  const ground = new THREE.Mesh(terrainGeometry(tile), groundMat);
  ground.position.set(tile.tx * TILE, 0, tile.tz * TILE); group.add(ground);
  if (tile.proads && tile.proads.length) { // PLATEAU道路面がある所はそちら（歩道=aux / 車道）
    const aux = roadsPolyGeometry(tile.proadsAux || [], 0.18, [0.56, 0.56, 0.53]);
    if (aux) group.add(new THREE.Mesh(aux, roadMat));
    const rd = roadsPolyGeometry(tile.proads, 0.3, [0.20, 0.20, 0.22]);
    if (rd) group.add(new THREE.Mesh(rd, roadMat));
  } else if (tile.roads && tile.roads.length) { // 無い所だけOSMリボン
    const walk = roadsGeometry(tile.roads, 1.7, 0.18, [0.56, 0.56, 0.53]);
    if (walk) group.add(new THREE.Mesh(walk, roadMat));
    const road = roadsGeometry(tile.roads, 0, 0.3, [0.20, 0.20, 0.22]);
    if (road) group.add(new THREE.Mesh(road, roadMat));
  }
  buildTileGeometry(tile.shapes).forEach((geo, vi) => { if (geo) group.add(new THREE.Mesh(geo, facadeMats[vi])); }); // フットプリント多角形を押し出し
  for (const lm of tile.landmarks) { const s = makeLabel(lm.name); s.position.set(lm.x, groundAt(lm.x, lm.z) + lm.h + 16, lm.z); group.add(s); }
  scene.add(group);
  return { tile, group, buildings: tile.shapes };
}
function disposeTile(handle) {
  scene.remove(handle.group);
  handle.group.traverse(o => { if (o.isMesh && o.geometry) o.geometry.dispose(); if (o.isSprite) { o.material.map.dispose(); o.material.dispose(); } });
}

// fetch の代わりに遅延を入れて「届いてから展開」を目に見える形にする（実データでも同じ経路）
const streamer = new TileStreamer({
  loadRadius: 2, rawCacheMax: 121,
  fetchTile: async (tx, tz) => { await new Promise(r => setTimeout(r, 30 + Math.random() * 110)); return generateTile(tx, tz, stage); },
  onExpand: expandTile, onDispose: disposeTile,
});
const allBuildings = () => streamer.loadedTiles().flatMap(h => h.buildings);

// ---------- hero ----------
const hero = new THREE.Group();
{
  const red = new THREE.MeshLambertMaterial({ color: 0xc22727 }), blue = new THREE.MeshLambertMaterial({ color: 0x2244aa });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 0.9, 3, 10), red); torso.position.y = 0.35; hero.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 12), red); head.position.y = 1.45; hero.add(head);
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    eye.scale.set(1, 1.25, 0.45); eye.position.set(sx * 0.18, 1.5, 0.36); hero.add(eye);
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.85, 3, 8), blue);
    leg.position.set(sx * 0.26, -0.75, -0.15); leg.rotation.x = 0.5; hero.add(leg);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.8, 3, 8), red);
    arm.position.set(sx * 0.72, 0.55, 0); arm.rotation.z = sx * -0.7; hero.add(arm); if (sx > 0) hero.userData.armR = arm;
  }
}
scene.add(hero);
const webGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const web = new THREE.Line(webGeo, new THREE.LineBasicMaterial({ color: 0xffffff })); web.visible = false; web.frustumCulled = false; scene.add(web);

// ---------- OSM地名ラベル (© OpenStreetMap contributors, ODbL) ----------
let labelGroup = null;
function buildLabels(stageId) {
  const KIND = {
    station: { bg: 'rgba(179,39,30,.88)', y: 30, w: 62 },
    street: { bg: 'rgba(28,77,143,.85)', y: 38, w: 58 },
    crossing: { bg: 'rgba(30,122,70,.85)', y: 22, w: 46 },
  };
  const group = new THREE.Group();
  const poleGeo = new THREE.CylinderGeometry(0.35, 0.35, 1, 6);
  const poleMat = new THREE.MeshLambertMaterial({ color: 0xb3271e });
  const seen = new Map(); // 近い位置のラベルは縦にずらして重なり回避
  for (const lb of LABELS_BY_STAGE[stageId] || []) {
    const k = KIND[lb.kind]; if (!k) continue;
    const cell = Math.round(lb.x / 70) + ',' + Math.round(lb.z / 70);
    const n = seen.get(cell) || 0; seen.set(cell, n + 1);
    const gy = groundAt(lb.x, lb.z);
    const s = makeLabel(lb.name, k.bg, k.w + lb.name.length * 4);
    s.position.set(lb.x, gy + k.y + n * 13, lb.z); group.add(s);
    if (lb.kind === 'station') { const pole = new THREE.Mesh(poleGeo, poleMat); pole.scale.y = k.y - 4; pole.position.set(lb.x, gy + (k.y - 4) / 2, lb.z); group.add(pole); }
  }
  return group;
}
function refreshLabels() {
  if (labelGroup) { scene.remove(labelGroup); labelGroup.traverse(o => { if (o.isSprite) { o.material.map.dispose(); o.material.dispose(); } }); }
  labelGroup = buildLabels(stage); scene.add(labelGroup);
}

// ---------- game state ----------
const S = { p: startPos(stage), v: { x: 0, y: 0, z: -14 }, anchor: null, rope: 0, ropeTarget: null, climb: null };
let heading = { x: 0, z: -1 }, auto = true, cooldown = 0, swingTime = 0;
const keys = {};
addEventListener('keydown', e => { keys[e.code] = true; if (e.code === 'KeyA') toggleAuto(); if (e.code === 'Space') e.preventDefault(); });
addEventListener('keyup', e => { keys[e.code] = false; if (e.code === 'Space' && !auto) release(); });
let touching = false;
addEventListener('touchstart', () => touching = true, { passive: true });
addEventListener('touchend', () => { touching = false; if (!auto) release(); }, { passive: true });
function toggleAuto() { auto = !auto; document.getElementById('autoBtn').textContent = auto ? 'AUTO: ON' : 'AUTO: OFF'; if (auto) release(); }
document.getElementById('autoBtn').addEventListener('click', toggleAuto);

function attach(a) { S.anchor = { x: a.x, y: a.y, z: a.z }; S.rope = a.rope; S.ropeTarget = a.ropeTarget ?? null; swingTime = 0; }
function release(boost = 1) { if (S.anchor) { S.v.x *= boost; S.v.z *= boost; S.v.y *= 0.92; } S.anchor = null; S.ropeTarget = null; cooldown = 0.38; }

function autoLogic(dt, buildings) {
  cooldown -= dt;
  if (S.anchor) {
    swingTime += dt;
    const tx = S.anchor.x - S.p.x, tz = S.anchor.z - S.p.z, d = Math.hypot(tx, tz) || 1;
    const behind = (tx * heading.x + tz * heading.z) / d;
    if ((behind < -0.12 && S.v.y > -6 && swingTime > 0.5) || swingTime > 3.2) release(1.06);
  } else if (cooldown <= 0) {
    const a = pickAnchor(S.p, heading, buildings);
    if (a && (S.p.y - groundAt(S.p.x, S.p.z) > 22 || S.v.y < -4)) attach(a);
  }
}

const camPos = new THREE.Vector3(S.p.x, S.p.y + 15, S.p.z + 55);
const clock = new THREE.Clock();
let hudTimer = 0;
// 物理は固定刻み(120Hz)で回す: フレームレートが低い環境でも挙動と実時間がずれない
function stepGame(dt, buildings) {
  if (S.climb) { // 壁クライム中は重力・スイング・オートを止めて屋上まで登る
    if (stepClimb(S, dt) === 'topped') cooldown = 0.3;
    return;
  }
  const steer = (keys.ArrowLeft || keys.KeyQ ? -1 : 0) + (keys.ArrowRight || keys.KeyE ? 1 : 0);
  if (steer && !S.anchor) { const sp = Math.hypot(S.v.x, S.v.z); const px = -heading.z * steer, pz = heading.x * steer; S.v.x += px * 26 * dt; S.v.z += pz * 26 * dt; if (sp > 1) { const s2 = Math.hypot(S.v.x, S.v.z); S.v.x *= sp / s2; S.v.z *= sp / s2; } }

  if (auto) autoLogic(dt, buildings);
  else {
    cooldown -= dt;
    if ((keys.Space || touching) && !S.anchor && cooldown <= 0) { const a = pickAnchor(S.p, heading, buildings); if (a) attach(a); }
  }

  const entryHs = Math.hypot(S.v.x, S.v.z);
  stepSwing(S, dt);
  const gHere = groundAt(S.p.x, S.p.z);
  const col = collideBuildings(S.p, S.v, buildings, 1.2, 1.0, gHere);
  const grounded = col.grounded;
  if (col.wall && col.wall.impact >= 3 && S.p.y - gHere > 3) { // 壁に当たったら屋上へ登る
    S.anchor = null; S.ropeTarget = null;
    S.climb = { b: col.wall.b, nx: col.wall.nx, nz: col.wall.nz, speed: Math.max(15, col.wall.impact * 0.85), entrySpeed: entryHs, heading: { x: heading.x, z: heading.z }, ax: col.wall.ax, az: col.wall.az, bx: col.wall.bx, bz: col.wall.bz };
    return;
  }
  if (grounded && S.p.y - gHere < 2.2) { // 地面に降りたら自動で跳んで再開（オート時）
    S.anchor = null; S.ropeTarget = null;
    if (auto) {
      // 正面が壁なら空いている方向へ向き直ってから跳ぶ（壁際で詰まらないように）
      for (const ang of [0, 0.8, -0.8, 1.6, -1.6, Math.PI]) {
        const dx = heading.x * Math.cos(ang) + heading.z * Math.sin(ang), dz = -heading.x * Math.sin(ang) + heading.z * Math.cos(ang);
        const px = S.p.x + dx * 9, pz = S.p.z + dz * 9;
        const blocked = buildings.some(b => b.h > S.p.y + 2 && px > b.x - 2.5 && px < b.x + b.w + 2.5 && pz > b.z - 2.5 && pz < b.z + b.d + 2.5);
        if (!blocked) { heading.x = dx; heading.z = dz; break; }
      }
      S.v.x = heading.x * 19; S.v.z = heading.z * 19; S.v.y = 17; cooldown = 0.25;
    }
    else { S.v.x *= 0.9; S.v.z *= 0.9; }
  }
  if (S.p.y < gHere + 1) S.p.y = gHere + 1;

  const hs = Math.hypot(S.v.x, S.v.z);
  if (hs > 4) { heading.x += (S.v.x / hs - heading.x) * Math.min(1, dt * 3); heading.z += (S.v.z / hs - heading.z) * Math.min(1, dt * 3); const n = Math.hypot(heading.x, heading.z); heading.x /= n; heading.z /= n; }
}
function frame() {
  requestAnimationFrame(frame);
  const buildings = allBuildings();
  const dt = Math.min(clock.getDelta(), 0.12);
  let remain = dt;
  while (remain > 0) { const h = Math.min(1 / 120, remain); stepGame(h, buildings); remain -= h; }
  const hs = Math.hypot(S.v.x, S.v.z);

  streamer.update(S.p.x, S.p.z, heading.x, heading.z);

  // hero transform: 速度方向を向いて前傾
  hero.position.set(S.p.x, S.p.y - 1, S.p.z);
  hero.rotation.set(0, Math.atan2(heading.x, heading.z), 0); // モデル正面(+Z)を進行方向へ
  hero.rotateX(THREE.MathUtils.clamp(hs * 0.012, 0, 0.65) + (S.anchor ? 0.15 : 0) + (S.climb ? -0.4 : 0)); // クライム中は壁に張り付く姿勢
  if (hero.userData.armR) hero.userData.armR.rotation.z = S.anchor ? -2.4 : -0.7;
  web.visible = !!S.anchor;
  if (S.anchor) { const pos = webGeo.attributes.position; pos.setXYZ(0, S.p.x, S.p.y + 0.6, S.p.z); pos.setXYZ(1, S.anchor.x, S.anchor.y, S.anchor.z); pos.needsUpdate = true; }

  // camera: 背後追随
  const want = new THREE.Vector3(S.p.x - heading.x * 30, S.p.y + 11, S.p.z - heading.z * 30);
  camPos.lerp(want, 1 - Math.pow(0.0015, dt));
  const camG = groundAt(camPos.x, camPos.z) + 3.5;
  if (camPos.y < camG) camPos.y = camG;
  camera.position.copy(camPos);
  camera.lookAt(S.p.x + heading.x * 24, S.p.y + 2, S.p.z + heading.z * 24);

  hudTimer -= dt; if (hudTimer <= 0) { hudTimer = 0.25; updateHUD(hs); }
  renderer.render(scene, camera);
}
function updateHUD(hs) {
  const st = streamer.stats;
  document.getElementById('hud').textContent =
    `速度 ${Math.round(hs * 3.6)} km/h / 高度 ${Math.max(0, Math.round(S.p.y - 1 - groundAt(S.p.x, S.p.z)))} m\n` +
    `タイル 展開${streamer.expanded.size} / 生データ${streamer.raw.size} / 取得中${streamer.pending.size}\n` +
    `fetch ${st.fetches} 回 / キャッシュヒット ${st.cacheHits} / 建物 ${streamer.loadedTiles().reduce((a, h) => a + h.tile.count, 0)} 棟`;
  const g = document.getElementById('map').getContext('2d'); const N = 11, cell = 10;
  g.clearRect(0, 0, 110, 110);
  const [ctx, ctz] = streamer.tileOf(S.p.x, S.p.z);
  for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) {
    const k = streamer.key(ctx + dx, ctz + dz);
    g.fillStyle = streamer.expanded.has(k) ? '#39d353' : streamer.raw.has(k) ? '#d8b93a' : streamer.pending.has(k) ? '#e07b39' : '#26303a';
    g.fillRect((dx + 5) * cell + 1, (dz + 5) * cell + 1, cell - 2, cell - 2);
  }
  g.fillStyle = '#fff'; g.beginPath(); g.arc(55, 55, 3.4, 0, 7); g.fill();
}
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
function setStage(id) {
  if (!STAGES[id]) return;
  stage = id;
  streamer.clear();
  refreshLabels();
  const st = startPos(id);
  S.p = { ...st }; S.v = { x: 0, y: 0, z: -14 }; S.anchor = null; S.ropeTarget = null; S.climb = null;
  heading = { x: 0, z: -1 };
  camPos.set(st.x, st.y + 15, st.z + 55);
  document.getElementById('stageName').textContent = STAGE_NAME[id];
  document.querySelectorAll('[data-stage]').forEach(b => b.classList.toggle('active', b.dataset.stage === id));
  streamer.update(S.p.x, S.p.z, 0, -1);
}
document.querySelectorAll('[data-stage]').forEach(b => b.addEventListener('click', () => setStage(b.dataset.stage)));
setStage(stage);
if (new URLSearchParams(location.search).has('debug')) window.__ts = { S, streamer, scene, camera }; // 検証用フック
frame();
