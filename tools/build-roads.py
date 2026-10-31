# tools/build-roads.py — Overpassで取得したOSM道路(/tmp/osm-r-*.json)から
# src/roads.js を生成する。区間(セグメント)ごとにタイルへ振り分け、0.5m量子化。
# 幅は highway 種別の標準幅。出典: © OpenStreetMap contributors (ODbL), 取得 2026-10-30
import json, math, glob

MX, MZ, TILE = 90403, 110960, 300
ANCHORS = {'kasuga': ((35.70919, 139.75296), (0, 0)), 'shinjuku': ((35.68950, 139.70049), (60, 420))}
EXCLUDE = {'footway', 'path', 'steps', 'corridor', 'cycleway', 'bridleway', 'construction',
           'proposed', 'raceway', 'bus_guideway', 'elevator', 'platform', 'track'}
WIDTH = {'motorway': 16, 'trunk': 14, 'primary': 13, 'secondary': 11, 'tertiary': 9,
         'unclassified': 7, 'residential': 6.5, 'living_street': 5.5, 'service': 5,
         'pedestrian': 5, 'road': 6, 'motorway_link': 7, 'trunk_link': 7, 'primary_link': 7,
         'secondary_link': 6, 'tertiary_link': 6}

def process(stage, files):
    (alat, alon), (gx, gz) = ANCHORS[stage]
    tiles = {}; seen = set(); ways = 0; segs = 0
    for f in files:
        for e in json.load(open(f))['elements']:
            if e['id'] in seen: continue
            seen.add(e['id'])
            t = e.get('tags', {})
            hw = t.get('highway')
            if hw in EXCLUDE or t.get('tunnel') == 'yes' or t.get('covered') == 'yes': continue
            g = e.get('geometry') or []
            if len(g) < 2: continue
            w = WIDTH.get(hw, 6); ways += 1
            pts = [(gx + (p['lon'] - alon) * MX, gz + (alat - p['lat']) * MZ) for p in g]
            for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
                if math.hypot(x1 - x0, z1 - z0) < 2: continue
                mx, mz = (x0 + x1) / 2, (z0 + z1) / 2
                key = f"{math.floor(mx / TILE)},{math.floor(mz / TILE)}"
                tiles.setdefault(key, []).append([round(x0 * 2) / 2, round(z0 * 2) / 2, round(x1 * 2) / 2, round(z1 * 2) / 2, w])
                segs += 1
    print(stage, 'ways:', ways, 'segments:', segs, 'tiles:', len(tiles))
    return tiles

all_tiles = {}
for stage, pref in (('kasuga', 'k'), ('shinjuku', 's')):
    files = [f for f in sorted(glob.glob(f'/tmp/osm-r-{pref}-*.json')) if '-q' not in f]
    assert files, stage
    all_tiles[stage] = process(stage, files)

lines = ['// roads.js — OSM実道路の区間データ（生成ファイル, tools/build-roads.py）',
         '// 形式: { stage: { "tx,tz": [ [x0,z0,x1,z1,幅m], ... ] } }  © OpenStreetMap contributors (ODbL)',
         'export const ROADS = {']
for stage, tiles in all_tiles.items():
    lines.append(f'  {stage}: {{')
    for key in sorted(tiles):
        arr = ','.join('[' + ','.join(str(v) for v in s) + ']' for s in tiles[key])
        lines.append(f'    "{key}": [{arr}],')
    lines.append('  },')
lines.append('};')
open('src/roads.js', 'w').write('\n'.join(lines) + '\n')
import os
print('written src/roads.js', os.path.getsize('src/roads.js'), 'bytes')
