import assert from 'node:assert';
import { generateTile, buildingAt, TILE } from '../src/city-data.js';
import { TileStreamer } from '../src/tile-streamer.js';
import { stepSwing, pickAnchor, collideBuildings, stepClimb } from '../src/swing.js';

// city-data: 決定的・フットプリント形状・ランドマーク
const t1 = generateTile(0, 0), t2 = generateTile(0, 0);
assert.deepEqual(t1.shapes.map(s => s.pts), t2.shapes.map(s => s.pts), 'same tile = same shapes');
assert(t1.count > 20 && t1.count < 400, 'building count sane: ' + t1.count);
const lm = generateTile(-1, -1); // 都庁 (-260,-140) はタイル(-1,-1)
assert(lm.landmarks.some(l => l.name === '東京都庁' && l.h === 243), 'Tocho landmark present');
const b0 = buildingAt(t1, 0); assert(b0.h > 0 && b0.w > 0 && b0.d > 0 && b0.pts.length >= 8);
for (const s of t1.shapes) { // AABBが輪郭を含む
  for (let i = 0; i < s.pts.length; i += 2) assert(s.pts[i] >= s.x - 0.01 && s.pts[i] <= s.x + s.w + 0.01 && s.pts[i + 1] >= s.z - 0.01 && s.pts[i + 1] <= s.z + s.d + 0.01);
}
console.log(`city-data ok: ${t1.count} buildings/tile, ${t1.bytes} bytes/tile, real=${t1.real}`);

// streamer: 2段キャッシュ
const expanded = [], disposed = [];
const st = new TileStreamer({ loadRadius: 1, rawCacheMax: 121, onExpand: t => { expanded.push(t); return { tile: t, buildings: [] }; }, onDispose: h => disposed.push(h) });
st.update(10, 10, 0, -1);
await new Promise(r => setTimeout(r, 30));
assert.equal(st.expanded.size, 9, '3x3 expanded around start, got ' + st.expanded.size);
const fetches1 = st.stats.fetches; assert.equal(fetches1, 9);
st.update(10, 10, 0, -1); assert.equal(st.stats.fetches, fetches1, 'no refetch on same tile');
st.update(TILE * 3 + 10, 10, 1, 0); // 3タイル東へ
await new Promise(r => setTimeout(r, 30));
assert.equal(st.expanded.size, 9, 'still 3x3 after move');
assert(disposed.length >= 9, 'old tiles disposed: ' + disposed.length);
assert.equal(st.stats.fetches, 18, 'move to disjoint area fetched 9 more');
st.update(10, 10, 0, -1); // 戻る: 生データキャッシュから展開 (fetch増えない)
await new Promise(r => setTimeout(r, 30));
assert.equal(st.stats.fetches, 18, 'return trip served from raw cache, fetches=' + st.stats.fetches);
assert(st.stats.cacheHits >= 9, 'cache hits recorded: ' + st.stats.cacheHits);
console.log(`streamer ok: fetches=${st.stats.fetches} hits=${st.stats.cacheHits} expands=${st.stats.expands} disposes=${st.stats.disposes}`);

// swing physics: 振り子はロープ長を超えず、落下で加速する
const s = { p: { x: 0, y: 50, z: 0 }, v: { x: 10, y: 0, z: 0 }, anchor: { x: 0, y: 90, z: 0 }, rope: 40 };
let minY = 1e9;
for (let i = 0; i < 600; i++) { stepSwing(s, 1 / 60); const d = Math.hypot(s.p.x, s.p.y - 90, s.p.z); assert(d <= 40.01, 'rope constraint'); minY = Math.min(minY, s.p.y); }
assert(minY > 49 && minY < 52, 'pendulum bottom near rope length below anchor: ' + minY);
const a = pickAnchor({ x: 0, y: 80, z: 0 }, { x: 0, z: -1 }, [{ x: -10, z: -120, w: 20, d: 20, h: 120 }, { x: -10, z: 120, w: 20, d: 20, h: 200 }]);
assert(a && a.y === 120, 'anchor picks tall building ahead, not behind');
const low = pickAnchor({ x: 0, y: 10, z: 0 }, { x: 0, z: -1 }, [{ x: -10, z: -120, w: 20, d: 20, h: 120 }]);
assert(low && low.ropeTarget < low.rope && low.y - low.ropeTarget >= 6, 'low start gets a reel-in target that lifts the pendulum bottom');
// reel-in: ロープが目標長まで縮む
const rs = { p: { x: 0, y: 50, z: 0 }, v: { x: 8, y: 0, z: 0 }, anchor: { x: 0, y: 110, z: 0 }, rope: 62, ropeTarget: 40 };
for (let i = 0; i < 120; i++) stepSwing(rs, 1 / 60);
assert(rs.rope === 40, 'rope reeled in to target: ' + rs.rope);
const p = { x: 5, y: 30, z: 5 }, v = { x: 0, y: -5, z: 0 };
collideBuildings(p, v, [{ x: 0, z: 0, w: 20, d: 20, h: 30 }], 1.2, 1.0);
assert.equal(p.y, 31, 'lands on roof');
// 壁ヒット → クライム → 屋上へ
const wp = { x: -1, y: 10, z: 10 }, wv = { x: 18, y: -2, z: 0 };
const wb = { x: 0, z: 0, w: 20, d: 20, h: 40 };
const hit = collideBuildings(wp, wv, [wb], 1.2, 1.0);
assert(hit.wall && hit.wall.nx === -1 && hit.wall.impact === 18, 'wall hit detected with normal+impact');
const cs = { p: wp, v: wv, climb: { b: wb, nx: -1, nz: 0, speed: 17, entrySpeed: 18, heading: { x: 1, z: 0 } } };
let res = null; for (let i = 0; i < 600 && !res; i++) { const r = stepClimb(cs, 1 / 60); if (r === 'topped') res = r; assert.equal(cs.p.x, -1.2, 'stays pinned to the wall face'); }
assert.equal(res, 'topped', 'climbs to the rooftop');
assert.equal(cs.p.y, 41, 'ends standing on the roof');
assert(cs.v.x >= 12 && cs.v.y === 7, 'launches forward off the roof');
console.log('swing ok');

// labels: OSM実データの件数・座標・方角
const { LABELS } = await import('../src/labels.js');
assert.equal(LABELS.length, 46, 'label count');
const kinds = {}; for (const l of LABELS) { kinds[l.kind] = (kinds[l.kind] || 0) + 1; assert(Number.isFinite(l.x) && Number.isFinite(l.z) && Math.abs(l.x) < 2600 && Math.abs(l.z) < 2600, 'label coord sane: ' + l.name); }
assert.deepEqual(kinds, { station: 18, crossing: 14, street: 14 });
const sanchome = LABELS.find(l => l.kind === 'station' && l.name === '新宿三丁目');
assert(sanchome.x > 60 && sanchome.z < 420, 'Shinjuku-sanchome is east-north of Shinjuku station');
const tochoeki = LABELS.find(l => l.kind === 'station' && l.name === '都庁前');
assert(tochoeki.x < 0, 'Tocho-mae is west');
console.log('labels ok:', JSON.stringify(kinds));

// kasuga stage: ラベルとランドマークと streamer.clear
const { LABELS_BY_STAGE } = await import('../src/labels.js');
const K = LABELS_BY_STAGE.kasuga;
assert.equal(K.length, 28, 'kasuga label count');
assert(K.some(l => l.kind === 'street' && l.name === '春日通り'), 'Kasuga-dori present');
const hakusan = K.find(l => l.kind === 'station' && l.name === '白山');
assert(hakusan.z < -1000, 'Hakusan station is far north');
const kt = generateTile(0, 0, 'kasuga'); // 春日駅(0,0)はタイル(0,0)
assert(kt.landmarks.some(l => l.name === '春日駅'), 'Kasuga station landmark in tile 0,0');
const ktc = generateTile(-1, 0, 'kasuga'); // 文京シビックセンター(-60,127)はタイル(-1,0)
assert(ktc.landmarks.some(l => l.name === '文京シビックセンター' && l.h === 142), 'Civic Center 142m');
const kt2 = generateTile(-1, 1, 'kasuga'); // 東京ドーム(-101,398)はタイル(-1,1)
assert(kt2.landmarks.some(l => l.name === '東京ドーム'), 'Tokyo Dome landmark');
const st2 = new TileStreamer({ loadRadius: 0, onExpand: t => ({ tile: t, buildings: [] }), onDispose: () => {} });
st2.update(0, 0, 0, -1); await new Promise(r => setTimeout(r, 10));
assert.equal(st2.expanded.size, 1); st2.clear();
assert.equal(st2.expanded.size, 0 && st2.raw.size, 0, 'streamer clear empties everything');
console.log('kasuga stage ok');

// footprints: 実形状タイルとポリゴン衝突と押し出しジオメトリ
import { pointInPolygon, nearestEdge } from '../src/swing.js';
import { rectShape } from '../src/city-data.js';
const realTiles = [];
for (let tx = -2; tx <= 2; tx++) for (let tz = -2; tz <= 2; tz++) { const t = generateTile(tx, tz, 'kasuga'); if (t.real) realTiles.push(t); }
assert(realTiles.length >= 10, 'kasuga core tiles use real footprints: ' + realTiles.length);
const nonRect = realTiles.flatMap(t => t.shapes).filter(s => s.pts.length > 8);
assert(nonRect.length > 100, 'many non-rectangle footprints: ' + nonRect.length);
console.log(`footprints ok: real tiles=${realTiles.length}, non-rect shapes=${nonRect.length}`);
// L字ビル: AABB内でも窪みは素通り、脚の上には着地する
const L = { pts: [0, 0, 40, 0, 40, 15, 15, 15, 15, 40, 0, 40], h: 30, c: 0, x: 0, z: 0, w: 40, d: 40 };
assert(pointInPolygon(7, 30, L.pts) && !pointInPolygon(30, 30, L.pts), 'L-shape inside/outside');
const pv1 = { x: 30, y: 10, z: 30 }, vv1 = { x: 0, y: 0, z: 5 };
const rc1 = collideBuildings(pv1, vv1, [L], 1.2, 1.0);
assert(!rc1.wall && pv1.z === 30, 'notch of L is passable (no wall hit)');
const pv2 = { x: 7, y: 31.5, z: 30 }, vv2 = { x: 0, y: -5, z: 0 };
const rc2 = collideBuildings(pv2, vv2, [L], 1.2, 1.0);
assert(rc2.grounded && Math.abs(pv2.y - 31) < 0.01, 'land on L leg roof');
// 斜め壁ヒット: 法線は外向きで進入速度を殺す
const pv3 = { x: 7, y: 10, z: 41 }, vv3 = { x: 0, y: 0, z: -10 };
const rc3 = collideBuildings(pv3, vv3, [L], 1.2, 1.0);
assert(rc3.wall && rc3.wall.nz === 1 && vv3.z === 0 && pv3.z >= 41.2 - 0.01, 'south wall of L pushes out +z');
// ジオメトリ: 屋根法線+Y、側面法線は水平
const { buildTileGeometry } = await import('../src/building-geometry.js');
const geos = buildTileGeometry([rectShape(0, 0, 20, 20, 30, 0), L]).filter(Boolean);
assert(geos.length >= 1, 'at least one variant geometry');
let roofOk = 0, sideOk = 0;
for (const geo of geos) {
  const nrm = geo.getAttribute('normal'), posA = geo.getAttribute('position');
  for (let i = 0; i < nrm.count; i += 3) {
    const ny = nrm.getY(i);
    if (posA.getY(i) === 30 && posA.getY(i + 1) === 30) { assert(Math.abs(ny - 1) < 0.01, 'roof normal +Y'); roofOk++; }
    else if (Math.abs(ny) < 0.01) sideOk++;
  }
}
assert(roofOk > 0 && sideOk > 0, 'geometry normals sane');
// 1階帯: 地上帯ジオメトリが分かれ、上層の側面は GF_H から始まる
const { VARIANTS, GF_H, GROUND_VARIANTS, TRIM_INDEX, PB_H } = await import('../src/building-geometry.js');
const tall = buildTileGeometry([rectShape(0, 0, 20, 20, 30, 0)]);
const groundGeos = tall.slice(VARIANTS, VARIANTS + GROUND_VARIANTS).filter(Boolean);
assert(groundGeos.length === 1, 'one ground-band geometry bucket used');
const gp = groundGeos[0].getAttribute('position');
let gMax = 0; for (let i = 0; i < gp.count; i++) gMax = Math.max(gMax, gp.getY(i));
assert(Math.abs(gMax - GF_H) < 0.01, 'ground band tops at GF_H: ' + gMax);
const facadeGeos = tall.slice(0, VARIANTS).filter(Boolean);
for (const fg of facadeGeos) { const fp2 = fg.getAttribute('position'); for (let i = 0; i < fp2.count; i++) { const y = fp2.getY(i); assert(y === 0 || y >= GF_H - 0.01 || y === 30, 'facade side verts start at GF_H, saw ' + y); } }
// 縁: パラペット帯と角柱が TRIM バケットに入る
const trim = tall[TRIM_INDEX];
assert(trim, 'trim bucket present');
const tp3 = trim.getAttribute('position');
let hasParapet = false, hasColumn = false;
for (let i = 0; i < tp3.count; i++) { const y = tp3.getY(i); if (Math.abs(y - (30 - PB_H)) < 0.01) hasParapet = true; if (y === 0) hasColumn = true; }
assert(hasParapet && hasColumn, 'parapet band + corner columns present');
console.log('polygon collision + geometry ok');

// roads: OSM実道路がタイルに入っている
const { ROADS } = await import('../src/roads.js');
const kSegs = Object.values(ROADS.kasuga).reduce((a, t) => a + t.length, 0);
const sSegs = Object.values(ROADS.shinjuku).reduce((a, t) => a + t.length, 0);
assert(kSegs > 5000 && sSegs > 5000, `road segments kasuga=${kSegs} shinjuku=${sSegs}`);
const kt3 = generateTile(0, 1, 'kasuga');
assert(kt3.roads.length > 50, 'kasuga tile has road segments: ' + kt3.roads.length);
assert(kt3.roads.every(r => r[4] >= 5 && r[4] <= 16), 'road widths sane');
console.log(`roads ok: kasuga=${kSegs} shinjuku=${sSegs} segments`);

// 屋上構造物: 大きめの建物に塔屋などが付き、親の屋根の内側に収まる
const propTiles = [];
for (let tx = -1; tx <= 1; tx++) for (let tz = -1; tz <= 1; tz++) propTiles.push(generateTile(tx, tz, 'kasuga'));
const allShapes = propTiles.flatMap(t => t.shapes);
const props = allShapes.filter(s => s.prop);
assert(props.length > 100, 'rooftop props generated: ' + props.length);
for (const p of props) {
  const parent = allShapes.find(s => !s.prop && Math.abs(s.h - p.y0) < 0.01 && p.x >= s.x - 0.01 && p.z >= s.z - 0.01 && p.x + p.w <= s.x + s.w + 0.01 && p.z + p.d <= s.z + s.d + 0.01);
  assert(parent, 'prop sits on a parent roof');
  assert(p.h > p.y0 && p.h - p.y0 <= 4.5, 'prop height sane');
}
const { PROPS_INDEX } = await import('../src/building-geometry.js');
const oneTile = generateTile(0, 0, 'kasuga');
const geos2 = buildTileGeometry(oneTile.shapes);
assert(geos2[PROPS_INDEX], 'props geometry bucket produced');
console.log('rooftop props ok:', props.length);

// PLATEAU LOD2 実在の屋上構造物: 親ビルの屋根の上に載っていること
const { ROOFTOPS } = await import('../src/rooftops.js');
const { PROADS } = await import('../src/proads.js');
let realProps = 0, seated = 0, shinjukuCore = 0, outliers = 0;
for (const st of ['kasuga', 'shinjuku']) {
  for (const [key, roofs] of Object.entries(ROOFTOPS[st] || {})) {
    const [tx, tz] = key.split(',').map(Number);
    if (st === 'shinjuku' && Math.abs(tx) <= 2 && Math.abs(tz) <= 2) shinjukuCore += roofs.length;
    const t = generateTile(tx, tz, st);
    if (!t.real) continue; // 建物円盤の外のタイルは使われない
    for (const flat of roofs) {
      realProps++;
      const top = flat[flat.length - 2], base = flat[flat.length - 1];
      if (!(top > base - 3 && top - base <= 23)) outliers++; // セットバック棟など少数派は実行時にスナップで落ちる
      const px = flat.slice(0, -2).filter((_, i) => i % 2 === 0), pz = flat.slice(0, -2).filter((_, i) => i % 2 === 1);
      const cx = px.reduce((a, b) => a + b, 0) / px.length, cz = pz.reduce((a, b) => a + b, 0) / pz.length;
      if (t.shapes.some(s => s.prop && Math.abs((s.h - s.y0) - (top - base)) < 0.6 && s.y0 > 5 && Math.abs(s.x + s.w / 2 - cx) < 30 && Math.abs(s.z + s.d / 2 - cz) < 30)) seated++;
    }
  }
}
const totalReal = Object.values(ROOFTOPS.kasuga || {}).flat().length + Object.values(ROOFTOPS.shinjuku || {}).flat().length;
assert(totalReal > 6000, 'real LOD2 props total: ' + totalReal);
assert(shinjukuCore > 3000, 'real LOD2 props in shinjuku core: ' + shinjukuCore);
assert(outliers / realProps < 0.01, `real prop outliers: ${outliers}/${realProps}`);
assert(seated / realProps > 0.8, `real props seated on parents: ${seated}/${realProps}`);
console.log(`real LOD2 rooftop props ok: total ${totalReal}, attached ${realProps} (seated ${seated}), shinjuku core ${shinjukuCore}`);

// PLATEAU道路面: 駅前タイルに車道ポリゴンがあること
const stTile = generateTile(0, 0, 'kasuga');
assert(stTile.proads && stTile.proads.length > 50, 'plateau roads at kasuga station tile: ' + (stTile.proads || []).length);
console.log('plateau roads ok:', stTile.proads.length, 'polys at station tile');

// PLATEAU地形: 標高グリッドが実在の起伏を持ち、建物がその上に載ること
const { terrainH } = await import('../src/terrain-h.js');
for (const [st, sx, sz] of [['kasuga', 0, 0], ['shinjuku', 60, 420]]) {
  const h0 = terrainH(st, sx, sz);
  assert(h0 > 3 && h0 < 60, `${st} anchor elevation sane: ${h0}`);
  let mn = 1e9, mx = -1e9;
  for (let x = -1500; x <= 1500; x += 100) for (let z = -1500; z <= 1500; z += 100) { const h = terrainH(st, x, z); mn = Math.min(mn, h); mx = Math.max(mx, h); }
  assert(mx - mn > 12, `${st} has real relief: ${mn.toFixed(1)}..${mx.toFixed(1)}`);
  console.log(`terrain ${st}: anchor ${h0.toFixed(1)}m, relief ${mn.toFixed(1)}..${mx.toFixed(1)}m`);
}
const terrTile = generateTile(-1, 0, 'kasuga');
for (const s of terrTile.shapes) {
  if (s.prop) continue;
  assert(s.y0 !== undefined && s.ground !== undefined, 'shape carries terrain base');
  assert(s.y0 < s.ground && s.h > s.ground, 'building embedded below and rising above terrain');
}
const civic = terrTile.shapes.find(s => !s.prop && Math.abs((s.h - s.ground) - 142) < 1 && s.w > 40);
assert(civic, 'Civic Center stands 142m above its terrain');
const ep = { x: 0, y: 20, z: 0 }, ev = { x: 0, y: -5, z: 0 };
const gr = collideBuildings(ep, ev, [], 1.2, 1.0, 25);
assert(gr.grounded && ep.y === 26, 'ground collision respects terrain height');
console.log('terrain ok');
console.log('ALL PASS');
