// swing.js — 振り子スイング物理 + オートのアンカー選択（Three非依存, テスト可能）
export const GRAV = -24;

export function stepSwing(s, dt) {
  // s: {p:{x,y,z}, v:{x,y,z}, anchor:null|{x,y,z}, rope:0, ropeTarget?:number}
  if (s.anchor && s.ropeTarget && s.rope > s.ropeTarget) s.rope = Math.max(s.ropeTarget, s.rope - 35 * dt); // 糸を巻き取って上昇する
  s.v.y += GRAV * dt;
  s.v.x *= (1 - 0.06 * dt); s.v.z *= (1 - 0.06 * dt); // 空気抵抗わずか
  s.p.x += s.v.x * dt; s.p.y += s.v.y * dt; s.p.z += s.v.z * dt;
  if (s.anchor) {
    const dx = s.p.x - s.anchor.x, dy = s.p.y - s.anchor.y, dz = s.p.z - s.anchor.z;
    const dist = Math.hypot(dx, dy, dz) || 1e-6;
    if (dist > s.rope) {
      const nx = dx / dist, ny = dy / dist, nz = dz / dist;
      s.p.x = s.anchor.x + nx * s.rope; s.p.y = s.anchor.y + ny * s.rope; s.p.z = s.anchor.z + nz * s.rope;
      const vr = s.v.x * nx + s.v.y * ny + s.v.z * nz;
      if (vr > 0) { s.v.x -= nx * vr; s.v.y -= ny * vr; s.v.z -= nz * vr; }
    }
  }
  return s;
}

// 前方の高い建物の屋上端をアンカーに選ぶ。buildings: {x,z,w,d,h}（x,zは南西角）
export function pickAnchor(p, dir, buildings, maxDist = 170) {
  let best = null, bestScore = -1e9;
  for (const b of buildings) {
    const cx = b.x + b.w / 2, cz = b.z + b.d / 2;
    const tx = cx - p.x, tz = cz - p.z, dist = Math.hypot(tx, tz);
    if (dist < 25 || dist > maxDist) continue;
    const ahead = (tx * dir.x + tz * dir.z) / (dist || 1);
    if (ahead < 0.25) continue;
    const ay = b.h; if (ay < p.y + 12) continue; // 自分より十分高い屋上だけ
    const dist3 = Math.hypot(dist, ay - p.y), rope = Math.max(20, dist3 * 0.98);
    if (rope > 190) continue;              // 長すぎる糸は振りが緩む
    // 最下点が地面に埋まる組み合わせは、糸を巻き取る前提で許可する (ropeTarget で底上げ)
    const ropeTarget = Math.min(rope, Math.max(20, ay - 6));
    const score = ahead * 60 + Math.min(ay, 180) * 0.5 - dist * 0.35;
    if (score > bestScore) { bestScore = score; best = { x: cx, y: ay, z: cz, rope, ropeTarget }; }
  }
  if (!best) return null;
  // ロープは「今の3次元距離」基準にしないと装着した瞬間に位置が跳ぶ
  return { x: best.x, y: best.y, z: best.z, rope: best.rope, ropeTarget: best.ropeTarget };
}

// 多角形フットプリント: 点が内側か（レイキャスティング）
export function pointInPolygon(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i], zi = pts[i + 1], xj = pts[j], zj = pts[j + 1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// 最近傍の辺: {d, nx, nz, px, pz, ax, az, bx, bz}（法線は外向き, px/pzは最近点, a-bは辺）
export function nearestEdge(x, z, b) {
  const pts = b.pts;
  if (b._cx === undefined) { // 重心をキャッシュ（法線の向き判定用）
    let sx = 0, sz = 0; for (let i = 0; i < pts.length; i += 2) { sx += pts[i]; sz += pts[i + 1]; }
    b._cx = sx / (pts.length / 2); b._cz = sz / (pts.length / 2);
  }
  let best = null;
  for (let i = 0; i < pts.length; i += 2) {
    const ax = pts[i], az = pts[i + 1], bx = pts[(i + 2) % pts.length], bz = pts[(i + 3) % pts.length];
    const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
    let t = ((x - ax) * ex + (z - az) * ez) / L2; t = Math.max(0, Math.min(1, t));
    const px = ax + ex * t, pz = az + ez * t;
    const d = Math.hypot(x - px, z - pz);
    if (!best || d < best.d) {
      const L = Math.sqrt(L2); let nx = ez / L, nz = -ex / L;
      if (nx * (px - b._cx) + nz * (pz - b._cz) < 0) { nx = -nx; nz = -nz; }
      best = { d, nx, nz, px, pz, ax, az, bx, bz };
    }
  }
  return best;
}

// 建物との衝突: 屋上に着地 / 側面は押し出す。b は {x,z,w,d,h} で、pts があれば多角形として判定
// （AABB内でも多角形の外は素通りできる = L字の窪みに入れる）。p は中心, r は半径, halfH は半身長。
// b.h は屋根の絶対Y、b.y0 は土台の絶対Y（地形対応）。groundH はプレイヤー位置の地表標高。
// 戻り値: { grounded, wall } — wall は側面ヒット {b, nx, nz, impact, ...}（外向き法線と進入速度）
export function collideBuildings(p, v, buildings, r = 1.2, halfH = 1.0, groundH = 0) {
  let grounded = false, wall = null;
  if (p.y - halfH <= groundH) { p.y = groundH + halfH; if (v.y < 0) v.y = 0; grounded = true; }
  for (const b of buildings) {
    if (p.x < b.x - r || p.x > b.x + b.w + r || p.z < b.z - r || p.z > b.z + b.d + r) continue;
    if (p.y + halfH <= (b.y0 || 0)) continue; // 建物の土台より下（下り坂側の空間）は素通り
    const top = b.h;
    if (b.pts) { // ---- 多角形 ----
      const inside = pointInPolygon(p.x, p.z, b.pts);
      const near = nearestEdge(p.x, p.z, b);
      if (!inside && near.d >= r) continue;
      if (p.y - halfH >= top - 0.01) { if (inside && p.y - halfH < top + 1.5 && v.y <= 0) { p.y = top + halfH; v.y = 0; grounded = true; } continue; }
      if (p.y - halfH > top - 1.6 && v.y <= 0 && inside) { p.y = top + halfH; v.y = 0; grounded = true; continue; }
      if (p.y + halfH <= top) {
        const push = inside ? near.d + r : r - near.d;
        if (push > 0) {
          const vin = -(v.x * near.nx + v.z * near.nz);
          p.x += near.nx * push; p.z += near.nz * push;
          if (vin > 0) { wall = { b, nx: near.nx, nz: near.nz, impact: vin, ax: near.ax, az: near.az, bx: near.bx, bz: near.bz, px: near.px, pz: near.pz }; v.x += near.nx * vin; v.z += near.nz * vin; }
        }
      }
      continue;
    }
    // ---- 矩形 ----
    if (p.y - halfH >= top - 0.01) { if (p.y - halfH < top + 1.5 && v.y <= 0) { p.y = top + halfH; v.y = 0; grounded = true; } continue; }
    if (p.y - halfH > top - 1.6 && v.y <= 0) { p.y = top + halfH; v.y = 0; grounded = true; continue; } // 屋上へめり込みかけたら着地
    if (p.y + halfH <= top) {
      // 側面: 最も浅い軸へ押し出す
      const pens = [p.x - (b.x - r), (b.x + b.w + r) - p.x, p.z - (b.z - r), (b.z + b.d + r) - p.z];
      const m = Math.min(...pens);
      if (m === pens[0]) { if (v.x > 0) wall = { b, nx: -1, nz: 0, impact: v.x }; p.x = b.x - r; if (v.x > 0) v.x = 0; }
      else if (m === pens[1]) { if (v.x < 0) wall = { b, nx: 1, nz: 0, impact: -v.x }; p.x = b.x + b.w + r; if (v.x < 0) v.x = 0; }
      else if (m === pens[2]) { if (v.z > 0) wall = { b, nx: 0, nz: -1, impact: v.z }; p.z = b.z - r; if (v.z > 0) v.z = 0; }
      else { if (v.z < 0) wall = { b, nx: 0, nz: 1, impact: -v.z }; p.z = b.z + b.d + r; if (v.z < 0) v.z = 0; }
    }
  }
  return { grounded, wall };
}

// 壁クライム: s.climb = {b, nx, nz, speed, entrySpeed, heading:{x,z}}
// 多角形の壁では辺 (ax,az)-(bx,bz) に沿って張り付く（辺上の位置 t は進入点で固定）
// 壁面に張り付いて上昇し、屋上に着いたら進行方向へ跳んで返す ('topped')
export function stepClimb(s, dt, r = 1.2, halfH = 1.0) {
  const c = s.climb; if (!c) return null;
  s.v.x = 0; s.v.z = 0; s.v.y = c.speed;
  s.p.y += c.speed * dt;
  if (c.ax !== undefined) {
    if (c.t === undefined) {
      const ex = c.bx - c.ax, ez = c.bz - c.az, L2 = ex * ex + ez * ez || 1e-9;
      c.t = Math.max(0, Math.min(1, ((s.p.x - c.ax) * ex + (s.p.z - c.az) * ez) / L2));
    }
    s.p.x = c.ax + (c.bx - c.ax) * c.t + c.nx * r;
    s.p.z = c.az + (c.bz - c.az) * c.t + c.nz * r;
  } else {
    if (c.nx !== 0) s.p.x = c.nx > 0 ? c.b.x + c.b.w + r : c.b.x - r;
    if (c.nz !== 0) s.p.z = c.nz > 0 ? c.b.z + c.b.d + r : c.b.z - r;
  }
  if (s.p.y - halfH >= c.b.h) {
    s.p.y = c.b.h + halfH;
    const sp = Math.max(12, (c.entrySpeed || 14) * 0.7);
    s.v.x = c.heading.x * sp; s.v.z = c.heading.z * sp; s.v.y = 7;
    s.climb = null;
    return 'topped';
  }
  return 'climbing';
}
