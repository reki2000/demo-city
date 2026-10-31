# plateau-roofs.jsonl（PLATEAU LOD2抽出）→ src/rooftops.js（タイル別）
# 形式: { stage: { "tx,tz": [ [x0,z0,...,top,base], ... ] } } ゲーム座標・0.5m量子化
import json, math, os

SRC = os.path.expanduser('~/workspace/.osm-raw/plateau-roofs.jsonl')
TILE = 300
stages = {}
seen = set(); total = 0
if os.path.exists(SRC):
    for line in open(SRC):
        d = json.loads(line)
        key = (d['s'], d['pts'][0], d['pts'][1], d['top'], d['base'], len(d['pts']))
        if key in seen: continue
        seen.add(key)
        cx = sum(d['pts'][0::2]) / (len(d['pts']) // 2); cz = sum(d['pts'][1::2]) / (len(d['pts']) // 2)
        tkey = f"{math.floor(cx / TILE)},{math.floor(cz / TILE)}"
        stages.setdefault(d['s'], {}).setdefault(tkey, []).append(d['pts'] + [d['top'], d['base']])
        total += 1
lines = ['// rooftops.js — PLATEAU LOD2 から抽出した実在の屋上構造物（生成ファイル, tools/build-rooftops.py）',
         '// 形式: { stage: { "tx,tz": [ [x0,z0,...,top,base], ... ] } } 座標はゲーム世界座標(m)',
         '// 出典: 3D都市モデル（Project PLATEAU、国土交通省、文京区・新宿区2025年版）LOD2を加工して利用',
         'export const ROOFTOPS = {']
for stage, tiles in stages.items():
    lines.append(f'  {stage}: {{')
    for key in sorted(tiles):
        arr = ','.join('[' + ','.join(str(v) for v in flat) + ']' for flat in tiles[key])
        lines.append(f'    "{key}": [{arr}],')
    lines.append('  },')
lines.append('};')
open('src/rooftops.js', 'w').write('\n'.join(lines) + '\n')
print('rooftops:', total, 'written src/rooftops.js', os.path.getsize('src/rooftops.js'), 'bytes')
