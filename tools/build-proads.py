# plateau-roads.jsonl（PLATEAU tran抽出）→ src/proads.js（タイル別）
# PROADS = 車道面, PROADS_AUX = 歩道等。形式: { stage: { "tx,tz": [ [x0,z0,...], ... ] } }
import json, math, os

SRC = os.path.expanduser('~/workspace/.osm-raw/plateau-roads.jsonl')
TILE = 300

def simplify(pts):
    out = []
    for p in pts:
        if not out or abs(p[0] - out[-1][0]) > 0.01 or abs(p[1] - out[-1][1]) > 0.01: out.append(p)
    if len(out) > 1 and out[0] == out[-1]: out.pop()
    changed = True
    while changed and len(out) > 3:
        changed = False; nxt = []
        for i, p in enumerate(out):
            a, b = out[i - 1], out[(i + 1) % len(out)]
            cross = abs((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]))
            seg = math.hypot(b[0] - a[0], b[1] - a[1]) or 1
            if cross / seg < 0.3 and len(out) > 3: changed = True; continue
            nxt.append(p)
        out = nxt
    return out

def load(kind):
    stages = {}; seen = set(); total = 0
    if os.path.exists(SRC):
        for line in open(SRC):
            d = json.loads(line)
            if d['k'] != kind: continue
            raw = [tuple(d['pts'][i:i + 2]) for i in range(0, len(d['pts']), 2)]
            def canon(seq):  # 開始点・向きに依らない正規形で重複判定
                rots = [tuple(seq[i:] + seq[:i]) for i in range(len(seq))]
                rev = list(reversed(seq))
                rots += [tuple(rev[i:] + rev[:i]) for i in range(len(rev))]
                return min(rots)
            key = (d['s'], canon(raw))
            if key in seen: continue
            seen.add(key)
            pts = [(d['pts'][i], d['pts'][i + 1]) for i in range(0, len(d['pts']), 2)]
            pts = simplify(pts)
            if len(pts) < 3: continue
            flat = [v for p in pts for v in p]
            cx = sum(d['pts'][0::2]) / (len(d['pts']) // 2); cz = sum(d['pts'][1::2]) / (len(d['pts']) // 2)
            tkey = f"{math.floor(cx / TILE)},{math.floor(cz / TILE)}"
            stages.setdefault(d['s'], {}).setdefault(tkey, []).append(flat)
            total += 1
    return stages, total

def emit(name, stages):
    lines = [f'  {name} = {{']
    lines[0] = f'export const {name} = {{'
    for stage, tiles in stages.items():
        lines.append(f'  {stage}: {{')
        for key in sorted(tiles):
            arr = ','.join('[' + ','.join(str(v) for v in flat) + ']' for flat in tiles[key])
            lines.append(f'    "{key}": [{arr}],')
        lines.append('  },')
    lines.append('};')
    return lines

road, nr = load('road')
aux, na = load('aux')
lines = ['// proads.js — PLATEAU tran から抽出した道路面ポリゴン（生成ファイル, tools/build-proads.py）',
         '// 出典: 3D都市モデル（Project PLATEAU、国土交通省、2025年版）交通モデルを加工して利用',
         *emit('PROADS', road), *emit('PROADS_AUX', aux)]
open('src/proads.js', 'w').write('\n'.join(lines) + '\n')
print('road polys:', nr, 'aux polys:', na, 'written src/proads.js', os.path.getsize('src/proads.js'), 'bytes')
