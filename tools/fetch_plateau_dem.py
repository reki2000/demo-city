# PLATEAU 地形モデル（dem, TIN 三角形）からステージ円盤内の標高を集め、
# 10m グリッド（[-1700,1700]^2, 標高×2 の Int16 を base64）にラスタライズして保存する。
# dem GML は非圧縮で数百MB〜1GB あるため、正規表現で posList を C 速度で走査し、
# 円盤バウンディングボックス内の三角形だけ float 化する。
# 使い方: ~/workspace/.venv/bin/python tools/fetch_plateau_dem.py
import base64, json, math, re, sys
from remotezip import RemoteZip

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
MX, MZ = 90403.0, 110960.0
E, STEP = 1700.0, 10.0
N = int(2 * E / STEP) + 1  # 341
OUT = '/home/hatch/workspace/.osm-raw/plateau-dem.json'
POS = re.compile(rb'<gml:posList>([^<]+)</gml:posList>')

# ステージごとの緯度経度バウンディングボックス（三角形の取りこぼし防止に 30m 拡大）
BBOX = {}
for st, (alat, alon) in ANCHORS.items():
    dlat = (E + 30) / MZ; dlon = (E + 30) / MX
    BBOX[st] = (alat - dlat, alon - dlon, alat + dlat, alon + dlon)

acc = {st: [[0.0] * (N * N), [0] * (N * N)] for st in ANCHORS}  # 合計, 個数

def splat(st, lat, lon, z):
    alat, alon = ANCHORS[st]
    x = (lon - alon) * MX; zz = (alat - lat) * MZ
    gx = int(round((x + E) / STEP)); gz = int(round((zz + E) / STEP))
    if 0 <= gx < N and 0 <= gz < N:
        s, c = acc[st]
        i = gz * N + gx
        s[i] += z; c[i] += 1

def scan(stream, ward):
    buf = b''
    kept = 0
    while True:
        chunk = stream.read(1 << 22)
        if not chunk: break
        buf += chunk
        last = 0
        for m in POS.finditer(buf):
            txt = m.group(1)
            last = m.end()
            # 最初の頂点で粗くフィルタ（三角形は最大でも十数m）
            head = txt.split(None, 2)
            if len(head) < 2: continue
            try: la0 = float(head[0]); lo0 = float(head[1])
            except ValueError: continue
            for st, (la_min, lo_min, la_max, lo_max) in BBOX.items():
                if la_min <= la0 <= la_max and lo_min <= lo0 <= lo_max:
                    v = txt.split()
                    if len(v) < 9: break
                    try: nums = [float(t) for t in v]
                    except ValueError: break
                    for k in range(0, min(len(nums) - 2, 9), 3):  # 閉じた三角形の3頂点
                        splat(st, nums[k], nums[k + 1], nums[k + 2])
                    kept += 1
                    break
        buf = buf[last:] if last else buf[-4096:]
    return kept

def fill_and_pack(st):
    s, c = acc[st]
    grid = [None] * (N * N)
    for i in range(N * N):
        if c[i]: grid[i] = s[i] / c[i]
    # 穴埋め: 隣接セルの平均で拡散（区境界・水面などで欠けたセル）
    for _ in range(400):
        missing = 0
        new = grid[:]
        for gz in range(N):
            for gx in range(N):
                i = gz * N + gx
                if grid[i] is not None: continue
                vals = []
                for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, nz = gx + dx, gz + dz
                    if 0 <= nx < N and 0 <= nz < N and grid[nz * N + nx] is not None: vals.append(grid[nz * N + nx])
                if vals: new[i] = sum(vals) / len(vals)
                else: missing += 1
        grid = new
        if missing == 0: break
    vals = [g for g in grid if g is not None]
    print(st, 'filled cells:', len(vals), '/', N * N, 'elev min/max:', round(min(vals), 1), round(max(vals), 1), flush=True)
    pack = bytearray()
    for g in grid:
        v = int(round((g or 0) * 2))
        pack += v.to_bytes(2, 'little', signed=True)
    return base64.b64encode(bytes(pack)).decode()

def main():
    total = 0
    for ward, url in WARDS.items():
        with RemoteZip(url) as z:
            dems = [n for n in z.namelist() if '/dem/' in n and n.endswith('.gml')]
            for name in dems:
                with z.open(name) as f:
                    kept = scan(f, ward)
                total += kept
                print(ward, name.split('/')[-1], 'triangles in bbox:', kept, flush=True)
    out = {st: fill_and_pack(st) for st in ANCHORS}
    with open(OUT, 'w') as f: json.dump({'n': N, 'step': STEP, 'e': E, 'stages': out}, f)
    print('TOTAL triangles', total, '->', OUT)

if __name__ == '__main__':
    main()
