# PLATEAU CityGML の tran（道路）から TrafficArea（車道面）/ AuxiliaryTrafficArea（歩道等）の
# ポリゴンを抽出して plateau-roads.jsonl に保存（ゲーム座標, 0.5m量子化）。
# 使い方: ~/workspace/.venv/bin/python tools/fetch_plateau_roads.py
import json, math
from remotezip import RemoteZip
from lxml import etree

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
OUT = '/home/hatch/workspace/.osm-raw/plateau-roads.jsonl'

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

def parse_gml(stream, stage, kind, out):
    (alat, alon), (gx, gz) = ANCHORS[stage]
    n = 0
    # road: TrafficArea(LOD2) が無いメッシュでは Road直下の lod0/lod1MultiSurface(LOD1) を使う
    targets = ('TrafficArea', 'Road') if kind == 'road' else ('AuxiliaryTrafficArea',)
    ctx = etree.iterparse(stream, events=('end',))
    for _, el in ctx:
        if local(el.tag) not in targets: continue
        is_road_el = local(el.tag) == 'Road'
        for d in el.iter():
            if local(d.tag) != 'posList' or not d.text: continue
            if is_road_el:
                anc = d; ok = False
                while anc is not None and anc is not el:
                    lt = local(anc.tag)
                    if lt in ('TrafficArea', 'AuxiliaryTrafficArea'): ok = False; break
                    if lt in ('lod0MultiSurface', 'lod1MultiSurface'): ok = True
                    anc = anc.getparent()
                if not ok: continue
            v = [float(x) for x in d.text.split()]
            if len(v) % 3 == 0: pairs = [(v[i], v[i + 1]) for i in range(0, len(v), 3)]
            else: pairs = [(v[i], v[i + 1]) for i in range(0, len(v) - 1, 2)]
            pts = [(gx + (lo - alon) * MX, gz + (alat - la) * MZ) for la, lo in pairs]
            if len(pts) > 1 and pts[0] == pts[-1]: pts.pop()
            if len(pts) < 3: continue
            cx = sum(p[0] for p in pts) / len(pts); cz = sum(p[1] for p in pts) / len(pts)
            if math.hypot(cx, cz) > 1750: continue
            flat = []
            for x, z in pts: flat += [round(x * 2) / 2, round(z * 2) / 2]
            out.write(json.dumps({'s': stage, 'k': kind, 'pts': flat}) + '\n')
            n += 1
        el.clear()
        while el.getprevious() is not None: del el.getparent()[0]
    return n

def main():
    total = 0
    with open(OUT, 'w') as out:
        for ward, url in WARDS.items():
            with RemoteZip(url) as z:
                targets = []
                for name in z.namelist():
                    base = name.split('/')[-1]
                    if base.endswith('_tran_6697_op.gml'):
                        st = near_stage(base[:8])
                        if st: targets.append((name, st))
                print(ward, 'tran meshes:', len(targets), flush=True)
                for name, st in targets:
                    for kind in ('road', 'aux'):
                        with z.open(name) as f:
                            total += parse_gml(f, st, kind, out)
                    print(' ', name.split('/')[-1], 'cumulative:', total, flush=True)
    print('TOTAL ROAD POLYS', total)

if __name__ == '__main__':
    main()
