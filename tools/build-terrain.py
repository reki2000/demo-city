# plateau-dem.json（標高グリッド）→ src/terrain.js
import json
SRC = '/home/hatch/workspace/.osm-raw/plateau-dem.json'
OUT = '/home/hatch/workspace/tokyo-swing/src/terrain.js'
d = json.load(open(SRC))
lines = ['// terrain.js — PLATEAU地形モデル(dem TIN)を10mグリッド化した標高データ。',
         '// 値は Int16(標高×2) を base64 化したもの。範囲は各ステージ中心 ±1700m。',
         f"export const TERRAIN_N = {d['n']}, TERRAIN_STEP = {d['step']}, TERRAIN_E = {d['e']};",
         'export const TERRAIN_DATA = {']
for st, b64 in d['stages'].items():
    lines.append(f"  {st}: '{b64}',")
lines.append('};')
open(OUT, 'w').write('\n'.join(lines) + '\n')
print('written', OUT)
