# PLATEAU CityGML（G空間情報センター）から必要メッシュだけを range 取得し、
# 建物の「実測高さ measuredHeight + lod0FootPrint 輪郭」を抽出して jsonl に保存する。
# 使い方: ~/workspace/.venv/bin/python tools/fetch_plateau.py
import json, math, sys
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
ANCHORS = {'kasuga': (35.70919, 139.75296), 'shinjuku': (35.68950, 139.70049)}
RADIUS_M = 1700.0
OUT = '/home/hatch/workspace/.osm-raw/plateau.jsonl'

def mesh_cell(code):  # 3次メッシュコード → (lat0, lon0, lat1, lon1)
    lat = int(code[0:2]) * (40 / 60) + int(code[4]) * (5 / 60) + int(code[6]) * (30 / 3600)
    lon = 100 + int(code[2:4]) + int(code[5]) * (7.5 / 60) + int(code[7]) * (45 / 3600)
    return lat, lon, lat + 30 / 3600, lon + 45 / 3600

def near_stage(code):
    la0, lo0, la1, lo1 = mesh_cell(code)
    for name, (alat, alon) in ANCHORS.items():
        dlat = max(la0 - alat, 0, alat - la1) * 110960
        dlon = max(lo0 - alon, 0, alon - lo1) * 90403
        if math.hypot(dlat, dlon) < RADIUS_M: return name
    return None

def local(tag): return tag.rsplit('}', 1)[-1]

def parse_gml(stream, stage, out):
    n = 0
    ctx = etree.iterparse(stream, events=('end',))
    for _, el in ctx:
        if local(el.tag) != 'Building': continue
        h = None; ring = None; lod1_rings = []
        for d in el.iter():
            t = local(d.tag)
            if t == 'measuredHeight' and d.text:
                try: h = float(d.text)
                except ValueError: pass
            elif t == 'posList' and d.text:
                pts = [float(v) for v in d.text.split()]
                pairs = [(pts[i], pts[i + 1]) for i in range(0, len(pts) - 1, 3)] if len(pts) % 3 == 0 else [(pts[i], pts[i + 1]) for i in range(0, len(pts) - 1, 2)]
                anc = d
                in_lod0 = in_lod1 = False
                while anc is not None:
                    lt = local(anc.tag)
                    if lt == 'lod0FootPrint': in_lod0 = True
                    if lt == 'lod1Solid': in_lod1 = True
                    anc = anc.getparent()
                if in_lod0 and ring is None: ring = pairs
                elif in_lod1: lod1_rings.append(pairs)
        if ring is None and lod1_rings:
            ring = min(lod1_rings, key=len)  # 底面/屋上リングは最短クラス（壁は4点）— 面積最大の水平リングを優先
            ring = max(lod1_rings, key=lambda r: abs(sum(r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1] for i in range(len(r)))))
        if h and ring and len(ring) >= 3:
            cx = sum(p[1] for p in ring) / len(ring); cy = sum(p[0] for p in ring) / len(ring)
            alat, alon = ANCHORS[stage]
            if math.hypot((cy - alat) * 110960, (cx - alon) * 90403) < RADIUS_M:
                out.write(json.dumps({'s': stage, 'h': round(h * 2) / 2, 'ring': [[round(p[0], 6), round(p[1], 6)] for p in ring]}) + '\n')
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
                    if base.endswith('_bldg_6697_op.gml'):
                        st = near_stage(base[:8])
                        if st: targets.append((name, st))
                print(ward, 'target meshes:', len(targets), flush=True)
                for name, st in targets:
                    with z.open(name) as f:
                        n = parse_gml(f, st, out)
                    total += n
                    print(' ', name.split('/')[-1], n, 'buildings', flush=True)
    print('TOTAL', total)

if __name__ == '__main__':
    main()
