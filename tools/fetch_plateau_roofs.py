# PLATEAU CityGML の lod2Solid から「屋上構造物」を抽出する。
# LOD1屋根面（measuredHeight）より上に突き出た LOD2 ポリゴン群を平面投影し、
# 連結成分ごとに輪郭化して plateau-roofs.jsonl に保存（ゲーム座標, 0.5m量子化）。
# 使い方: ~/workspace/.venv/bin/python tools/fetch_plateau_roofs.py
import json, math
from remotezip import RemoteZip
from lxml import etree
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union

WARDS = {
    'bunkyo': "https://assets.cms.plateau.reearth.io/assets/b1/ea0dc7-342c-4814-b3ff-b2c162e44457/13105_bunkyo-ku_pref_2025_citygml_1_op.zip",
    'shinjuku': "https://assets.cms.plateau.reearth.io/assets/db/2866b9-e3c2-4bc4-83d3-b7b42e9b85a1/13104_shinjuku-ku_pref_2025_citygml_1_op.zip",
    'chiyoda': "https://assets.cms.plateau.reearth.io/assets/d1/e11ec4-3ad6-4923-a441-32cbd7455dee/13101_chiyoda-ku_pref_2025_citygml_1_op.zip",
    'taito': "https://assets.cms.plateau.reearth.io/assets/80/45b2b1-5a88-40ab-9877-70b540b8707e/13106_taito-ku_city_2025_citygml_1_op.zip",
    'toshima': "https://assets.cms.plateau.reearth.io/assets/32/d726d2-f749-431e-9c0e-f7f9fad2cd3a/13116_toshima-ku_pref_2025_citygml_1_op.zip",
    'shibuya': "https://assets.cms.plateau.reearth.io/assets/48/e684f3-fb86-44d4-b7e3-a3d72d54582d/13113_shibuya-ku_pref_2025_citygml_1_op.zip",
    'nakano': "https://assets.cms.plateau.reearth.io/assets/e2/9434f5-c5ca-479e-b953-e2c27df299d1/13114_nakano-ku_pref_2025_citygml_1_op.zip",
}
ANCHORS = {'kasuga': ((35.70919, 139.75296), (0, 0)), 'shinjuku': ((35.68950, 139.70049), (60, 420))}
MX, MZ = 90403, 110960
RADIUS_M = 1700.0
OUT = '/home/hatch/workspace/.osm-raw/plateau-roofs.jsonl'

def mesh_cell(code):
    lat = int(code[0:2]) * (40 / 60) + int(code[4]) * (5 / 60) + int(code[6]) * (30 / 3600)
    lon = 100 + int(code[2:4]) + int(code[5]) * (7.5 / 60) + int(code[7]) * (45 / 3600)
    return lat, lon, lat + 30 / 3600, lon + 45 / 3600

def near_stage(code):
    la0, lo0, la1, lo1 = mesh_cell(code)
    for name, ((alat, alon), _) in ANCHORS.items():
        dlat = max(la0 - alat, 0, alat - la1) * 110960
        dlon = max(lo0 - alon, 0, alon - lo1) * 90403
        if math.hypot(dlat, dlon) < RADIUS_M: return name
    return None

def local(tag): return tag.rsplit('}', 1)[-1]

def parse_gml(stream, stage, out):
    (alat, alon), (gx, gz) = ANCHORS[stage]
    def conv(la, lo): return (gx + (lo - alon) * MX, gz + (alat - la) * MZ)
    n = nb = 0
    ctx = etree.iterparse(stream, events=('end',))
    for _, el in ctx:
        if local(el.tag) != 'Building': continue
        mainH = None; polys = []; g0 = None; insts = []
        for inst in el.iter():
            if local(inst.tag) == 'BuildingInstallation':
                rings = []
                for d in inst.iter():
                    if local(d.tag) == 'posList' and d.text:
                        v = [float(x) for x in d.text.split()]
                        if len(v) >= 9 and len(v) % 3 == 0:
                            rings.append([(v[i], v[i + 1], v[i + 2]) for i in range(0, len(v), 3)])
                if rings: insts.append(rings)
        for d in el.iter():
            t = local(d.tag)
            if t == 'measuredHeight' and d.text:
                try: mainH = float(d.text)
                except ValueError: pass
            elif t == 'posList' and d.text:
                v = [float(x) for x in d.text.split()]
                if len(v) < 9 or len(v) % 3 != 0: continue
                ring = [(v[i], v[i + 1], v[i + 2]) for i in range(0, len(v), 3)]
                anc = d; in2 = False; in_inst = False; in_lod1 = False
                while anc is not None:
                    lt = local(anc.tag)
                    if lt == 'BuildingInstallation': in_inst = True; break
                    if lt == 'lod1Solid': in_lod1 = True; break
                    if lt.startswith('lod2'): in2 = True; break  # LOD2実体は lod2MultiSurface 等の下にある
                    anc = anc.getparent()
                if in_lod1:  # 標高系ファイルの基準は LOD1ソリッドの底（lod0は z=0 のことがあり基準にならない）
                    zmin = min(p[2] for p in ring)
                    if g0 is None or zmin < g0: g0 = zmin
                if in2 and not in_inst: polys.append(ring)
        if mainH and polys:
            nb += 1
            # LOD2の高さ基準は製造元で異なる（LOD1と同じ標高系 / 地面基準の相対系）。
            # 候補2通りで主屋根レベルを求め、measuredHeight に整合する方を採用する。
            def levels_for(g0c):
                lv_map = {}
                for ring in polys:
                    hs = [p[2] for p in ring]
                    if max(hs) - min(hs) < 0.3:
                        pts2 = [conv(p[0], p[1]) for p in ring]
                        area = abs(sum(pts2[i][0] * pts2[(i + 1) % len(pts2)][1] - pts2[(i + 1) % len(pts2)][0] * pts2[i][1] for i in range(len(pts2)))) / 2
                        lv = round((sum(hs) / len(hs)) * 2) / 2
                        if lv > g0c + 0.5: lv_map[lv] = lv_map.get(lv, 0) + area
                if not lv_map: return None
                mr = max(lv_map, key=lambda k: lv_map[k])
                return mr - g0c, mr
            cands = []
            for g0c in ({g0, 0.0} if g0 is not None else {0.0}):
                r = levels_for(g0c)
                if r and mainH - 18 <= r[0] <= mainH + 1: cands.append((abs(mainH - r[0]), g0c, r[1]))
            baseRel = None; mainRoof = None
            if cands:
                cands.sort()
                _, g0, mainRoof = cands[0]
                baseRel = mainRoof - g0
            if g0 is None: g0 = 0.0
            if mainRoof is not None:
                projs = []; tops = []
                for ring in polys:
                    if max(p[2] for p in ring) < mainRoof + 0.7: continue
                    pts2 = [conv(p[0], p[1]) for p in ring]
                    cx = sum(p[0] for p in pts2) / len(pts2); cz = sum(p[1] for p in pts2) / len(pts2)
                    if math.hypot(cx - gx, cz - gz) > 1750: continue
                    try: poly = Polygon(pts2)
                    except Exception: continue
                    if not poly.is_valid: poly = poly.buffer(0)
                    if poly.area < 0.05: poly = poly.buffer(0.35)  # 壁面の投影は細線 → 帯にする
                    if poly.area >= 0.05: projs.append(poly); tops.append(max(p[2] for p in ring) - g0)
                if projs:
                    u = unary_union(projs)
                    comps = list(u.geoms) if isinstance(u, MultiPolygon) else [u]
                    props = []
                    for comp in comps:
                        if comp.area < 2.5: continue
                        top = max(t for p, t in zip(projs, tops) if p.intersects(comp))
                        if top < mainH + 0.3 or top > mainH + 20: continue  # LOD1角柱より上に出るものだけ
                        simp = comp.simplify(0.5)
                        ring = list(simp.exterior.coords)
                        if len(ring) < 4: continue
                        flat = []
                        for x, z in ring[:-1]: flat += [round(x * 2) / 2, round(z * 2) / 2]
                        if len(flat) >= 6: props.append((comp.area, flat, round(top * 2) / 2))
                    props.sort(reverse=True)
                    for _, flat, top in props[:4]:
                        out.write(json.dumps({'s': stage, 'pts': flat, 'top': top, 'base': round(baseRel * 2) / 2}) + '\n')
                        n += 1
            # BuildingInstallation（屋外設置物）= PLATEAUが明示モデル化した屋上設備など
            roofRef = baseRel if baseRel is not None else mainH - 3
            cand = []
            for rings in insts:
                zs = [p[2] for r in rings for p in r]
                bRel = min(zs) - g0; tRel = max(zs) - g0
                if bRel < roofRef - 2.5 or tRel - bRel < 0.4 or tRel > mainH + 20: continue
                projs = []
                for r in rings:
                    pts2 = [conv(p[0], p[1]) for p in r]
                    try: poly = Polygon(pts2)
                    except Exception: continue
                    if not poly.is_valid: poly = poly.buffer(0)
                    if poly.area < 0.05: poly = poly.buffer(0.3)
                    if poly.area >= 0.05: projs.append(poly)
                if not projs: continue
                u = unary_union(projs)
                comps = list(u.geoms) if isinstance(u, MultiPolygon) else [u]
                for comp in comps:
                    if comp.area < 1.5: continue
                    ccx, ccz = comp.centroid.x, comp.centroid.y
                    if math.hypot(ccx - gx, ccz - gz) > 1750: continue
                    simp = comp.simplify(0.4)
                    ring = list(simp.exterior.coords)
                    if len(ring) < 4: continue
                    flat = []
                    for x, z in ring[:-1]: flat += [round(x * 2) / 2, round(z * 2) / 2]
                    if len(flat) >= 6: cand.append((comp.area, flat, round(tRel * 2) / 2, round(bRel * 2) / 2))
            cand.sort(reverse=True)
            for _, flat, top, base in cand[:6]:
                out.write(json.dumps({'s': stage, 'pts': flat, 'top': top, 'base': base}) + '\n')
                n += 1
        el.clear()
        while el.getprevious() is not None: del el.getparent()[0]
    return n, nb

def main():
    total = 0
    with open(OUT, 'w') as out:
        for ward, url in WARDS.items():
            with RemoteZip(url) as z:
                targets = []
                for name in z.namelist():
                    base = name.split('/')[-1]
                    if base.endswith('_bldg_6697_op.gml'):
                        st = near_stage(base[:8])
                        if st: targets.append((name, st))
                print(ward, 'meshes:', len(targets), flush=True)
                for name, st in targets:
                    with z.open(name) as f:
                        n, nb = parse_gml(f, st, out)
                    total += n
                    print(' ', name.split('/')[-1], 'props:', n, 'lod2 buildings:', nb, flush=True)
    print('TOTAL PROPS', total)

if __name__ == '__main__':
    main()
