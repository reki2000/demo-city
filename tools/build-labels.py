# tools/build-labels.py — Overpassで取得したOSM実データ(/tmp/osm-*.json)から
# src/labels.js (ステージ別) を生成する。各ステージの基点駅を原点に実距離(m)で変換。
# 出典: © OpenStreetMap contributors (ODbL) — 取得 2026-10-29/30, overpass-api.de
import json, collections

MX = 90403   # 緯度35.7°付近での経度1°あたりのm
MZ = 110960  # 緯度1°あたりのm

def build(name, anchor_latlon, game_anchor, stations_f, signals_f, ways_f,
          station_names, crossing_names, street_names):
    alat, alon = anchor_latlon; gx, gz = game_anchor
    def conv(lat, lon):
        return (round(gx + (lon - alon) * MX), round(gz + (alat - lat) * MZ))
    out = []
    byname = collections.defaultdict(list)
    for e in json.load(open(stations_f))['elements']:
        n = e.get('tags', {}).get('name')
        if n in station_names and 'lat' in e: byname[n].append((e['lat'], e['lon']))
    for n in station_names:
        pts = byname[n]; assert pts, (name, n)
        la = sum(p[0] for p in pts) / len(pts); lo = sum(p[1] for p in pts) / len(pts)
        x, z = conv(la, lo); out.append(('station', n, x, z))
    seen = {}
    for e in json.load(open(signals_f))['elements']:
        n = e.get('tags', {}).get('name')
        if n in crossing_names and n not in seen: seen[n] = (e['lat'], e['lon'])
    for n in crossing_names:
        assert n in seen, (name, n)
        x, z = conv(*seen[n]); out.append(('crossing', n, x, z))
    ways = json.load(open(ways_f))['elements']
    for nm in street_names:
        best = None
        for e in ways:
            if e.get('tags', {}).get('name') != nm: continue
            for p in e.get('geometry') or []:
                d = (p['lat'] - alat) ** 2 + (p['lon'] - alon) ** 2
                if best is None or d < best[0]: best = (d, p['lat'], p['lon'])
        assert best, (name, nm)
        x, z = conv(best[1], best[2]); out.append(('street', nm, x, z))
    print(name, len(out), 'labels')
    return out

import os, re
STAGES = {}
if not os.path.exists('/tmp/osm-stations.json'):
    # 原データが無い場合は既存 labels.js の新宿分をそのまま引き継ぐ
    prev = open('src/labels.js').read()
    STAGES['shinjuku'] = [(m.group(1), m.group(2), int(m.group(3)), int(m.group(4)))
                          for m in re.finditer(r"\{ kind: '(\w+)', name: '([^']+)', x: (-?\d+), z: (-?\d+) \}", prev)]
    print('shinjuku carried over:', len(STAGES['shinjuku']))
else:
  STAGES['shinjuku'] = build(
    'shinjuku', (35.68950, 139.70049), (60, 420),
    '/tmp/osm-stations.json', '/tmp/osm-signals.json', '/tmp/osm-ways.json',
    ['西武新宿', '新宿西口', '新線新宿', '南新宿', '代々木', '北参道', '新宿三丁目',
     '新宿御苑前', '東新宿', '西新宿', '都庁前', '西新宿五丁目', '初台', '参宮橋',
     '千駄ケ谷', '国立競技場', '大久保', '新大久保'],
    ['西新宿', '新宿三丁目', '歌舞伎町', '新宿駅東口', '新宿駅南口', '都庁北', '都庁南',
     '北参道', '参宮橋', '新宿五丁目', '新宿六丁目', '熊野神社前', '成子坂下', '初台坂下'],
    ['甲州街道', '靖国通り', '青梅街道', '明治通り', '新宿通り', '職安通り', '大久保通り',
     '山手通り', '都庁通り', '小滝橋通り', '外苑西通り', '首都高速4号新宿線', '十二社通り', '御苑通り'])
STAGES['kasuga'] = build(
    'kasuga', (35.70919, 139.75296), (0, 0),
    '/tmp/osm-k-stations.json', '/tmp/osm-k-signals.json', '/tmp/osm-k-ways.json',
    ['後楽園', '水道橋', '本郷三丁目', '白山', '神保町', '飯田橋', '茗荷谷', '東大前', '根津', '九段下'],
    ['春日町', '後楽園駅', '富坂上', '富坂下', '壱岐坂下', '小石川後楽園入口', '水道橋',
     '飯田橋', '白山下', '西片', 'こんにゃくえんま前', '大曲'],
    ['春日通り', '白山通り', '外堀通り', '本郷通り', '不忍通り', '言問通り'])

lines = ['// labels.js — OpenStreetMap実データの地名ラベル（生成ファイル, tools/build-labels.py）',
         '// 出典: © OpenStreetMap contributors (ODbL), Overpass API 取得 2026-10-29/30',
         '// 座標: 各ステージの基点駅を原点に実距離で変換したゲーム座標 (x:東+, z:南+)',
         'export const LABELS_BY_STAGE = {']
for stage, labels in STAGES.items():
    lines.append(f'  {stage}: [')
    for kind, nm, x, z in labels:
        lines.append(f"    {{ kind: '{kind}', name: '{nm}', x: {x}, z: {z} }},")
    lines.append('  ],')
lines.append('};')
lines.append('export const LABELS = LABELS_BY_STAGE.shinjuku;')
open('src/labels.js', 'w').write('\n'.join(lines) + '\n')
print('written src/labels.js')
