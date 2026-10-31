# tools/build-footprints.py — 実建物の輪郭+高さから src/footprints.js を生成する。
# 優先順位: PLATEAU CityGML（実測高さ measuredHeight + 輪郭, ~/workspace/.osm-raw/plateau.jsonl,
#   生成は tools/fetch_plateau.py）を最優先し、PLATEAUに無い建物だけ OSM で補う
#   （重心12m以内にPLATEAU建物があれば OSM 側を捨てる）。
# OSMのみの建物の高さはタグ優先、無ければ種別・面積から推定。
# タイル(300m)ごとに重心で振り分け、0.5m量子化。ランドマーク矩形と重なる建物は除外。
# 出典: PLATEAU（国土交通省）/ © OpenStreetMap contributors (ODbL)
import json, math, glob, os

MX, MZ, TILE = 90403, 110960, 300
LANDMARKS = {
    'shinjuku': [(-260, -140, 90, 70), (520, 620, 55, 55), (-140, 60, 60, 55), (-60, 300, 45, 40),
                 (-320, 40, 65, 50), (-210, -40, 60, 60), (-420, 260, 55, 55), (60, 420, 130, 60),
                 (430, -260, 50, 45), (90, 500, 80, 50)],
    'kasuga': [(0, 0, 90, 55), (-131, 154, 70, 45), (-60, 127, 55, 45), (-170, 245, 50, 40),
               (-105, 310, 80, 60), (-101, 398, 150, 110), (135, 711, 80, 40), (-231, -268, 45, 40)],
}
ANCHORS = {'kasuga': ((35.70919, 139.75296), (0, 0)), 'shinjuku': ((35.68950, 139.70049), (60, 420))}
CORES = {'kasuga': (0, 0), 'shinjuku': (60, 420)}  # 採用円盤の中心はPLATEAU取得円盤（アンカー）と一致させる

def h2(n):
    x = (n * 2654435761) & 0xffffffff
    x ^= x >> 13; x = (x * 1274126177) & 0xffffffff; x ^= x >> 16
    return x / 4294967296

def simplify(pts):
    # 連続重複とほぼ一直線の中間点を落とす
    out = []
    for p in pts:
        if not out or abs(p[0] - out[-1][0]) > 0.01 or abs(p[1] - out[-1][1]) > 0.01: out.append(p)
    if len(out) > 1 and out[0] == out[-1]: out.pop()
    changed = True
    while changed and len(out) > 3:
        changed = False
        nxt = []
        for i, p in enumerate(out):
            a, b = out[i - 1], out[(i + 1) % len(out)]
            cross = abs((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]))
            seg = math.hypot(b[0] - a[0], b[1] - a[1]) or 1
            if cross / seg < 0.35 and len(out) > 3: changed = True; continue
            nxt.append(p)
        out = nxt
    return out

PLATEAU_JSONL = os.path.expanduser('~/workspace/.osm-raw/plateau.jsonl')

def load_plateau(stage):
    """PLATEAU実測データ → [(pts, h)] （ゲーム座標）。無ければ空。"""
    (alat, alon), (gx, gz) = ANCHORS[stage]
    out = []
    if not os.path.exists(PLATEAU_JSONL): return out
    seen = set()
    for line in open(PLATEAU_JSONL):
        d = json.loads(line)
        if d['s'] != stage: continue
        key = (d['ring'][0][0], d['ring'][0][1], d['h'], len(d['ring']))
        if key in seen: continue  # 隣接区のzipに同じメッシュが重複収録されるケース
        seen.add(key)
        pts = [(gx + (lo - alon) * MX, gz + (alat - la) * MZ) for la, lo in d['ring']]
        if len(pts) > 1 and pts[0] == pts[-1]: pts.pop()
        out.append((pts, d['h']))
    return out

def process(stage, files):
    (alat, alon), (gx, gz) = ANCHORS[stage]
    core = CORES[stage]
    tiles = {}
    # --- PLATEAU（実測）を先に確定させる ---
    plat_shapes = []  # (flat, cx, cz)
    plat_grid = {}
    plat_cells = {}   # 100mセル → AABBが重なるPLATEAU輪郭（重心内包判定用）
    for pts, h in load_plateau(stage):
        cx = sum(p[0] for p in pts) / len(pts); cz = sum(p[1] for p in pts) / len(pts)
        if math.hypot(cx - core[0], cz - core[1]) > 1500: continue
        if any(abs(cx - lx) < lw / 2 + 6 and abs(cz - lz) < ld / 2 + 6 for lx, lz, lw, ld in LANDMARKS[stage]): continue
        pts = simplify(pts)
        if len(pts) < 3: continue
        area = abs(sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))) / 2
        if area < 16: continue
        c = int(h2((int(cx * 2) * 73856093) ^ (int(cz * 2) * 19349663)) * 6)
        flat = []
        for x, z in pts: flat += [round(x * 2) / 2, round(z * 2) / 2]
        flat += [round(max(2.5, min(h, 400.0)) * 2) / 2, c]
        plat_shapes.append((flat, cx, cz))
        plat_grid.setdefault((int(cx // 10), int(cz // 10)), []).append((cx, cz))
        xs = [p[0] for p in pts]; zs = [p[1] for p in pts]
        for cellx in range(int(min(xs) // 100), int(max(xs) // 100) + 1):
            for cellz in range(int(min(zs) // 100), int(max(zs) // 100) + 1):
                plat_cells.setdefault((cellx, cellz), []).append(pts)
    def pip(px, pz, pts):  # レイキャスティング
        inside = False
        for i in range(len(pts)):
            x1, z1 = pts[i]; x2, z2 = pts[(i + 1) % len(pts)]
            if (z1 > pz) != (z2 > pz) and px < (x2 - x1) * (pz - z1) / (z2 - z1) + x1: inside = not inside
        return inside
    def near_plateau(cx, cz):
        for gx2 in range(int((cx - 12) // 10), int((cx + 12) // 10) + 1):
            for gz2 in range(int((cz - 12) // 10), int((cz + 12) // 10) + 1):
                for px, pz in plat_grid.get((gx2, gz2), []):
                    if math.hypot(px - cx, pz - cz) < 12: return True
        # 大規模複合施設はPLATEAU側が分割されていて重心が離れる → 内包でも重複とみなす
        for pts in plat_cells.get((int(cx // 100), int(cz // 100)), []):
            if pip(cx, cz, pts): return True
        return False
    seen_ids = set(); total = 0; tagged_h = 0; osm_kept = 0; osm_dropped = 0
    for f in files:
        for e in json.load(open(f))['elements']:
            if e['id'] in seen_ids: continue
            seen_ids.add(e['id'])
            g = e.get('geometry') or []
            if len(g) < 3: continue
            pts = [(gx + (p['lon'] - alon) * MX, gz + (alat - p['lat']) * MZ) for p in g]
            cx = sum(p[0] for p in pts) / len(pts); cz = sum(p[1] for p in pts) / len(pts)
            if math.hypot(cx - core[0], cz - core[1]) > 1500: continue
            if any(abs(cx - lx) < lw / 2 + 6 and abs(cz - lz) < ld / 2 + 6 for lx, lz, lw, ld in LANDMARKS[stage]): continue
            pts = simplify(pts)
            if len(pts) < 3: continue
            area = abs(sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))) / 2
            if area < 25: continue
            t = e.get('tags', {})
            btype = t.get('building', 'yes')
            h = None
            if t.get('height'):
                try: h = float(str(t['height']).replace('m', '').strip())
                except ValueError: h = None
            if h is None and t.get('building:levels'):
                try: h = float(t['building:levels']) * 3.1 + 2
                except ValueError: h = None
            if h is not None: tagged_h += 1
            SMALL = {'house', 'detached', 'residential', 'terrace', 'bungalow', 'cabin', 'semidetached_house', 'farm', 'hut', 'garage', 'garages', 'shed', 'roof', 'carport'}
            if btype in SMALL:  # 小さな建物は小さく（タグ高さがあっても住宅スケールに丸める）
                h = min(h if h is not None else 8.0, 6.0 + h2(e['id'] ^ 0x77) * 3.5)
            elif h is None:  # 面積ベースの推定: 小さい平面は低い
                if area < 110: h = 5.5 + h2(e['id']) * 3.5
                elif area < 240: h = 8 + h2(e['id']) * 5
                else:
                    dc = math.exp(-math.hypot(cx - core[0], cz - core[1]) / 1100)
                    h = 10 + h2(e['id']) ** 1.8 * (28 + dc * 150)
            h = round(max(4.0, min(h, 260.0)) * 2) / 2
            if plat_shapes and near_plateau(cx, cz): osm_dropped += 1; continue  # PLATEAU実測を優先
            c = int(h2(e['id'] ^ 0xabcdef) * 6)
            flat = []
            for x, z in pts: flat += [round(x * 2) / 2, round(z * 2) / 2]
            flat += [h, c]
            key = f"{math.floor(cx / TILE)},{math.floor(cz / TILE)}"
            tiles.setdefault(key, []).append(flat); total += 1; osm_kept += 1
    for flat, cx, cz in plat_shapes:
        key = f"{math.floor(cx / TILE)},{math.floor(cz / TILE)}"
        tiles.setdefault(key, []).append(flat); total += 1
    print(stage, 'buildings:', total, 'plateau:', len(plat_shapes), 'osm kept:', osm_kept, 'osm dropped(dup):', osm_dropped, 'tagged heights:', tagged_h, 'tiles:', len(tiles))
    return tiles

all_tiles = {}
for stage, pref in (('kasuga', 'k'), ('shinjuku', 's')):
    import os.path
    files = sorted(glob.glob(os.path.expanduser(f'~/workspace/.osm-raw/osm-b-{pref}-*.json')))
    if not files: files = sorted(glob.glob(f'/tmp/osm-b-{pref}-*.json'))
    files = [f for f in files if '-q' not in f]
    assert files, stage
    all_tiles[stage] = process(stage, files)

lines = ['// footprints.js — 実建物のフットプリント（生成ファイル, tools/build-footprints.py）',
         '// 形式: { stage: { "tx,tz": [ [x0,z0,x1,z1,...,h,c], ... ] } }  座標はゲーム世界座標(m), 0.5m量子化',
         '// 出典: PLATEAU（国土交通省）CityGML の実測高さ＋輪郭を優先し、欠けを © OpenStreetMap contributors (ODbL) で補完。',
         '// OSMのみの建物の高さはタグ優先、無ければ種別・面積からの推定。',
         'export const FOOTPRINTS = {']
for stage, tiles in all_tiles.items():
    lines.append(f'  {stage}: {{')
    for key in sorted(tiles):
        arr = ','.join('[' + ','.join(str(v) for v in flat) + ']' for flat in tiles[key])
        lines.append(f'    "{key}": [{arr}],')
    lines.append('  },')
lines.append('};')
open('src/footprints.js', 'w').write('\n'.join(lines) + '\n')
import os
print('written src/footprints.js', os.path.getsize('src/footprints.js'), 'bytes')
